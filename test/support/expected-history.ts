/**
 * Facts about the history fixture written by test/fixtures/history/generate-history.py (see the README next to it).
 * The statement list is fixed, so these values are identical for the sqlite, duckdb and postgres variant. File names,
 * sizes and commit times are not listed because they differ between generated variants.
 */

/** Snapshot ids, named after the statement that created them. */
export const HISTORY_SNAPSHOT = {
  createMain: 0,
  createShop: 1,
  createScratch: 2,
  dropScratch: 3,
  createEvents: 4,
  partitionEventsByYear: 5,
  insertEvents: 6, // 6 rows, 3 files: (click, 2025), (click, 2026), (view, 2025)
  insertEventView2026: 7,
  insertEventsBulk: 8, // 40 rows in one file
  partitionEventsByMonth: 9,
  insertEventsMonthly: 10, // 4 rows, 3 files
  createReadings: 11,
  sortReadingsBySensor: 12,
  insertReadings: 13,
  sortReadingsByValue: 14,
  createCustomers: 15,
  insertCustomers: 16,
  updateCustomer: 17, // data file with the new row version, delete file with the old one
  deleteCustomer: 18,
  createNotes: 19,
  insertNotes: 20, // data inlining: no Parquet file
  updateNote: 21,
  deleteNote: 22,
  twoTablesInOneTransaction: 23,
  createAndInsertInOneTransaction: 24,
  commitMessage: 25,
  createEvolving: 26,
  insertEvolving: 27,
  addExtraColumn: 28,
  renameColumn: 29,
  widenColumn: 30,
  dropExtraColumn: 31,
  addStructField: 32,
  addFlagColumn: 33,
  changeFlagDefault: 34,
  renameTable: 35,
  insertEvolved: 36,
  commentOnCustomers: 37,
  commentOnTier: 38,
  createBigEventsView: 39,
  commentOnView: 40,
  createTmpView: 41,
  dropTmpView: 42,
  createOldStuff: 43,
  insertOldStuff: 44,
  dropOldStuff: 45,
  createGrossMacro: 46,
  createRecentEventsMacro: 47,
  createLegacyFeeMacro: 48,
  dropLegacyFeeMacro: 49,
  createLog: 50,
  insertLog1: 51,
  insertLog2: 52,
  insertLog3: 53,
  insertLog4: 54,
  mergeLog: 55,
  insertLog5: 56,
} as const;

export const HISTORY_LATEST_SNAPSHOT = 56;

/** `ducklake_snapshot_changes.changes_made` of every snapshot; the index is the snapshot id. */
export const HISTORY_CHANGES: readonly string[] = [
  'created_schema:"main"',
  'created_schema:"shop"',
  'created_schema:"scratch"',
  'dropped_schema:2',
  'created_table:"shop"."events"',
  'altered_table:3',
  'inserted_into_table:3',
  'inserted_into_table:3',
  'inserted_into_table:3',
  'altered_table:3',
  'inserted_into_table:3',
  'created_table:"shop"."readings"',
  'altered_table:6',
  'inserted_into_table:6',
  'altered_table:6',
  'created_table:"shop"."customers"',
  'inserted_into_table:9',
  'inserted_into_table:9,deleted_from_table:9',
  'deleted_from_table:9',
  'created_table:"shop"."notes"',
  'inlined_insert:10',
  'inlined_insert:10,inlined_delete:10',
  'inlined_delete:10',
  'inserted_into_table:3,inserted_into_table:9',
  'created_table:"shop"."audit",inserted_into_table:11',
  'inserted_into_table:9',
  'created_table:"main"."evolving"',
  'inserted_into_table:12',
  'altered_table:12',
  'altered_table:12',
  'altered_table:12',
  'altered_table:12',
  'altered_table:12',
  'altered_table:12',
  'altered_table:12',
  'created_table:"main"."evolved"',
  'inserted_into_table:12',
  'altered_table:9',
  'altered_table:9',
  'created_view:"shop"."big_events"',
  'altered_view:13',
  'created_view:"shop"."tmp_view"',
  'dropped_view:14',
  'created_table:"shop"."old_stuff"',
  'inserted_into_table:15',
  'dropped_table:15',
  'created_scalar_macro:"shop"."gross"',
  'created_table_macro:"shop"."recent_events"',
  'created_scalar_macro:"shop"."legacy_fee"',
  'dropped_scalar_macro:18',
  'created_table:"shop"."log"',
  'inserted_into_table:19',
  'inserted_into_table:19',
  'inserted_into_table:19',
  'inserted_into_table:19',
  'merge_adjacent:19',
  'inserted_into_table:19',
];

/** The only snapshot with commit metadata. */
export const HISTORY_COMMIT = {
  snapshot: HISTORY_SNAPSHOT.commitMessage,
  author: 'tillmann',
  message: 'Nightly import',
  extraInfo: '{"source":"nightly","rows":1}',
} as const;

/**
 * Catalog ids. Schemas, tables, views, macros, partitionings and sort orders share one counter (next_catalog_id), which
 * is why the ids of the tables are not consecutive.
 */
export const HISTORY_ID = {
  mainSchema: 0,
  shopSchema: 1,
  scratchSchema: 2, // dropped at snapshot 3
  events: 3,
  eventsPartitionByYear: 4, // snapshots 5..8
  eventsPartitionByMonth: 5, // from snapshot 9 on
  readings: 6,
  readingsSortBySensor: 7, // snapshots 12..13
  readingsSortByValue: 8, // from snapshot 14 on
  customers: 9,
  notes: 10, // the only table with data inlining
  audit: 11,
  evolving: 12, // named `evolving` until snapshot 34, `evolved` from snapshot 35 on (same id)
  bigEventsView: 13,
  tmpView: 14, // dropped at snapshot 42
  oldStuff: 15, // dropped at snapshot 45
  grossMacro: 16,
  recentEventsMacro: 17,
  legacyFeeMacro: 18, // dropped at snapshot 49
  log: 19,
} as const;

/** Data files of shop.events: `values` are the partition values (kind, year or month). */
export const EVENTS_FILES: readonly {
  readonly id: number;
  readonly snapshot: number;
  readonly rows: number;
  readonly partition: number;
  readonly values: readonly [string, string];
}[] = [
  { id: 0, snapshot: 6, rows: 3, partition: 4, values: ['click', '2025'] },
  { id: 1, snapshot: 6, rows: 1, partition: 4, values: ['click', '2026'] },
  { id: 2, snapshot: 6, rows: 2, partition: 4, values: ['view', '2025'] },
  { id: 3, snapshot: 7, rows: 1, partition: 4, values: ['view', '2026'] },
  { id: 4, snapshot: 8, rows: 40, partition: 4, values: ['click', '2025'] },
  { id: 5, snapshot: 10, rows: 2, partition: 5, values: ['click', '3'] },
  { id: 6, snapshot: 10, rows: 1, partition: 5, values: ['click', '4'] },
  { id: 7, snapshot: 10, rows: 1, partition: 5, values: ['view', '3'] },
  { id: 15, snapshot: 23, rows: 1, partition: 5, values: ['view', '4'] },
];

/** Rows of the tables as the data engine returns them at a snapshot (inlined rows included). */
export const HISTORY_ROWS = {
  eventsAt: { 6: 6, 7: 7, 8: 47, 9: 47, 10: 51, 23: 52, 56: 52 },
  customersAt: { 16: 4, 17: 4, 18: 3, 23: 4, 25: 5, 56: 5 },
  notesAt: { 19: 0, 20: 3, 21: 3, 22: 2, 56: 2 },
  logAt: { 50: 0, 54: 4, 55: 4, 56: 5 },
} as const;

/**
 * Ids (column data_file_id of ducklake_files_scheduled_for_deletion) of the files that are left to clean up: the four
 * files that the compaction of shop.log (snapshot 55) replaced and the first delete file of shop.customers, which the
 * delete of snapshot 18 replaced.
 */
export const SCHEDULED_FOR_DELETION = [11, 22, 23, 24, 25] as const;

/** The expired copy (history-expired.sqlite) keeps these snapshots; the file of the dropped table joins the scheduled ones. */
export const EXPIRED_SNAPSHOTS = [0, 55, 56] as const;
export const EXPIRED_SCHEDULED_FOR_DELETION = [11, 21, 22, 23, 24, 25] as const;

/** `ducklake_metadata` keys of the catalog, global ones first (the row with a scope is the option of `shop.notes`). */
export const HISTORY_METADATA_KEYS = [
  'created_by',
  'data_path',
  'encrypted',
  'version',
  'data_inlining_row_limit',
] as const;

/** Data path as stored by each variant of the fixture (see the README: it is relative, or the container path). */
export const HISTORY_DATA_PATH = {
  sqlite: 'sqlite-files/',
  duckdb: 'duckdb-files/',
  postgres: '/tmp/aantje-fixture-data/',
  // The served copy of history.duckdb.
  quack: 'duckdb-files/',
} as const;

/** Count of the data files and delete files that are visible at a snapshot (see the files of the README). */
export const HISTORY_FILES_AT = { 0: [0, 0], 17: [11, 1], 56: [19, 1] } as const;

const KIND = { columnId: 2, path: ['kind'], transform: 'identity' };

/** The partitionings of shop.events; the column ids are `kind` (2) and `ts` (3). */
export const EVENTS_PARTITIONING_BY_YEAR = {
  id: HISTORY_ID.eventsPartitionByYear,
  beginSnapshot: HISTORY_SNAPSHOT.partitionEventsByYear,
  endSnapshot: HISTORY_SNAPSHOT.partitionEventsByMonth,
  columns: [KIND, { columnId: 3, path: ['ts'], transform: 'year' }],
};
export const EVENTS_PARTITIONING_BY_MONTH = {
  id: HISTORY_ID.eventsPartitionByMonth,
  beginSnapshot: HISTORY_SNAPSHOT.partitionEventsByMonth,
  endSnapshot: null,
  columns: [KIND, { columnId: 3, path: ['ts'], transform: 'month' }],
};

/** The sort orders of shop.readings, as stored: the keyword `value` is quoted. */
export const READINGS_SORT_BY_SENSOR = {
  id: HISTORY_ID.readingsSortBySensor,
  beginSnapshot: HISTORY_SNAPSHOT.sortReadingsBySensor,
  endSnapshot: HISTORY_SNAPSHOT.sortReadingsByValue,
  expressions: [
    { expression: 'sensor', dialect: 'duckdb', direction: 'ASC', nullOrder: 'NULLS_LAST' },
    { expression: 'taken_at', dialect: 'duckdb', direction: 'DESC', nullOrder: 'NULLS_LAST' },
  ],
};
export const READINGS_SORT_BY_VALUE = {
  id: HISTORY_ID.readingsSortByValue,
  beginSnapshot: HISTORY_SNAPSHOT.sortReadingsByValue,
  endSnapshot: null,
  expressions: [{ expression: '"value"', dialect: 'duckdb', direction: 'DESC', nullOrder: 'NULLS_FIRST' }],
};

/** The macros of schema `shop`; DuckLake stores no parameter types (`unknown`) and prints the bodies itself. */
export const GROSS_MACRO = {
  id: HISTORY_ID.grossMacro,
  schemaId: HISTORY_ID.shopSchema,
  name: 'gross',
  kind: 'scalar',
  implementations: [
    {
      dialect: 'duckdb',
      sql: '(net * rate)',
      parameters: [
        { name: 'net', type: null, defaultValue: null },
        { name: 'rate', type: null, defaultValue: '1.19' },
      ],
    },
  ],
};
export const RECENT_EVENTS_MACRO = {
  id: HISTORY_ID.recentEventsMacro,
  schemaId: HISTORY_ID.shopSchema,
  name: 'recent_events',
  kind: 'table',
  implementations: [
    {
      dialect: 'duckdb',
      sql: 'SELECT * FROM shop.events ORDER BY ts DESC LIMIT n',
      parameters: [{ name: 'n', type: null, defaultValue: null }],
    },
  ],
};
export const LEGACY_FEE_MACRO = {
  id: HISTORY_ID.legacyFeeMacro,
  schemaId: HISTORY_ID.shopSchema,
  name: 'legacy_fee',
  kind: 'scalar',
  implementations: [
    { dialect: 'duckdb', sql: '(x + 1)', parameters: [{ name: 'x', type: null, defaultValue: null }] },
  ],
};

/** Sizes in bytes of the nine data files of shop.events (file ids 0..7 and 15); the same in all three variants. */
export const EVENTS_FILE_SIZES = [658, 618, 641, 613, 1328, 647, 618, 613, 613] as const;

/**
 * Statistics of shop.events as the statistics report shows them at snapshot 56. The size histogram has eight bins that are
 * halves of the largest file (1328 bytes): eight files fall into the bin from 332 up to 664 bytes, the largest one
 * into the last bin.
 */
export const EVENTS_STATISTICS = {
  rows: 52,
  files: 9,
  dataBytes: 6349,
  largestFileBytes: 1328,
  smallFiles: 9,
  histogramFiles: [0, 0, 0, 0, 0, 0, 8, 1],
  histogramBytes: [0, 0, 0, 0, 0, 0, 5021, 1328],
  histogramEdges: [0, 11, 21, 42, 83, 166, 332, 664, 1328],
  /** Under the partitioning by month, which holds the four newest files; the five older ones were written by year. */
  partitions: [
    { values: ['click', '3'], files: 1, sizeBytes: 647, rows: 2 },
    { values: ['click', '4'], files: 1, sizeBytes: 618, rows: 1 },
    { values: ['view', '3'], files: 1, sizeBytes: 613, rows: 1 },
    { values: ['view', '4'], files: 1, sizeBytes: 613, rows: 1 },
  ],
  earlierFiles: 5,
  evenness: { coefficientOfVariation: 0.0227198, gini: 0.0107387 },
  /** At snapshot 8 (partitioned by year), all five files belong to the partitioning. */
  partitionsAtSnapshot8: [
    { values: ['click', '2025'], files: 2, sizeBytes: 1986, rows: 43 },
    { values: ['view', '2025'], files: 1, sizeBytes: 641, rows: 2 },
    { values: ['click', '2026'], files: 1, sizeBytes: 618, rows: 1 },
    { values: ['view', '2026'], files: 1, sizeBytes: 613, rows: 1 },
  ],
  evennessAtSnapshot8: { coefficientOfVariation: 0.6115685, gini: 0.2684033 },
  /** Cumulative state after each snapshot that added data files: [snapshot, files, bytes]. */
  growth: [
    [6, 3, 1917],
    [7, 4, 2530],
    [8, 5, 3858],
    [10, 8, 5736],
    [23, 9, 6349],
  ],
  /** The range of every column according to the table statistics (the latest snapshot) ... */
  ranges: {
    id: ['1', '139'],
    kind: ['click', 'view'],
    ts: ['2025-03-01 10:00:00', '2026-04-02 10:00:00'],
    amount: ['0.00', '58.50'],
  },
  /** ... and at snapshot 8, combined from the files that exist then (one `ts` file of later snapshots is not counted). */
  rangesAtSnapshot8: {
    id: ['1', '139'],
    kind: ['click', 'view'],
    ts: ['2025-03-01 10:00:00', '2026-01-06 10:00:00'],
    amount: ['0.00', '58.50'],
  },
} as const;

/** shop.log: four files of snapshots 51..54 were merged into one at snapshot 55, which keeps the first snapshot as its begin. */
export const LOG_GROWTH = [
  [51, 1, 750, false],
  [55, 1, 750, true],
  [56, 2, 1081, false],
] as const;

/**
 * shop.customers at snapshot 56: four data files of 2006 bytes together and one delete file whose size differs between
 * the variants of the fixture. Its `tier` and `name` columns have no NULL.
 */
export const CUSTOMERS_STATISTICS = { rows: 5, files: 4, deleteFiles: 1, dataBytes: 2006 } as const;

/**
 * The data files of the whole lake after each snapshot that added or removed files, as the Storage report draws its
 * growth: [snapshot, files, bytes of the data files, compaction]. Snapshot 45 drops shop.old_stuff, 55 merges shop.log.
 * The one delete file (written by snapshot 17) is not in the bytes, because its size differs between the variants of the
 * fixture; `LAKE_DELETE_FILE_SNAPSHOT` is where it starts to count.
 */
export const LAKE_GROWTH = [
  [6, 3, 1917, false],
  [7, 4, 2530, false],
  [8, 5, 3858, false],
  [10, 8, 5736, false],
  [13, 9, 6281, false],
  [16, 10, 6776, false],
  [17, 11, 7393, false],
  [23, 13, 8453, false],
  [24, 14, 8933, false],
  [25, 15, 9380, false],
  [27, 16, 10035, false],
  [36, 17, 10942, false],
  [44, 18, 11149, false],
  [45, 17, 10942, false],
  [51, 18, 11692, false],
  [55, 18, 11692, true],
  [56, 19, 12023, false],
] as const;

export const LAKE_DELETE_FILE_SNAPSHOT = 17;

/** The tables with small data files at snapshot 56 (every file of this fixture is small), most small files first: [table id, files, small]. */
export const LAKE_SMALL_FILES = [
  [3, 9, 9],
  [9, 4, 4],
  [12, 2, 2],
  [19, 2, 2],
  [6, 1, 1],
  [11, 1, 1],
] as const;
