import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoredFile } from '../../src/catalog/model';
import { withLakeSession } from '../../src/data/engine';
import { chooseDeepFiles, schemaStatement, topLevelColumns } from '../../src/health/deep-checks';
import type { HealthEvent, HealthFinding, HealthReport } from '../../src/health/model';
import { accessFor, engineSkipReason, extensionDirectory } from './data-support';
import type { DataFixture } from './data-support';
import { checkFixture, editCatalog, ids, lake, problems, readerOf } from './health-support';
import { copyHistoryFixture } from './history-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Health check deep tests are skipped: ${skipReason}`);
}

const find = (report: HealthReport, check: string): HealthFinding[] =>
  report.findings.filter((item) => item.check === check);

const file = (id: number, extra: Partial<StoredFile> = {}): StoredFile => ({
  kind: 'data',
  id,
  tableId: 1,
  schema: 's',
  table: 't',
  beginSnapshot: id,
  endSnapshot: null,
  location: `/data/${id}.parquet`,
  sizeBytes: 100,
  records: 1,
  encrypted: false,
  format: 'parquet',
  ...extra,
});

describe('choosing the files for the deep check', () => {
  it('takes the largest half and then the newest files, ties by id, and leaves out retained, encrypted, placeless and Puffin files', () => {
    const sized = chooseDeepFiles(
      [
        file(1, { sizeBytes: 500 }),
        file(2, { sizeBytes: 900 }),
        file(3, { sizeBytes: 900 }),
        file(4, { sizeBytes: 10 }),
        file(5, { sizeBytes: 10 }),
        file(6, { sizeBytes: 10 }),
      ],
      4,
    );
    const mixed = chooseDeepFiles(
      [
        file(1),
        file(2, { endSnapshot: 9 }),
        file(3, { encrypted: true }),
        file(4, { location: null }),
        file(5, { kind: 'delete' }),
        file(6, { kind: 'delete', format: 'puffin' }),
      ],
      10,
    );

    // The two largest (2 and 3, equal size: by id), then the newest of the rest (6, 5).
    expect(sized.chosen.map((item) => item.id)).toEqual([2, 3, 6, 5]);
    expect(sized.eligible).toBe(6);
    expect(mixed.chosen.map((item) => item.id)).toEqual([1, 5]);
    expect(mixed.eligible).toBe(2);
  });
});

describe.skipIf(skipReason)('the deep check on a lake on the local disk', () => {
  const fixtures: DataFixture[] = [];
  const open = async (): Promise<{ fixture: DataFixture; files: string }> => {
    const fixture = await copyHistoryFixture('sqlite');
    fixtures.push(fixture);
    return { fixture, files: join(fixture.directory, 'sqlite-files') };
  };
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
  });

  const events = 'shop/events/kind=click/year=2025/ducklake-01a18cd6-3c4f-7d55-94b2-e4f075f8b0d6.parquet';
  const LARGEST = 'shop/events/kind=click/year=2025/ducklake-01a18cd6-3c76-7b93-871e-02a43a0d52c2.parquet'; // data file 4
  const SECOND = 'shop/customers/ducklake-01a18cd6-3de1-751e-828c-76b7ae4e68ee-delete.parquet'; // delete file 12
  const NEWEST = 'shop/log/ducklake-01a18cd6-43d4-7888-888b-78e6e3148be8.parquet'; // data file 27

  /** Overwrites a file with garbage of the same size: the listing sees nothing, the footer is gone. */
  const garble = (files: string, relative: string): void => {
    const path = join(files, relative);
    writeFileSync(path, 'x'.repeat(statSync(path).size));
  };

  /** Writes a Parquet file of the given query to a place, with the real engine. */
  async function write(path: string, query: string): Promise<void> {
    const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
    const connection = await instance.connect();
    try {
      await connection.run(`COPY (${query}) TO '${path.replaceAll("'", "''")}' (FORMAT parquet)`);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }

  it('reads the footer of every current file of the healthy lake, reports its progress and finds nothing', async () => {
    const { fixture } = await open();
    const seen: HealthEvent[] = [];

    const report = await checkFixture(
      fixture,
      { scope: lake, depth: 'deep' },
      {},
      {},
      { onEvent: (e) => seen.push(e) },
    );

    expect(problems(report)).toEqual([]);
    expect(report.groups[3]).toEqual({ group: 'deep', state: 'done' });
    const progress = seen.filter((event) => event.type === 'progress');
    expect(progress.at(0)).toEqual({ type: 'progress', group: 'deep', done: 0, total: 20 });
    expect(progress.at(-1)).toEqual({ type: 'progress', group: 'deep', done: 20, total: 20 });
  });

  it('finds a file that is overwritten although its size is right, in the scope of its table', async () => {
    const { fixture, files } = await open();
    garble(files, events);

    const report = await checkFixture(fixture, { scope: lake, depth: 'deep' });

    expect(find(report, 'deep.file-unreadable')).toHaveLength(1);
    expect(find(report, 'deep.file-unreadable')[0]).toMatchObject({
      id: 'deep.file-unreadable:data:0',
      severity: 'error',
      group: 'deep',
      scope: { kind: 'table', id: 3, schema: 'shop', name: 'events' },
    });
    expect(ids(report, 'storage')).toEqual([]);
  });

  it('opens the files of a catalog that records no format, as Parquet files', async () => {
    const { fixture } = await open();
    await editCatalog(fixture, [
      'UPDATE meta.ducklake_data_file SET file_format = NULL',
      'UPDATE meta.ducklake_delete_file SET format = NULL',
    ]);

    const report = await checkFixture(fixture, { scope: lake, depth: 'deep' });

    expect(report.groups[3]).toEqual({ group: 'deep', state: 'done' });
    expect(problems(report)).toEqual([]);
  });

  it('finds a file with another number of rows than the catalog says, and columns the table never had', async () => {
    const { fixture, files } = await open();
    // The catalog has 3 rows for this file; a file without field ids is matched by name.
    await write(join(files, events).replaceAll('\\', '/'), 'SELECT range AS id, 2 AS foo FROM range(5)');

    const report = await checkFixture(fixture, { scope: lake, depth: 'deep' });

    expect(find(report, 'deep.row-count-mismatch').map((item) => [item.id, item.severity])).toEqual([
      ['deep.row-count-mismatch:data:0', 'error'],
    ]);
    expect(find(report, 'deep.row-count-mismatch')[0]?.detail).toContain('5 rows');
    expect(find(report, 'deep.columns-unknown').map((item) => [item.id, item.severity])).toEqual([
      ['deep.columns-unknown:data:0', 'warning'],
    ]);
    expect(find(report, 'deep.columns-unknown')[0]?.detail).toContain('foo');
  });

  it('does not report a lost file a second time when the storage check has named it, and reports it itself when that check did not run', async () => {
    const { fixture, files } = await open();
    rmSync(join(files, events));

    const both = await checkFixture(fixture, { scope: lake, depth: 'deep' });
    // 21 files are more than this limit: the storage check is skipped and the deep check reads the first ones.
    const deepOnly = await checkFixture(fixture, {
      scope: lake,
      depth: 'deep',
      limits: { storageFiles: 10 },
    });

    expect(find(both, 'storage.file-missing').map((item) => item.id)).toEqual([
      'storage.file-missing:data:0',
    ]);
    expect(ids(both, 'deep')).toEqual([]);
    expect(both.groups[3]).toEqual({ group: 'deep', state: 'done' });
    expect(deepOnly.groups[2]?.state).toBe('skipped');
    expect(find(deepOnly, 'storage.file-missing').map((item) => item.id)).toEqual([
      'storage.file-missing:data:0',
    ]);
    expect(ids(deepOnly, 'deep')).toEqual([]);
    expect(deepOnly.groups[3]).toMatchObject({ state: 'done', truncated: true });
  });

  it('opens only as many files as the request allows, the largest and the newest first, and counts the others', async () => {
    const { fixture, files } = await open();
    for (const relative of [events, LARGEST, SECOND, NEWEST]) garble(files, relative);

    const report = await checkFixture(fixture, { scope: lake, depth: 'deep', limits: { deepFiles: 3 } });

    expect(ids(report, 'deep')).toEqual([
      'deep.file-unreadable:delete:12',
      'deep.file-unreadable:data:4',
      'deep.file-unreadable:data:27',
    ]);
    expect(report.groups[3]).toEqual({ group: 'deep', state: 'done', truncated: true, notChecked: 17 });
  });

  it('opens 200 files when the request sets no limit, and counts the one more', async () => {
    const { fixture } = await open();
    const reader = await readerOf(fixture);
    try {
      // 201 current files: the real ones, again under other ids.
      const inflated = {
        ...reader,
        fileLocations: async (...args: Parameters<typeof reader.fileLocations>) => {
          const places = await reader.fileLocations(...args);
          return {
            ...places,
            files: Array.from({ length: 201 }, (_, index) => ({
              ...(places.files[index % places.files.length] as StoredFile),
              id: 1000 + index,
              endSnapshot: null,
            })),
          };
        },
      };

      const report = await checkFixture(fixture, { scope: lake, depth: 'deep' }, {}, { reader: inflated });

      expect(report.groups[3]).toEqual({ group: 'deep', state: 'done', truncated: true, notChecked: 1 });
    } finally {
      await reader.close();
    }
  });

  it('does not open the files of a data directory that is gone: the connection group has said so once', async () => {
    const { fixture, files } = await open();
    rmSync(files, { recursive: true });

    const report = await checkFixture(fixture, { scope: lake, depth: 'deep' });

    expect(ids(report)).toEqual([
      'catalog.cleanup-pending',
      'catalog.small-files:table:3',
      'connection.local-path-missing',
    ]);
    expect(report.groups[3]).toMatchObject({ group: 'deep', state: 'skipped' });
  });

  it('stops between two files when the signal fires, keeps what it found and says it was cancelled', async () => {
    const { fixture, files } = await open();
    const controller = new AbortController();
    // The two largest files are opened first.
    for (const relative of [LARGEST, SECOND]) garble(files, relative);
    const seen: number[] = [];

    const report = await checkFixture(
      fixture,
      { scope: lake, depth: 'deep' },
      {},
      {},
      {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'progress') {
            seen.push(event.done);
            if (event.done === 3) controller.abort();
          }
        },
      },
    );

    expect(report.summary.cancelled).toBe(true);
    expect(report.groups[3]).toMatchObject({ group: 'deep', state: 'skipped' });
    // The files that were read before the signal are in the report; the others are not opened, also not afterwards
    // (the caller is released at once, the run behind it must stop on its own).
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(Math.max(...seen)).toBe(3);
    expect(ids(report, 'deep')).toEqual(['deep.file-unreadable:delete:12', 'deep.file-unreadable:data:4']);
  });

  it('takes the top-level columns of a file with a struct: the fields of the struct are not columns', async () => {
    const { fixture, files } = await open();
    const evolved = join(files, 'main/evolving');
    const name = readdirSync(evolved)[0] ?? '';

    const rows = await withLakeSession(accessFor(fixture), undefined, (session) =>
      session.rows(schemaStatement(join(evolved, name))),
    );
    const columns = topLevelColumns(
      rows.map(([column, children, fieldId]) => [
        String(column),
        children === null || children === undefined ? null : Number(children),
        fieldId === null || fieldId === undefined ? null : Number(fieldId),
      ]),
    );

    expect(rows.length).toBeGreaterThan(columns.length);
    expect(columns.map((column) => column.name)).toEqual(['id', 'name', 'info', 'n']);
    expect(columns.map((column) => column.fieldId)).toEqual([1, 2, 3, 6]);
  });
});
