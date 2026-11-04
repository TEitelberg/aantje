import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthFinding, HealthReport, HealthRequest } from '../../src/health/model';
import { editedCatalogs } from '../support/edited-catalog';
import { historyFixture } from '../support/sources/history';
import { engineSkipReason } from './data-support';
import type { DataFixture } from './data-support';
import { checkFixture, ids, lake } from './health-support';
import { copyHistoryFixture } from './history-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Health check catalog tests are skipped: ${skipReason}`);
}

/** Rows that fill the columns of a data file; `values` replaces some of them. */
const dataFile = (values: Record<string, string | number | null>): string => {
  const row = {
    data_file_id: 900,
    table_id: 3,
    begin_snapshot: 6,
    end_snapshot: null,
    file_order: 0,
    path: 'x.parquet',
    path_is_relative: 1,
    file_format: 'parquet',
    record_count: 1,
    file_size_bytes: 100,
    footer_size: 10,
    row_id_start: 1000,
    partition_id: null,
    encryption_key: null,
    mapping_id: null,
    partial_max: null,
    row_group_count: 1,
    ...values,
  };
  const sql = (value: string | number | null): string =>
    value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value}'`;
  return `INSERT INTO ducklake_data_file (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(sql).join(', ')})`;
};

/** Many rows from a counting CTE: `INSERT INTO table SELECT <columns of i> FROM n`. */
const counting = (count: number, from: number, insert: string): string =>
  `WITH RECURSIVE n(i) AS (SELECT ${from} UNION ALL SELECT i + 1 FROM n WHERE i < ${from + count - 1}) ${insert}`;

/** Small data files of shop.readings (table 6), `count` of them with `size` bytes each. */
const readingsFiles = (count: number, size: number, id = 1000): string =>
  counting(
    count,
    1,
    `INSERT INTO ducklake_data_file SELECT ${id} + i, 6, 13, NULL, i, 'f${id}_' || i || '.parquet', 1, 'parquet', 1, ${size}, 10, ${id} + i, NULL, NULL, NULL, NULL, 1 FROM n`,
  );

const HEALTHY_INFOS = ['catalog.cleanup-pending', 'catalog.small-files:table:3'];

describe.skipIf(skipReason)('the catalog checks on edited copies of the history fixture', () => {
  let fixture: DataFixture;
  const catalogs = editedCatalogs();

  beforeAll(async () => {
    fixture = await copyHistoryFixture('sqlite');
  });
  afterAll(async () => {
    await catalogs.dispose();
    await fixture.remove();
  });

  /** The catalog group of a run whose catalog was edited; the store is the unedited fixture. */
  async function edited(
    statements: readonly string[],
    request: Partial<HealthRequest> & { scope: HealthRequest['scope'] } = { scope: lake },
    source: string = historyFixture.sqlite,
    extra: Parameters<typeof checkFixture>[3] = {},
  ): Promise<HealthReport> {
    const reader = await catalogs.open(source, ...statements);
    return checkFixture(fixture, request, {}, { reader, ...extra });
  }
  const catalog = (report: HealthReport): HealthFinding[] =>
    report.findings.filter((item) => item.group === 'catalog');
  const found = (report: HealthReport, check: string): HealthFinding | undefined =>
    report.findings.find((item) => item.check === check);

  it('finds nothing but the documented hints in the healthy catalog, and names the table of the small files', async () => {
    const report = await edited([]);

    expect(ids(report, 'catalog')).toEqual(HEALTHY_INFOS);
    expect(catalog(report).map((item) => item.severity)).toEqual(['info', 'info']);
    expect(report.groups[0]).toEqual({ group: 'catalog', state: 'done' });
    expect(found(report, 'catalog.small-files')?.scope).toEqual({
      kind: 'table',
      id: 3,
      schema: 'shop',
      name: 'events',
    });
    expect(found(report, 'catalog.cleanup-pending')?.detail).toContain('5 files');
  });

  it('calls the cleanup overdue after seven days, and a gap in the numbering after Expire Snapshots a hint', async () => {
    // The oldest file was scheduled at 2026-10-30T12:43:33.207Z: seven days later is 2026-11-06T12:43:33.207Z.
    const justAfter = await edited([], { scope: lake }, historyFixture.sqlite, {
      now: () => new Date('2026-11-06T12:43:33.208Z'),
    });
    const expired = await edited([], { scope: lake }, historyFixture.expired);

    expect(found(justAfter, 'catalog.cleanup-overdue')?.severity).toBe('warning');
    expect(ids(justAfter, 'catalog')).not.toContain('catalog.cleanup-pending');
    expect(found(expired, 'catalog.snapshot-gaps')).toMatchObject({ severity: 'info', scope: lake });
    expect(found(expired, 'catalog.snapshot-gaps')?.detail).toContain('@1 to @54');
  });

  it('calls a table of small files a warning from a thousand small files on, and names the gaps of missing snapshots', async () => {
    const report = await edited([
      readingsFiles(1200, 100),
      'DELETE FROM ducklake_snapshot WHERE snapshot_id IN (20, 30, 31)',
    ]);

    expect(
      report.findings
        .filter((item) => item.check === 'catalog.small-files')
        .map((item) => [item.id, item.severity]),
    ).toEqual([
      ['catalog.small-files:table:6', 'warning'],
      ['catalog.small-files:table:3', 'info'],
    ]);
    expect(found(report, 'catalog.snapshot-gaps')?.detail).toContain('@20, @30 to @31');
  });

  it('calls a table one of small files from five files on when at least half of them are small', async () => {
    // shop.readings has one small file; shop.customers has 4 files, all of them small, and is never called out.
    for (const [small, large, called] of [
      [3, 0, false],
      [1, 3, false],
      [2, 2, true],
      [3, 6, false],
      [4, 5, true],
    ] as const) {
      const statements = [
        ...(small ? [readingsFiles(small, 100, 1000)] : []),
        ...(large ? [readingsFiles(large, 104_857_600, 2000)] : []),
      ];
      const report = await edited(statements);

      expect(
        ids(report, 'catalog').includes('catalog.small-files:table:6'),
        `${small} small, ${large} large`,
      ).toBe(called);
    }
  });

  it('reports only the first findings of a check, counts the rest, and counts a table of small files it did not name', async () => {
    const report = await edited([readingsFiles(2, 100, 1000), readingsFiles(2, 104_857_600, 2000)], {
      scope: lake,
      limits: { findingsPerCheck: 1 },
    });

    expect(
      report.findings.filter((item) => item.check === 'catalog.small-files').map((item) => item.id),
    ).toEqual(['catalog.small-files:table:3']);
    expect(report.groups[0]).toEqual({ group: 'catalog', state: 'done', truncated: true, omitted: 1 });
    expect(report.summary.omitted).toBe(1);
  });

  it('does not take legitimate shapes for defects: a delete of every row, a count of zero, a flushed file, a replaced file, a size of zero', async () => {
    const report = await edited([
      `UPDATE ducklake_delete_file SET delete_count = (SELECT record_count FROM ducklake_data_file WHERE data_file_id = 9) WHERE delete_file_id = 12`,
      dataFile({ data_file_id: 902, table_id: 6, record_count: 0, row_id_start: 5000 }),
      // A flushed file holds each row id once per version of the row: 14 rows do not fill the ids 0 to 13.
      dataFile({
        data_file_id: 903,
        table_id: 3,
        begin_snapshot: 30,
        row_id_start: 0,
        record_count: 14,
        partial_max: 31,
      }),
      // Data file 0 of shop.events (row ids 0 to 2) is replaced at snapshot 30 by a file with the same row ids.
      'UPDATE ducklake_data_file SET end_snapshot = 30 WHERE data_file_id = 0',
      dataFile({ data_file_id: 901, table_id: 3, begin_snapshot: 30, row_id_start: 0, record_count: 3 }),
      'UPDATE ducklake_data_file SET file_size_bytes = 0 WHERE data_file_id = 8',
    ]);

    expect(ids(report, 'catalog')).toEqual(['catalog.files-without-size', ...HEALTHY_INFOS]);
  });

  it('hints at many snapshots and at large inlined data, and reads no table just because the list of inlined tables names it', async () => {
    const report = await edited([
      counting(
        10_100 - 57 + 1,
        57,
        `INSERT INTO ducklake_snapshot SELECT i, '2026-10-30 12:50:00+00', 35, 20, 28 FROM n`,
      ),
      counting(10_000, 100, `INSERT INTO ducklake_inlined_data_10_12 SELECT i, 22, NULL, i, 'x' FROM n`),
      'CREATE TABLE evil (_ducklake_end_snapshot BIGINT)',
      counting(10_001, 1, 'INSERT INTO evil SELECT NULL FROM n'),
      `INSERT INTO ducklake_inlined_data_tables VALUES (6, 'evil', 1)`,
    ]);

    expect(found(report, 'catalog.many-snapshots')?.severity).toBe('info');
    expect(found(report, 'catalog.many-snapshots')?.detail).toContain('10,101');
    expect(
      report.findings.filter((item) => item.check === 'catalog.large-inlined-data').map((item) => item.id),
    ).toEqual(['catalog.large-inlined-data:table:10']);
    expect(found(report, 'catalog.large-inlined-data')?.scope).toEqual({
      kind: 'table',
      id: 10,
      schema: 'shop',
      name: 'notes',
    });
    expect(ids(report, 'catalog')).not.toContain('catalog.snapshot-gaps');
  });

  it('accepts a newer minor version of the specification, refuses another major one and stops reading, skips the store without a data path', async () => {
    const minor = await edited([`UPDATE ducklake_metadata SET value = '1.2' WHERE key = 'version'`]);
    const major = await edited([`UPDATE ducklake_metadata SET value = '2.0' WHERE key = 'version'`]);
    const noPath = await edited([`DELETE FROM ducklake_metadata WHERE key = 'data_path'`]);

    expect(found(minor, 'catalog.spec-version-newer')?.severity).toBe('info');
    expect(ids(major)).toEqual(['catalog.spec-version']);
    expect(major.findings[0]).toMatchObject({ severity: 'error', scope: lake });
    expect(major.findings[0]?.detail).toContain('2.0');
    expect(major.groups.map((group) => group.state)).toEqual(['done', 'done', 'skipped', 'skipped']);
    expect(ids(noPath, 'catalog')).toContain('catalog.data-path-missing');
    expect(noPath.groups.find((group) => group.group === 'storage')?.state).toBe('skipped');
  });

  // One edit that breaks exactly one check each: the finding, its severity and the datum the detail must name.
  const defects: [string, string[], string, 'error' | 'warning', string][] = [
    [
      'a data file of a table that does not exist',
      [dataFile({ table_id: 99 })],
      'catalog.files-without-table',
      'error',
      'table #99',
    ],
    [
      'a delete file without its data file',
      [
        `INSERT INTO ducklake_delete_file VALUES (901, 9, 17, NULL, 777, 'd.parquet', 1, 'parquet', 1, 50, 5, NULL, NULL, 1)`,
      ],
      'catalog.delete-files-without-data-file',
      'error',
      'data file #777',
    ],
    [
      'a negative row count',
      [`UPDATE ducklake_data_file SET record_count = -5 WHERE data_file_id = 8`],
      'catalog.negative-counts',
      'error',
      'count -5',
    ],
    [
      'a delete file that deletes more rows than its data file has',
      [`UPDATE ducklake_delete_file SET delete_count = 99 WHERE delete_file_id = 12`],
      'catalog.delete-count-over-records',
      'error',
      '99 deleted rows',
    ],
    [
      'a file without a size',
      [`UPDATE ducklake_data_file SET file_size_bytes = NULL WHERE data_file_id = 8`],
      'catalog.files-without-size',
      'warning',
      'shop.readings',
    ],
    [
      'file statistics of a column that does not exist',
      [
        `INSERT INTO ducklake_file_column_stats (data_file_id, table_id, column_id, value_count, null_count) VALUES (0, 3, 555, 1, 0)`,
      ],
      'catalog.stats-without-column',
      'warning',
      'column #555',
    ],
    [
      'partition values of a file without partitioning',
      [`INSERT INTO ducklake_file_partition_value VALUES (8, 6, 0, 'x')`],
      'catalog.partition-values-without-partitioning',
      'warning',
      'data file #8',
    ],
    [
      'partition columns of a partitioning that does not exist',
      [`INSERT INTO ducklake_partition_column VALUES (77, 3, 0, 1, 'identity')`],
      'catalog.partition-columns-without-partitioning',
      'warning',
      'partitioning #77',
    ],
    [
      'a data file of a partitioning that does not exist',
      [`UPDATE ducklake_data_file SET partition_id = 88 WHERE data_file_id = 0`],
      'catalog.files-unknown-partitioning',
      'warning',
      'partition 88',
    ],
    [
      'sort expressions of a sort order that does not exist',
      [`INSERT INTO ducklake_sort_expression VALUES (55, 6, 0, 'x', 'duckdb', 'ASC', 'NULLS_LAST')`],
      'catalog.sort-expressions-without-sort-order',
      'warning',
      'sort order #55',
    ],
    [
      'a table of a schema that does not exist',
      [`UPDATE ducklake_table SET schema_id = 99 WHERE table_id = 11`],
      'catalog.tables-without-schema',
      'error',
      'table #11',
    ],
    [
      'a view of a schema that does not exist',
      [`UPDATE ducklake_view SET schema_id = 99 WHERE view_id = 13`],
      'catalog.views-without-schema',
      'error',
      'view #13',
    ],
    [
      'a table whose columns all ended',
      [`UPDATE ducklake_column SET end_snapshot = 14 WHERE table_id = 6`],
      'catalog.tables-without-columns',
      'error',
      'shop.readings',
    ],
    [
      'a file that ends before it begins',
      [`UPDATE ducklake_data_file SET end_snapshot = 3 WHERE data_file_id = 8`],
      'catalog.snapshot-range-invalid',
      'error',
      'data file #8',
    ],
    [
      'two data files that claim the same row ids',
      [`UPDATE ducklake_data_file SET row_id_start = 0 WHERE data_file_id = 1`],
      'catalog.row-ids-overlap',
      'error',
      'data file #1',
    ],
  ];

  it('finds every defect of the consistency checks, one per edit, with its severity and the row it names, and nothing else', async () => {
    for (const [name, statements, check, severity, datum] of defects) {
      const report = await edited(statements);

      const hits = report.findings.filter((item) => item.check === check);
      expect(
        hits.map((item) => [item.id, item.severity, item.group]),
        name,
      ).toEqual([[check, severity, 'catalog']]);
      expect(hits[0]?.detail, name).toContain(datum);
      expect(hits[0]?.cause, name).not.toBe('');
      expect(hits[0]?.fix, name).not.toBe('');
      const others = catalog(report).filter((item) => item.check !== check && item.severity !== 'info');
      expect(
        others.map((item) => item.id),
        name,
      ).toEqual([]);
    }
  });

  it('counts all rows of a check but names only the first ten, in the scope of the table when all rows belong to one', async () => {
    const report = await edited([
      counting(
        12,
        1,
        `INSERT INTO ducklake_data_file SELECT 1000 + i, 6, 13, NULL, i, 'f' || i || '.parquet', 1, 'parquet', -1, 100, 10, 100 + i, NULL, NULL, NULL, NULL, 1 FROM n`,
      ),
    ]);

    const negative = found(report, 'catalog.negative-counts');
    expect(negative?.detail).toMatch(/^12 rows: .*\(the first 10 of 12\).* and 5 more\.$/);
    expect(negative?.scope).toEqual({ kind: 'table', id: 6, schema: 'shop', name: 'readings' });
  });

  it('checks only the rows of one table in a table scope, and gives the same findings in the same order run after run', async () => {
    const statements = [
      `UPDATE ducklake_data_file SET record_count = -5 WHERE data_file_id = 8`,
      `UPDATE ducklake_data_file SET file_size_bytes = NULL WHERE data_file_id = 9`,
      `UPDATE ducklake_view SET schema_id = 99 WHERE view_id = 13`,
    ];

    const table = await edited(statements, { scope: { kind: 'table', tableId: 9 } });
    const first = await edited(statements);
    const second = await edited(statements);

    expect(ids(table, 'catalog')).toEqual(['catalog.files-without-size']);
    expect(table.findings[0]?.scope).toEqual({ kind: 'table', id: 9, schema: 'shop', name: 'customers' });
    expect(ids(first, 'catalog')).toEqual([
      'catalog.negative-counts',
      'catalog.views-without-schema',
      'catalog.files-without-size',
      ...HEALTHY_INFOS,
    ]);
    expect(ids(second, 'catalog')).toEqual(ids(first, 'catalog'));
  });

  it('skips a check whose table the catalog lacks and says how many it could not run', async () => {
    const report = await edited([`DROP TABLE ducklake_sort_expression`]);

    expect(report.groups[0]).toEqual({ group: 'catalog', state: 'done', notChecked: 1 });
    expect(ids(report, 'catalog')).toEqual(HEALTHY_INFOS);
  });
});
