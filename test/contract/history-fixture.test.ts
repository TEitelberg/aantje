import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, Value } from '../../src/catalog/drivers/driver';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { SPEC_VERSION } from '../support/expected';
import {
  EVENTS_FILES,
  EXPIRED_SCHEDULED_FOR_DELETION,
  EXPIRED_SNAPSHOTS,
  HISTORY_CHANGES,
  HISTORY_COMMIT,
  HISTORY_ID,
  HISTORY_LATEST_SNAPSHOT,
  HISTORY_SNAPSHOT,
  SCHEDULED_FOR_DELETION,
} from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { historyFixture } from '../support/sources/history';

/** The selected columns of every row, in the order of `columns`. */
async function select(driver: Driver, sql: string, ...columns: string[]): Promise<Value[][]> {
  const rows = await driver.query(sql);
  return rows.map((row) => columns.map((column) => row[column] ?? null));
}

// The facts of the fixture file that expected-history.ts pins, proven with plain SQL. The DuckDB and PostgreSQL
// variants hold the same statements; the reader contract suites read all three with the same expected values.
describe('history fixture', () => {
  let driver: Driver;
  const rows = (sql: string, ...columns: string[]): Promise<Value[][]> => select(driver, sql, ...columns);

  beforeAll(async () => {
    driver = await openSqlite({ path: historyFixture.sqlite, wasmPath });
  });
  afterAll(async () => {
    await driver.close();
  });

  it('is a specification 1.1 catalog whose snapshots carry exactly the pinned changes, with commit data on one snapshot only', async () => {
    const version = await rows("SELECT value FROM ducklake_metadata WHERE key = 'version'", 'value');
    const changes = await rows(
      'SELECT snapshot_id, changes_made FROM ducklake_snapshot_changes ORDER BY snapshot_id',
      'snapshot_id',
      'changes_made',
    );
    const commits = await rows(
      `SELECT snapshot_id, author, commit_message, commit_extra_info FROM ducklake_snapshot_changes
       WHERE author IS NOT NULL OR commit_message IS NOT NULL OR commit_extra_info IS NOT NULL`,
      'snapshot_id',
      'author',
      'commit_message',
      'commit_extra_info',
    );

    expect(version).toEqual([[SPEC_VERSION]]);
    expect(changes).toEqual(HISTORY_CHANGES.map((made, id) => [id, made]));
    expect(changes).toHaveLength(HISTORY_LATEST_SNAPSHOT + 1);
    expect(commits).toEqual([
      [HISTORY_COMMIT.snapshot, HISTORY_COMMIT.author, HISTORY_COMMIT.message, HISTORY_COMMIT.extraInfo],
    ]);
  });

  it('lists the schemas, tables and views: one schema dropped again, a renamed table keeps its id, dropped ones have an end snapshot', async () => {
    const schemas = await rows(
      'SELECT schema_id, schema_name, begin_snapshot, end_snapshot FROM ducklake_schema ORDER BY schema_id',
      'schema_id',
      'schema_name',
      'begin_snapshot',
      'end_snapshot',
    );
    const tables = await rows(
      'SELECT table_id, table_name, schema_id, begin_snapshot, end_snapshot FROM ducklake_table ORDER BY table_id, begin_snapshot',
      'table_id',
      'table_name',
      'schema_id',
      'begin_snapshot',
      'end_snapshot',
    );
    const views = await rows(
      'SELECT view_id, view_name, begin_snapshot, end_snapshot FROM ducklake_view ORDER BY view_id',
      'view_id',
      'view_name',
      'begin_snapshot',
      'end_snapshot',
    );

    const { shopSchema: shop, mainSchema: main } = HISTORY_ID;
    expect(schemas).toEqual([
      [main, 'main', 0, null],
      [shop, 'shop', 1, null],
      [HISTORY_ID.scratchSchema, 'scratch', HISTORY_SNAPSHOT.createScratch, HISTORY_SNAPSHOT.dropScratch],
    ]);
    expect(tables).toEqual([
      [HISTORY_ID.events, 'events', shop, 4, null],
      [HISTORY_ID.readings, 'readings', shop, 11, null],
      [HISTORY_ID.customers, 'customers', shop, 15, null],
      [HISTORY_ID.notes, 'notes', shop, 19, null],
      [HISTORY_ID.audit, 'audit', shop, 24, null],
      [HISTORY_ID.evolving, 'evolving', main, 26, HISTORY_SNAPSHOT.renameTable],
      [HISTORY_ID.evolving, 'evolved', main, HISTORY_SNAPSHOT.renameTable, null],
      [HISTORY_ID.oldStuff, 'old_stuff', shop, 43, HISTORY_SNAPSHOT.dropOldStuff],
      [HISTORY_ID.log, 'log', shop, 50, null],
    ]);
    expect(views).toEqual([
      [HISTORY_ID.bigEventsView, 'big_events', 39, null],
      [HISTORY_ID.tmpView, 'tmp_view', 41, HISTORY_SNAPSHOT.dropTmpView],
    ]);
  });

  it('partitions shop.events by (kind, year) and then by (kind, month), and stores its events in several files of uneven size with their partition values', async () => {
    const partitions = await rows(
      'SELECT partition_id, table_id, begin_snapshot, end_snapshot FROM ducklake_partition_info ORDER BY partition_id',
      'partition_id',
      'table_id',
      'begin_snapshot',
      'end_snapshot',
    );
    const columns = await rows(
      'SELECT partition_id, partition_key_index, column_id, transform FROM ducklake_partition_column ORDER BY partition_id, partition_key_index',
      'partition_id',
      'partition_key_index',
      'column_id',
      'transform',
    );
    const files = await rows(
      `SELECT f.data_file_id, f.begin_snapshot, f.record_count, f.partition_id,
              k.partition_value AS kind, p.partition_value AS bucket
       FROM ducklake_data_file f
       JOIN ducklake_file_partition_value k ON k.data_file_id = f.data_file_id AND k.partition_key_index = 0
       JOIN ducklake_file_partition_value p ON p.data_file_id = f.data_file_id AND p.partition_key_index = 1
       WHERE f.table_id = ${HISTORY_ID.events} ORDER BY f.data_file_id`,
      'data_file_id',
      'begin_snapshot',
      'record_count',
      'partition_id',
      'kind',
      'bucket',
    );

    const { events, eventsPartitionByYear: byYear, eventsPartitionByMonth: byMonth } = HISTORY_ID;
    expect(partitions).toEqual([
      [byYear, events, HISTORY_SNAPSHOT.partitionEventsByYear, HISTORY_SNAPSHOT.partitionEventsByMonth],
      [byMonth, events, HISTORY_SNAPSHOT.partitionEventsByMonth, null],
    ]);
    // column 2 is `kind`, column 3 is `ts`
    expect(columns).toEqual([
      [byYear, 0, 2, 'identity'],
      [byYear, 1, 3, 'year'],
      [byMonth, 0, 2, 'identity'],
      [byMonth, 1, 3, 'month'],
    ]);
    expect(files).toEqual(
      EVENTS_FILES.map((file) => [file.id, file.snapshot, file.rows, file.partition, ...file.values]),
    );
    expect(new Set(files.map((file) => file[2])).size).toBeGreaterThan(3);
  });

  it('sorts shop.readings by (sensor, taken_at desc) and then by value', async () => {
    const sorts = await rows(
      'SELECT sort_id, table_id, begin_snapshot, end_snapshot FROM ducklake_sort_info ORDER BY sort_id',
      'sort_id',
      'table_id',
      'begin_snapshot',
      'end_snapshot',
    );
    const expressions = await rows(
      'SELECT sort_id, sort_key_index, expression, sort_direction, null_order FROM ducklake_sort_expression ORDER BY sort_id, sort_key_index',
      'sort_id',
      'sort_key_index',
      'expression',
      'sort_direction',
      'null_order',
    );

    const { readings, readingsSortBySensor: bySensor, readingsSortByValue: byValue } = HISTORY_ID;
    expect(sorts).toEqual([
      [bySensor, readings, HISTORY_SNAPSHOT.sortReadingsBySensor, HISTORY_SNAPSHOT.sortReadingsByValue],
      [byValue, readings, HISTORY_SNAPSHOT.sortReadingsByValue, null],
    ]);
    // DuckDB quotes `value`, a keyword, in the stored expression
    expect(expressions).toEqual([
      [bySensor, 0, 'sensor', 'ASC', 'NULLS_LAST'],
      [bySensor, 1, 'taken_at', 'DESC', 'NULLS_LAST'],
      [byValue, 0, '"value"', 'DESC', 'NULLS_FIRST'],
    ]);
  });

  it('stores scalar and table macros with their parameters, one of them dropped, and comments as the only tags', async () => {
    const macros = await rows(
      `SELECT m.macro_id, m.macro_name, m.schema_id, m.begin_snapshot, m.end_snapshot, i.type, i.sql
       FROM ducklake_macro m JOIN ducklake_macro_impl i ON i.macro_id = m.macro_id ORDER BY m.macro_id`,
      'macro_id',
      'macro_name',
      'schema_id',
      'begin_snapshot',
      'end_snapshot',
      'type',
      'sql',
    );
    const parameters = await rows(
      'SELECT macro_id, parameter_name, default_value FROM ducklake_macro_parameters ORDER BY macro_id, column_id',
      'macro_id',
      'parameter_name',
      'default_value',
    );
    const tags = await rows(
      'SELECT object_id, begin_snapshot, end_snapshot, key, value FROM ducklake_tag ORDER BY object_id',
      'object_id',
      'begin_snapshot',
      'end_snapshot',
      'key',
      'value',
    );
    const columnTags = await rows(
      'SELECT table_id, column_id, begin_snapshot, end_snapshot, key, value FROM ducklake_column_tag',
      'table_id',
      'column_id',
      'begin_snapshot',
      'end_snapshot',
      'key',
      'value',
    );

    const shop = HISTORY_ID.shopSchema;
    expect(macros).toEqual([
      [HISTORY_ID.grossMacro, 'gross', shop, 46, null, 'scalar', '(net * rate)'],
      [
        HISTORY_ID.recentEventsMacro,
        'recent_events',
        shop,
        47,
        null,
        'table',
        'SELECT * FROM shop.events ORDER BY ts DESC LIMIT n',
      ],
      [
        HISTORY_ID.legacyFeeMacro,
        'legacy_fee',
        shop,
        48,
        HISTORY_SNAPSHOT.dropLegacyFeeMacro,
        'scalar',
        '(x + 1)',
      ],
    ]);
    expect(parameters).toEqual([
      [HISTORY_ID.grossMacro, 'net', 'NULL'],
      [HISTORY_ID.grossMacro, 'rate', '1.19'],
      [HISTORY_ID.recentEventsMacro, 'n', 'NULL'],
      [HISTORY_ID.legacyFeeMacro, 'x', 'NULL'],
    ]);
    // DuckLake offers no SQL to write other tags.
    expect(tags).toEqual([
      [HISTORY_ID.customers, HISTORY_SNAPSHOT.commentOnCustomers, null, 'comment', 'Customers of the shop'],
      [HISTORY_ID.bigEventsView, HISTORY_SNAPSHOT.commentOnView, null, 'comment', 'Events above 10'],
    ]);
    // column 3 of customers is `tier`
    expect(columnTags).toEqual([
      [HISTORY_ID.customers, 3, HISTORY_SNAPSHOT.commentOnTier, null, 'comment', 'bronze, silver or gold'],
    ]);
  });

  it('keeps the rows of the inlined table in the catalog and writes no file for it', async () => {
    const inlinedTables = await rows(
      'SELECT table_id, table_name FROM ducklake_inlined_data_tables',
      'table_id',
      'table_name',
    );
    const inlinedRows = await rows(
      `SELECT _ducklake_row_id, _ducklake_begin_snapshot, _ducklake_end_snapshot, id
       FROM ducklake_inlined_data_10_12 ORDER BY _ducklake_begin_snapshot, _ducklake_row_id`,
      '_ducklake_row_id',
      '_ducklake_begin_snapshot',
      '_ducklake_end_snapshot',
      'id',
    );
    const limit = await rows(
      "SELECT scope_id, value FROM ducklake_metadata WHERE key = 'data_inlining_row_limit'",
      'scope_id',
      'value',
    );
    const filesOfNotes = await rows(
      `SELECT data_file_id FROM ducklake_data_file WHERE table_id = ${HISTORY_ID.notes}`,
      'data_file_id',
    );

    expect(inlinedTables).toEqual([[HISTORY_ID.notes, 'ducklake_inlined_data_10_12']]);
    expect(limit).toEqual([[HISTORY_ID.notes, '10']]);
    expect(filesOfNotes).toEqual([]);
    expect(inlinedRows).toEqual([
      [0, 20, 21, 1],
      [1, 20, null, 2],
      [2, 20, 22, 3],
      [0, 21, null, 1],
    ]);
  });

  it('keeps the column id when a column is renamed or its type changes, and adds a new id for an added column', async () => {
    const columns = await rows(
      `SELECT column_id, column_name, column_type, parent_column, default_value, begin_snapshot, end_snapshot
       FROM ducklake_column WHERE table_id = ${HISTORY_ID.evolving} ORDER BY column_id, begin_snapshot`,
      'column_id',
      'column_name',
      'column_type',
      'parent_column',
      'default_value',
      'begin_snapshot',
      'end_snapshot',
    );

    expect(columns).toEqual([
      [1, 'id', 'int32', null, 'NULL', 26, null],
      // renamed at snapshot 29: same column id, new row
      [2, 'name', 'varchar', null, 'NULL', 26, HISTORY_SNAPSHOT.renameColumn],
      [2, 'title', 'varchar', null, 'NULL', HISTORY_SNAPSHOT.renameColumn, null],
      [3, 'info', 'struct', null, 'NULL', 26, null],
      [4, 'a', 'int32', 3, 'NULL', 26, null],
      [5, 'b', 'varchar', 3, 'NULL', 26, null],
      // INTEGER -> BIGINT at snapshot 30: same column id, new row
      [6, 'n', 'int32', null, 'NULL', 26, HISTORY_SNAPSHOT.widenColumn],
      [6, 'n', 'int64', null, 'NULL', HISTORY_SNAPSHOT.widenColumn, null],
      // dropped at snapshot 31, its id is never reused
      [
        7,
        'extra',
        'float64',
        null,
        'NULL',
        HISTORY_SNAPSHOT.addExtraColumn,
        HISTORY_SNAPSHOT.dropExtraColumn,
      ],
      // a field added to the struct is a new column below `info`
      [8, 'c', 'float64', 3, 'NULL', HISTORY_SNAPSHOT.addStructField, null],
      [
        9,
        'flag',
        'boolean',
        null,
        'false',
        HISTORY_SNAPSHOT.addFlagColumn,
        HISTORY_SNAPSHOT.changeFlagDefault,
      ],
      [9, 'flag', 'boolean', null, 'true', HISTORY_SNAPSHOT.changeFlagDefault, null],
    ]);
  });

  it('writes files per transaction, replaces the files of the compaction and of the second delete, schedules the old ones for deletion, and ends the file of a dropped table with it', async () => {
    const transaction = await rows(
      `SELECT table_id, begin_snapshot FROM ducklake_data_file
       WHERE begin_snapshot = ${HISTORY_SNAPSHOT.twoTablesInOneTransaction} ORDER BY table_id`,
      'table_id',
      'begin_snapshot',
    );
    const created = await rows(
      `SELECT t.table_id, t.begin_snapshot, f.begin_snapshot AS file_snapshot
       FROM ducklake_table t JOIN ducklake_data_file f ON f.table_id = t.table_id
       WHERE t.table_id = ${HISTORY_ID.audit}`,
      'table_id',
      'begin_snapshot',
      'file_snapshot',
    );
    const logFiles = await rows(
      `SELECT data_file_id, begin_snapshot, end_snapshot, record_count, partial_max FROM ducklake_data_file
       WHERE table_id = ${HISTORY_ID.log} ORDER BY data_file_id`,
      'data_file_id',
      'begin_snapshot',
      'end_snapshot',
      'record_count',
      'partial_max',
    );
    const deletes = await rows(
      'SELECT delete_file_id, table_id, data_file_id, begin_snapshot, end_snapshot, delete_count, partial_max FROM ducklake_delete_file',
      'delete_file_id',
      'table_id',
      'data_file_id',
      'begin_snapshot',
      'end_snapshot',
      'delete_count',
      'partial_max',
    );
    const scheduled = await rows(
      'SELECT data_file_id FROM ducklake_files_scheduled_for_deletion ORDER BY data_file_id',
      'data_file_id',
    );
    const oldStuffFiles = await rows(
      `SELECT begin_snapshot, end_snapshot, record_count FROM ducklake_data_file WHERE table_id = ${HISTORY_ID.oldStuff}`,
      'begin_snapshot',
      'end_snapshot',
      'record_count',
    );

    // Two tables inserted in ONE snapshot, and a table created with its first rows in one snapshot.
    const two = HISTORY_SNAPSHOT.twoTablesInOneTransaction;
    expect(transaction).toEqual([
      [HISTORY_ID.events, two],
      [HISTORY_ID.customers, two],
    ]);
    const both = HISTORY_SNAPSHOT.createAndInsertInOneTransaction;
    expect(created).toEqual([[HISTORY_ID.audit, both, both]]);
    // The merged file starts at the snapshot of the first merged file and tells up to which snapshot it has rows.
    expect(logFiles).toEqual([
      [26, 51, null, 4, HISTORY_SNAPSHOT.insertLog4],
      [27, HISTORY_SNAPSHOT.insertLog5, null, 1, null],
    ]);
    // One delete file for both deletes of shop.customers: it begins at the snapshot of the first delete (17) and
    // already counts the row of the second one (18), so delete_count is 2 for snapshot 17 too.
    expect(deletes).toEqual([
      [
        12,
        HISTORY_ID.customers,
        9,
        HISTORY_SNAPSHOT.updateCustomer,
        null,
        2,
        HISTORY_SNAPSHOT.deleteCustomer,
      ],
    ]);
    expect(scheduled).toEqual(SCHEDULED_FOR_DELETION.map((id) => [id]));
    expect(oldStuffFiles).toEqual([[HISTORY_SNAPSHOT.insertOldStuff, HISTORY_SNAPSHOT.dropOldStuff, 2]]);
  });
});

describe('the expired copy of the history fixture', () => {
  it('keeps only the snapshots that were not expired but all rows of ducklake_snapshot_changes, forgets the dropped table, and schedules the files of expired snapshots for deletion', async () => {
    const driver = await openSqlite({ path: historyFixture.expired, wasmPath });
    try {
      const rows = (sql: string, ...columns: string[]) => select(driver, sql, ...columns);
      const snapshots = await rows(
        'SELECT snapshot_id FROM ducklake_snapshot ORDER BY snapshot_id',
        'snapshot_id',
      );
      const changes = await rows(
        'SELECT snapshot_id, changes_made FROM ducklake_snapshot_changes ORDER BY snapshot_id',
        'snapshot_id',
        'changes_made',
      );
      const tables = await rows('SELECT table_id FROM ducklake_table ORDER BY table_id', 'table_id');
      const scheduled = await rows(
        'SELECT data_file_id FROM ducklake_files_scheduled_for_deletion ORDER BY data_file_id',
        'data_file_id',
      );

      expect(snapshots).toEqual(EXPIRED_SNAPSHOTS.map((id) => [id]));
      expect(changes).toEqual(HISTORY_CHANGES.map((made, id) => [id, made]));
      expect(tables.map(([id]) => id)).not.toContain(HISTORY_ID.oldStuff);
      expect(scheduled).toEqual(EXPIRED_SCHEDULED_FOR_DELETION.map((id) => [id]));
    } finally {
      await driver.close();
    }
  });
});
