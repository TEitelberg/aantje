import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { info, metadata } from '../../src/catalog/queries/objects';
import { createCatalogReader } from '../../src/catalog/reader';
import { AantjeError } from '../../src/errors';
import type { HealthEvent } from '../../src/health/model';
import { CHECKS } from '../../src/health/model';
import { engineSkipReason } from './data-support';
import type { DataFixture } from './data-support';
import { checkFixture, editCatalog, failingInspections, ids, lake, readerOf } from './health-support';
import { copyHistoryFixture } from './history-support';
import { wasmPath } from '../support/fixtures';
import { recording } from '../support/recording-driver';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Health check run tests are skipped: ${skipReason}`);
}

const EVENTS_FILE = 'shop/events/kind=click/year=2025/ducklake-01a18cd6-3c4f-7d55-94b2-e4f075f8b0d6.parquet';
const EVOLVED_FILE = 'main/evolving';

describe.skipIf(skipReason)('a run of the health check', () => {
  const fixtures: DataFixture[] = [];
  const open = async (): Promise<{ fixture: DataFixture; files: string }> => {
    const fixture = await copyHistoryFixture('sqlite');
    fixtures.push(fixture);
    return { fixture, files: join(fixture.directory, 'sqlite-files') };
  };
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
  });

  it('reports the groups in order, every one of them running first and then finished', async () => {
    const { fixture } = await open();
    const events: HealthEvent[] = [];

    const report = await checkFixture(
      fixture,
      { scope: lake, depth: 'deep' },
      {},
      {},
      { onEvent: (e) => events.push(e) },
    );

    const states = events.flatMap((event) =>
      event.type === 'group' ? [`${event.status.group}:${event.status.state}`] : [],
    );
    expect(states).toEqual([
      'catalog:running',
      'catalog:done',
      'connection:running',
      'connection:done',
      'storage:running',
      'storage:done',
      'deep:running',
      'deep:done',
    ]);
    expect(events.at(-1)).toEqual({ type: 'summary', summary: report.summary });
    expect(events.filter((event) => event.type === 'finding').map((event) => event.finding.id)).toEqual(
      report.findings.map((item) => item.id),
    );
  });

  it('reads the info and the metadata of the catalog once for all groups', async () => {
    const { fixture } = await open();
    const driver = recording(await openSqlite({ path: fixture.profile.path, wasmPath }));
    const reader = createCatalogReader(driver);
    try {
      const report = await checkFixture(fixture, { scope: lake, depth: 'deep' }, {}, { reader });

      expect(report.groups.map((group) => group.state)).toEqual(['done', 'done', 'done', 'done']);
      expect([driver.count(info()), driver.count(metadata())]).toEqual([1, 1]);
    } finally {
      await reader.close();
    }
  });

  it('is cancelled before it starts: nothing runs and every group says so', async () => {
    const { fixture } = await open();
    const controller = new AbortController();
    controller.abort();

    const report = await checkFixture(fixture, { scope: lake }, {}, {}, { signal: controller.signal });

    expect(report.summary).toMatchObject({ cancelled: true, errors: 0, warnings: 0, infos: 0 });
    expect(report.groups.map((group) => [group.group, group.state, group.reason])).toEqual([
      ['catalog', 'skipped', 'Cancelled.'],
      ['connection', 'skipped', 'Cancelled.'],
      ['storage', 'skipped', 'Cancelled.'],
      ['deep', 'skipped', 'Cancelled.'],
    ]);
  });

  it('is cancelled while the store is read: the findings so far stay, the rest is skipped', async () => {
    const { fixture, files } = await open();
    rmSync(join(files, EVENTS_FILE));
    const controller = new AbortController();
    const events: HealthEvent[] = [];

    const report = await checkFixture(
      fixture,
      { scope: lake, depth: 'deep' },
      {},
      {},
      {
        signal: controller.signal,
        onEvent: (event) => {
          events.push(event);
          if (
            event.type === 'group' &&
            event.status.group === 'storage' &&
            event.status.state === 'running'
          ) {
            controller.abort();
          }
        },
      },
    );

    expect(report.summary.cancelled).toBe(true);
    expect(report.groups.map((group) => [group.group, group.state])).toEqual([
      ['catalog', 'done'],
      ['connection', 'done'],
      ['storage', 'skipped'],
      ['deep', 'skipped'],
    ]);
    expect(ids(report)).toEqual(['catalog.cleanup-pending', 'catalog.small-files:table:3']);
    // The caller is released at once; the run behind it must not report anything after the summary.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(events.at(-1)).toEqual({ type: 'summary', summary: report.summary });
  });

  it('goes on with the other groups when one check of the catalog fails', async () => {
    const { fixture, files } = await open();
    rmSync(join(files, EVENTS_FILE));
    const reader = await readerOf(fixture);
    try {
      const broken = {
        ...reader,
        maintenanceFacts: () =>
          Promise.reject(new AantjeError('QUERY_FAILED', 'The statement for the small files failed.')),
      };

      const report = await checkFixture(fixture, { scope: lake }, {}, { reader: broken });

      expect(report.groups[0]).toEqual({
        group: 'catalog',
        state: 'failed',
        message: 'The statement for the small files failed.',
      });
      // The other reads of the catalog and the later groups are not affected.
      expect(ids(report)).toEqual(['catalog.cleanup-pending', 'storage.file-missing:data:0']);
      expect(report.groups.slice(1).map((group) => group.state)).toEqual(['done', 'done', 'skipped']);
    } finally {
      await reader.close();
    }
  });

  it('reports an unreachable catalog and skips what needs it, without a secret in the message', async () => {
    const { fixture } = await open();
    const reader = await readerOf(fixture);
    try {
      const down = {
        ...reader,
        info: () =>
          Promise.reject(new AantjeError('CONNECTION_FAILED', 'Cannot connect to the server "db.example".')),
      };

      const report = await checkFixture(fixture, { scope: lake }, {}, { reader: down });

      expect(report.groups.map((group) => [group.group, group.state])).toEqual([
        ['catalog', 'failed'],
        ['connection', 'done'],
        ['storage', 'skipped'],
        ['deep', 'skipped'],
      ]);
      expect(report.groups[2]?.reason).toBe('The catalog database cannot be read.');
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]).toMatchObject({
        id: 'connection.catalog-unreachable',
        severity: 'error',
        detail: 'Cannot connect to the server "db.example".',
      });
      expect(report.snapshot).toBeUndefined();
    } finally {
      await reader.close();
    }
  });

  it('reports a lake that the data engine cannot attach, and skips the store', async () => {
    const { fixture } = await open();
    // The reader still has the catalog; the engine is pointed at a file that is no DuckLake.
    const notALake = join(fixture.directory, 'not-a-lake.sqlite');
    writeFileSync(notALake, 'this is not a database');

    const report = await checkFixture(
      fixture,
      { scope: lake },
      { profile: { ...fixture.profile, path: notALake } },
    );

    expect(ids(report, 'connection')).toEqual(['connection.attach-failed']);
    expect(report.findings.find((item) => item.group === 'connection')?.severity).toBe('error');
    expect(report.groups.map((group) => group.state)).toEqual(['done', 'done', 'skipped', 'skipped']);
    expect(report.groups[2]?.reason).toBe('The lake could not be attached (see the group Connection).');
  });

  it('names the table of a table scope as the snapshot in view names it', async () => {
    const { fixture, files } = await open();
    const evolving = join(files, EVOLVED_FILE);
    for (const name of readdirSync(evolving)) rmSync(join(evolving, name));

    const now = await checkFixture(fixture, { scope: { kind: 'table', tableId: 12 }, snapshot: 56 });
    const then = await checkFixture(fixture, { scope: { kind: 'table', tableId: 12 }, snapshot: 34 });

    const named = (name: string) => ({ kind: 'table', id: 12, schema: 'main', name });
    expect(now.findings.map((item) => item.scope)).toEqual([
      named('evolved'),
      named('evolved'),
      named('evolved'),
    ]);
    expect(then.findings.map((item) => item.scope)).toEqual([
      named('evolving'),
      named('evolving'),
      named('evolving'),
    ]);
    expect(ids(now)).toEqual([
      'storage.file-missing:data:19',
      'storage.file-missing:data:20',
      'storage.nothing-found',
    ]);
  });

  it('checks a table the catalog does not know and calls it by its id', async () => {
    const { fixture } = await open();

    const report = await checkFixture(fixture, { scope: { kind: 'table', tableId: 999 } });

    expect(report.groups.map((group) => group.state)).toEqual(['done', 'done', 'skipped', 'skipped']);
    expect(report.groups[2]?.reason).toBe('The table has no directory in the catalog.');
    expect(report.findings).toEqual([]);
  });

  it('gives the same report for the same catalog and the same store, run after run', async () => {
    const { fixture, files } = await open();
    rmSync(join(files, EVENTS_FILE));
    writeFileSync(join(files, 'shop/events/ducklake-stray.parquet'), 'x');
    await editCatalog(fixture, [
      `UPDATE meta.ducklake_data_file SET file_size_bytes = NULL WHERE data_file_id = 8`,
    ]);

    const first = await checkFixture(fixture, { scope: lake, depth: 'deep' });
    const second = await checkFixture(fixture, { scope: lake, depth: 'deep' });

    const strip = (report: typeof first) => ({ ...report, summary: { ...report.summary, elapsedMs: 0 } });
    expect(strip(second)).toEqual(strip(first));
    expect(ids(first).map((id) => id.replace(/storage\.file-orphaned:.*/, 'storage.file-orphaned'))).toEqual([
      'catalog.files-without-size',
      'catalog.cleanup-pending',
      'catalog.small-files:table:3',
      'storage.file-missing:data:0',
      'storage.file-orphaned',
    ]);
  });

  it('gives every finding a severity its check allows and the SQL it offers runs on the lake', async () => {
    const { fixture, files } = await open();
    rmSync(join(files, EVENTS_FILE));
    writeFileSync(join(files, 'shop/events/ducklake-stray.parquet'), 'x');
    await editCatalog(fixture, [
      `UPDATE meta.ducklake_data_file SET file_size_bytes = NULL WHERE data_file_id = 8`,
      `UPDATE meta.ducklake_data_file SET record_count = -2 WHERE data_file_id = 9`,
    ]);

    const report = await checkFixture(fixture, { scope: lake });

    expect(report.findings.length).toBeGreaterThan(4);
    for (const item of report.findings) {
      expect(CHECKS[item.check].group).toBe(item.group);
      expect(CHECKS[item.check].severities).toContain(item.severity);
      expect(item.title).not.toBe('');
      expect(item.detail).not.toBe('');
      expect(item.cause).not.toBe('');
      expect(item.fix).not.toBe('');
    }
    expect(await failingInspections(fixture, report)).toEqual([]);
  });
});
