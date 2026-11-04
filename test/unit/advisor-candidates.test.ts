import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureDryRuns } from '../../src/advisor/measure';
import { readAdvisor } from '../../src/advisor/read';
import type { AdvisorData } from '../../src/advisor/model';
import { accessOf, editMetadata, rows } from './advisor-support';
import { lakeBackends } from './lake-backends';
import type { BackendLake } from './lake-backends';

const backends = await lakeBackends();

async function read(lake: BackendLake): Promise<AdvisorData> {
  const reader = await lake.reader();
  try {
    return await readAdvisor({ reader, access: accessOf(lake) }, 'Lake', new Date());
  } finally {
    await reader.close();
  }
}

describe.each(backends)(
  'the candidates of the Maintenance Advisor on a lake with $name metadata',
  (backend) => {
    describe.skipIf(backend.skipReason !== undefined)('read from the catalog', () => {
      let lake: BackendLake;

      const sql = (text: string): Promise<unknown> => lake.connection.run(text);
      const set = (name: string, value: string): Promise<unknown> =>
        sql(`CALL lake.set_option('${name}', '${value}')`);
      const sizeOf = async (table: string): Promise<number> =>
        (await rows(lake, `SELECT data_file FROM ducklake_list_files('lake', '${table}')`)).reduce(
          (sum, [path]) => sum + statSync(String(path)).size,
          0,
        );
      const listed = (data: AdvisorData): string[] => data.rewrite.map(({ table }) => table.name);

      beforeAll(async () => {
        lake = await backend.create();
        // In the order of the table ids: the tables with the same number of files are listed in this order.
        for (const [name, rowCount, deleted] of [
          ['lost_40', 100, 40],
          ['exactly_half', 100, 50],
          ['exactly_half_too', 100, 50],
          ['fifty_five', 100, 55],
          ['almost_57', 10_000, 5699],
          ['ten_thousand', 10_000, 9549],
        ] as const) {
          await sql(`CREATE TABLE ${name}(id INTEGER)`);
          await sql(`INSERT INTO ${name} SELECT range FROM range(${rowCount})`);
          await sql(`DELETE FROM ${name} WHERE id < ${deleted}`);
        }
        await sql('CREATE TABLE two_files(id INTEGER)');
        await sql('INSERT INTO two_files SELECT range FROM range(100)');
        await sql('INSERT INTO two_files SELECT range + 100 FROM range(100)');
        await sql('DELETE FROM two_files WHERE id % 100 < 60');
        // Metadata that other writers produce: a delete file that a later one replaced, a data file that a later
        // snapshot ended, and a data file that has no rows.
        for (const name of ['replaced_delete', 'ended_file', 'no_rows']) {
          await sql(`CREATE TABLE ${name}(id INTEGER)`);
          await sql(`INSERT INTO ${name} SELECT range FROM range(100)`);
          await sql(`DELETE FROM ${name} WHERE id < 80`);
        }
        await sql('CREATE TABLE tiny(id INTEGER)');
        for (let part = 0; part < 6; part++) {
          await sql(`INSERT INTO tiny SELECT range + ${part * 10} FROM range(10)`);
        }
        const tableOf = (name: string): string =>
          `(SELECT table_id FROM meta.ducklake_table WHERE table_name = '${name}')`;
        await editMetadata(lake, [
          `UPDATE meta.ducklake_delete_file SET end_snapshot = 1 WHERE table_id = ${tableOf('replaced_delete')}`,
          `UPDATE meta.ducklake_data_file SET end_snapshot = 1 WHERE table_id = ${tableOf('ended_file')}`,
          `UPDATE meta.ducklake_data_file SET record_count = 0 WHERE table_id = ${tableOf('no_rows')}`,
        ]);
      }, 180_000);

      afterAll(() => lake?.remove());

      it('lists the tables with files that lost half their rows with exact sizes, and moves the threshold to the basis point and below half as DuckLake rewrites', async () => {
        const data = await read(lake);

        expect(
          data.rewrite.map(({ table, files, atThreshold, records, deleted }) => [
            table.name,
            files,
            atThreshold,
            records,
            deleted,
          ]),
        ).toEqual([
          ['two_files', 2, 0, 200, 120],
          ['exactly_half', 1, 0, 100, 50],
          ['exactly_half_too', 1, 0, 100, 50],
          ['fifty_five', 1, 0, 100, 55],
          ['almost_57', 1, 0, 10_000, 5699],
          ['ten_thousand', 1, 1, 10_000, 9549],
        ]);
        expect(data.rewrite.map(({ sizeBytes }) => sizeBytes)).toEqual([
          await sizeOf('two_files'),
          await sizeOf('exactly_half'),
          await sizeOf('exactly_half_too'),
          await sizeOf('fifty_five'),
          await sizeOf('almost_57'),
          await sizeOf('ten_thousand'),
        ]);

        // A file is past the threshold only when the share of its deleted rows reaches it, to the basis point.
        await set('rewrite_delete_threshold', '0.57');
        const strict = await read(lake);
        // 5,699 of 10,000 rows are deleted: 56.99 %, short of 57 %, as DuckLake sees it (0.57 * 10000 is 5699.999...).
        expect(strict.rewrite.find(({ table }) => table.name === 'almost_57')).toMatchObject({
          atThreshold: 0,
        });
        const none = await lake.connection.runAndReadAll(
          "CALL ducklake_rewrite_data_files('lake', 'almost_57')",
        );
        expect(none.getRowsJson()).toEqual([]);

        // With a threshold below half the same files are listed as the rewrite of DuckLake rewrites them.
        await set('rewrite_delete_threshold', '0.3');
        const loose = await read(lake);
        expect(loose.policy.rewrite).toEqual({ share: 0.3, source: 'option' });
        expect(listed(loose)).toContain('lost_40');
        const reached = loose.rewrite
          .filter(({ atThreshold }) => atThreshold > 0)
          .map(({ table }) => table.name);
        const rewritten = (await lake.connection.runAndReadAll("CALL ducklake_rewrite_data_files('lake')"))
          .getRowsJson()
          .flatMap((row) => (typeof row[1] === 'string' ? [row[1]] : []));
        expect(reached.toSorted()).toEqual(rewritten.toSorted());
        expect(rewritten).toContain('lost_40');
      });
    });
  },
);

describe.each(backends)(
  'the Maintenance Advisor on a lake whose catalog names foreign files, $name metadata',
  (backend) => {
    describe.skipIf(backend.skipReason !== undefined)('measured with the dry runs', () => {
      let lake: BackendLake;
      let probe: Server;
      let requests: string[];
      let outside: string;
      let inside: string;

      beforeAll(async () => {
        lake = await backend.create();
        await lake.connection.run('CREATE TABLE t(id INTEGER)');
        await lake.connection.run('INSERT INTO t SELECT range FROM range(10)');
        requests = [];
        probe = createServer((request, response) => {
          requests.push(`${request.method} ${request.url}`);
          response.setHeader('content-length', '5');
          response.end(request.method === 'HEAD' ? undefined : 'hello');
        });
        await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
        const { port } = probe.address() as AddressInfo;
        // A file of the lake, one outside it that a path with `..` reaches, and a URL.
        inside = `${lake.dataDirectory}/main/t/scheduled.parquet`;
        outside = `${lake.dataDirectory}/../outside.parquet`;
        mkdirSync(`${lake.dataDirectory}/main/t`, { recursive: true });
        writeFileSync(inside, 'i'.repeat(111));
        writeFileSync(outside, 'o'.repeat(222));
        // A file that the pattern of a name which is gone would match if it were a pattern.
        writeFileSync(`${lake.dataDirectory}/main/t/gone1.parquet`, 'l'.repeat(33));
        const schedule = (id: number, path: string): string =>
          `INSERT INTO meta.ducklake_files_scheduled_for_deletion (data_file_id, path, path_is_relative, schedule_start) VALUES (${id}, '${path}', false, now() - INTERVAL 10 DAY)`;
        await editMetadata(lake, [
          schedule(9001, inside),
          schedule(9002, `http://127.0.0.1:${port}/probe.parquet`),
          schedule(9003, outside),
          schedule(9004, `${lake.dataDirectory}/main/t/gone[1].parquet`),
        ]);
      }, 60_000);

      afterAll(async () => {
        await new Promise<void>((resolve) => (probe ? probe.close(() => resolve()) : resolve()));
        await lake?.remove();
        rmSync(outside, { force: true });
      });

      it('lists every file the cleanup would delete, but looks up the size only of those below the data path', async () => {
        const data = await read(lake);

        expect(data.cleanup).toEqual({ state: 'measured', value: { files: 4, bytes: 111, sized: 1 } });
        expect(requests).toEqual([]);
      });
    });
  },
);

describe.each(backends)(
  'the dry runs of the Maintenance Advisor on a lake with $name metadata',
  (backend) => {
    describe.skipIf(backend.skipReason !== undefined)('measured on a store with many files', () => {
      let lake: BackendLake;
      const old = new Date(Date.now() - 20 * 86_400_000);

      /** Writes orphans of `name`, `size` bytes each, old enough for the cleanup; returns the bytes. */
      function orphans(names: readonly string[], size: (index: number) => number): number {
        mkdirSync(`${lake.dataDirectory}/bulk`, { recursive: true });
        return names.reduce((sum, name, index) => {
          const path = `${lake.dataDirectory}/${name}`;
          writeFileSync(path, 'x'.repeat(size(index)));
          utimesSync(path, old, old);
          return sum + size(index);
        }, 0);
      }

      beforeAll(async () => {
        lake = await backend.create();
        await lake.connection.run('CREATE TABLE t(id INTEGER)');
      }, 60_000);

      afterAll(() => lake?.remove());

      it('sizes every orphan, also glob characters in several batches, at most 1,000 files, and does not let the policy age leave its interval', async () => {
        const names = [
          'a[1].parquet',
          ...Array.from({ length: 300 }, (_, index) => `bulk/f${index}.parquet`),
        ];
        const bytes = orphans(names, (index) => 10 + (index % 7));

        const data = await read(lake);

        expect(data.orphans).toEqual({ state: 'measured', value: { files: 301, bytes, sized: 301 } });

        orphans(
          Array.from({ length: 900 }, (_, index) => `bulk/more${index}.parquet`),
          () => 5,
        );
        const capped = await read(lake);
        expect(capped.orphans).toMatchObject({ state: 'measured', value: { files: 1201, sized: 1000 } });

        const reader = await lake.reader();
        try {
          const base = await readAdvisor({ reader, access: accessOf(lake) }, 'Lake', new Date());
          const policy = {
            ...base.policy,
            expire: { text: "1 day' AS INTERVAL) - CAST('0 days", source: 'option' as const },
          };
          const measured = await measureDryRuns(accessOf(lake), policy, 1, null);

          expect(measured.expiry.state).toBe('skipped');
          expect(measured.orphans.state).toBe('measured');
        } finally {
          await reader.close();
        }
      });
    });
  },
);
