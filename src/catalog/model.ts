import type { ChangeAction, ChangeObject } from './changes';

/** Id of a DuckLake snapshot (`ducklake_snapshot.snapshot_id`). */
export type SnapshotId = number;

export interface CatalogInfo {
  /** Value of `ducklake_metadata.version`, e.g. "1.1". */
  readonly specVersion: string;
  readonly latestSnapshot: SnapshotId;
}

export interface SnapshotInfo {
  readonly id: SnapshotId;
  /** ISO 8601, UTC. */
  readonly time: string;
  /** Raw `ducklake_snapshot_changes.changes_made`, e.g. `created_table:"sales"."orders"`. */
  readonly changes: string | null;
  /** Commit metadata (`CALL set_commit_message`); null when the snapshot has none or the catalog lacks the columns. */
  readonly author: string | null;
  readonly commitMessage: string | null;
  /** Free text of the writer, usually JSON; not parsed. */
  readonly commitExtraInfo: string | null;
}

export interface SchemaInfo {
  readonly id: number;
  readonly name: string;
  readonly comment: string | null;
}

/**
 * The default schema of the lake. DuckDB refuses to drop it in its own databases; DuckLake drops it and leaves a lake
 * without a default schema, so aantje offers no DROP of it.
 */
export const isMainSchema = (name: string): boolean => name === 'main';

interface TableStats {
  /** Data file rows minus delete file rows; inlined rows excluded. Inexact when `approximate` is set. */
  readonly rows: number;
  readonly files: number;
  /** Size of the data files plus the delete files. */
  readonly sizeBytes: number;
  /**
   * True when a visible file's `partial_max` is later than the snapshot (compacted data file, or delete file
   * spanning snapshots). Its row count then covers later snapshots too, so `rows` can be off. Absent when exact.
   */
  readonly approximate?: true;
}

export interface TableInfo {
  readonly id: number;
  readonly schemaId: number;
  readonly name: string;
  readonly comment: string | null;
  readonly stats: TableStats;
}

export interface ViewInfo {
  readonly id: number;
  readonly schemaId: number;
  readonly name: string;
  readonly comment: string | null;
  readonly sql: string;
  readonly dialect: string;
  /** Explicit column names (`column_aliases`); empty when the view has none. */
  readonly columnAliases: readonly string[];
}

export interface ColumnInfo {
  readonly id: number;
  readonly name: string;
  /** DuckLake type name, e.g. "int32", "varchar", "decimal(10,2)", "struct", "list", "map". */
  readonly type: string;
  readonly nullable: boolean;
  /** Default expression; null when none. */
  readonly defaultValue: string | null;
  readonly comment: string | null;
  /** Fields of a struct, the element of a list or key/value of a map; empty for leaf columns. */
  readonly children: readonly ColumnInfo[];
}

/** A table or view with its schema, for the catalog-wide search. */
export interface CatalogEntry {
  readonly kind: 'table' | 'view';
  readonly id: number;
  readonly name: string;
  readonly schemaId: number;
  readonly schemaName: string;
}

/** A column or nested field of a table, for the catalog-wide search. */
export interface CatalogColumnEntry {
  /** Column ids from the top-level column down to this one; the tree builds the node id from them. */
  readonly ids: readonly number[];
  /** Names from the top-level column down, e.g. `['customer', 'name']`. */
  readonly path: readonly string[];
  /** DuckLake type name, e.g. "int32" or "struct". */
  readonly type: string;
}

/** One row of `ducklake_metadata`; `scope` is null for a global entry, else e.g. "table" with its `scopeId`. */
export interface MetadataEntry {
  readonly key: string;
  readonly value: string;
  readonly scope: string | null;
  readonly scopeId: number | null;
}

/** The value of a global entry (`data_path`, `encrypted`, an option of the lake); null when the catalog has none. */
export const globalValue = (entries: readonly MetadataEntry[], key: string): string | null =>
  entries.find((entry) => entry.scope === null && entry.key === key)?.value ?? null;

export interface CatalogProperties {
  readonly specVersion: string;
  readonly createdBy: string | null;
  readonly dataPath: string | null;
  readonly encrypted: boolean;
  /** Every row of `ducklake_metadata`: global entries first, then by key, scope and scope id. */
  readonly metadata: readonly MetadataEntry[];
  readonly snapshotCount: number;
  /** ISO 8601 UTC; the snapshots with the lowest and the highest id. Null in a catalog without snapshots. */
  readonly firstSnapshotTime: string | null;
  readonly latestSnapshotTime: string | null;
}

export interface FileTotals {
  readonly count: number;
  readonly sizeBytes: number;
}

/** What the scheduled files are as `ducklake_cleanup_old_files` sees them: old enough to be deleted, or too young. */
export interface ScheduledSplit {
  /** The age a file must have; `option` is `delete_older_than` of the lake, `default` what DuckLake uses without it. */
  readonly age: { readonly text: string; readonly source: 'option' | 'default' };
  /** Files scheduled at least the age ago: the next call without `cleanup_all` deletes them. */
  readonly ready: number;
  readonly waiting: number;
  /** ISO 8601 UTC; when the oldest waiting file reaches the age, null without waiting files. */
  readonly nextReadyAt: string | null;
}

/** How many snapshots `ducklake_expire_snapshots` takes now (those at least the age old, the newest never) and how many are younger; `ready` and `waiting` count snapshots. */
export type ExpirableSplit = ScheduledSplit;

export interface StorageInfo {
  readonly dataPath: string | null;
  readonly encrypted: boolean;
  /** Data files and delete files that are visible at the snapshot. */
  readonly dataFiles: FileTotals;
  readonly deleteFiles: FileTotals;
  /** Files that expiry or compaction replaced and that wait for the cleanup of old files. */
  readonly scheduledForDeletion: {
    readonly count: number;
    /** ISO 8601 UTC; null when nothing is scheduled. */
    readonly oldestScheduledAt: string | null;
    /** Null when the age is not a fixed length (months, years) or not readable. */
    readonly split: ScheduledSplit | null;
  };
  /** The snapshots that Expire Snapshots takes now and those that are younger; null when the age is not a fixed length. */
  readonly expirableSnapshots: ExpirableSplit | null;
}

export interface PartitionColumn {
  readonly columnId: number;
  /** Names from the top-level column down to the (nested) column, as at the requested snapshot. */
  readonly path: readonly string[];
  /** As stored: `identity`, `year`, `month`, `day`, `hour`, `bucket(4)` and so on. */
  readonly transform: string;
}

export interface PartitioningInfo {
  readonly id: number;
  readonly beginSnapshot: SnapshotId;
  /** Null while the partitioning is the current one. */
  readonly endSnapshot: SnapshotId | null;
  /** In partition key order; empty for a partitioning that was reset. */
  readonly columns: readonly PartitionColumn[];
}

export interface SortExpression {
  /** SQL text as stored, e.g. `sensor` or `"value"`. */
  readonly expression: string;
  readonly dialect: string;
  /** As stored: `ASC` or `DESC`. */
  readonly direction: string;
  /** As stored: `NULLS_FIRST` or `NULLS_LAST`. */
  readonly nullOrder: string;
}

export interface SortOrderInfo {
  readonly id: number;
  readonly beginSnapshot: SnapshotId;
  readonly endSnapshot: SnapshotId | null;
  /** In sort key order. */
  readonly expressions: readonly SortExpression[];
}

export interface TagEntry {
  readonly key: string;
  readonly value: string;
}

export interface ColumnTagEntry extends TagEntry {
  readonly columnId: number;
  /** Names from the top-level column down to the (nested) column. */
  readonly path: readonly string[];
}

/** Tags without the key `comment`, which is the `comment` of the model. Sorted by key (columns by id first). */
export interface TagsInfo {
  readonly table: readonly TagEntry[];
  readonly columns: readonly ColumnTagEntry[];
}

export interface MacroParameter {
  readonly name: string;
  /** Null when DuckLake did not store a type (it writes `unknown`). */
  readonly type: string | null;
  /** SQL expression (`1.19`, `'x'`, `CAST('2020-01-01' AS DATE)`); null when the parameter has no default. */
  readonly defaultValue: string | null;
}

interface MacroImplementation {
  readonly dialect: string;
  readonly parameters: readonly MacroParameter[];
  /** The body: an expression for a scalar macro, a query for a table macro. */
  readonly sql: string;
}

export interface MacroInfo {
  readonly id: number;
  readonly schemaId: number;
  readonly name: string;
  readonly kind: 'scalar' | 'table';
  readonly implementations: readonly MacroImplementation[];
}

/**
 * Snapshots at which a table or view exists: `begin` is the first, `end` the first without it (exclusive); null while
 * it exists.
 */
export interface Lifetime {
  readonly begin: SnapshotId;
  readonly end: SnapshotId | null;
}

/** A table, view or macro that was dropped and that a snapshot which still exists can read. */
export interface DroppedObject {
  readonly kind: 'table' | 'view' | 'macro';
  readonly id: number;
  /** The name when it was dropped. */
  readonly name: string;
  /** The snapshot that dropped it. */
  readonly droppedAt: SnapshotId;
  /** ISO 8601, UTC; null when that snapshot expired. */
  readonly droppedTime: string | null;
  /** The newest snapshot that still exists at which the object existed: the one a restore reads. */
  readonly lastSnapshot: SnapshotId;
}

/** `renamed` is a `created_*` entry for an id that has an earlier version (DuckLake writes a rename as a creation). */
export type ResolvedAction = ChangeAction | 'renamed';

/** One entry of `changes_made` with its object named from the catalog. */
export interface ResolvedChange {
  readonly action: ResolvedAction;
  /** Null for an entry that is not understood. */
  readonly object: ChangeObject | null;
  /** Id of the object; null for snapshot tags, unknown entries and objects the catalog does not have. */
  readonly objectId: number | null;
  /** Schema of a table, view or macro; null for the other objects and when it cannot be found. */
  readonly schemaName: string | null;
  /** Name of the object or snapshot tag; null for expired snapshots, unknown entries and objects not found. */
  readonly name: string | null;
  /** The entry as stored. */
  readonly raw: string;
}

/** The schema of a table after a snapshot that changed it: its names and its columns. */
export interface SchemaVersion {
  readonly snapshot: SnapshotId;
  /** ISO 8601, UTC; null when the snapshot has expired. */
  readonly time: string | null;
  readonly author: string | null;
  readonly commitMessage: string | null;
  /**
   * Names after the snapshot; null while the table does not exist; `schemaName` is null when the schema row is
   * missing.
   */
  readonly table: { readonly schemaName: string | null; readonly name: string } | null;
  /** Columns after the snapshot, as `CatalogReader.columns` reads them; empty while the table does not exist. */
  readonly columns: readonly ColumnInfo[];
}

export interface SchemaHistory {
  /** Oldest first. */
  readonly versions: readonly SchemaVersion[];
  /** The table has older versions; the first listed is the starting point of the others. */
  readonly more: boolean;
}

/** A snapshot with its resolved changes. */
export interface SnapshotActivity {
  readonly id: SnapshotId;
  /** ISO 8601, UTC. */
  readonly time: string;
  readonly author: string | null;
  readonly commitMessage: string | null;
  /** The `changes_made` entries in stored order, named as `snapshotChanges` names them. */
  readonly changes: readonly ResolvedChange[];
}

// Both ends inclusive and optional.
interface SnapshotRange {
  readonly from?: SnapshotId;
  readonly to?: SnapshotId;
}

export interface SnapshotActivityPage {
  /** Newest first. */
  readonly snapshots: readonly SnapshotActivity[];
  /** The range holds older snapshots than these. */
  readonly more: boolean;
}

/** One bin of the file size histogram: `fromBytes` inclusive, `toBytes` exclusive (the last bin includes it). */
export interface FileSizeBin {
  readonly fromBytes: number;
  readonly toBytes: number;
  readonly files: number;
  readonly sizeBytes: number;
}

/** The data files of one combination of partition values. */
export interface PartitionBucket {
  /** One value per partition key, as stored (a `month` transform stores the number); null is a NULL value. */
  readonly values: readonly (string | null)[];
  readonly files: number;
  /** Data files plus delete files. */
  readonly sizeBytes: number;
  readonly rows: number;
}

/** How unevenly the partitions are filled, by their size in bytes. */
export interface Evenness {
  /** Standard deviation divided by the mean; 0 when all partitions are equally large. */
  readonly coefficientOfVariation: number;
  /** 0 when all partitions are equally large, towards 1 when one partition holds everything. */
  readonly gini: number;
}

export interface PartitionStatistics {
  readonly partitioning: PartitioningInfo;
  /** The largest partitions by size, at most `PARTITION_LIMIT`. */
  readonly partitions: readonly PartitionBucket[];
  /** Partitions not listed (counted, not named); absent when all are listed. */
  readonly rest?: {
    readonly partitions: number;
    readonly files: number;
    readonly sizeBytes: number;
    readonly rows: number;
  };
  /** Null with fewer than two partitions. */
  readonly evenness: Evenness | null;
  /** Visible data files written under an earlier partitioning or none; they are in no partition above. */
  readonly earlierFiles: number;
  /** True when the table has more partitions than were read; `rest` and `evenness` then cover only the largest. */
  readonly partial?: true;
  /** Partition keys left out beyond `MAX_PARTITION_KEYS`; partitions then group by the first keys only. */
  readonly keysLeftOut?: number;
  /** True when the partition values could not be read; `partitions` is then empty. */
  readonly unread?: true;
}

export interface ColumnStatistics {
  readonly id: number;
  /** Names from the top-level column down to this one. */
  readonly path: readonly string[];
  readonly type: string;
  readonly nullable: boolean;
  /** NULL values divided by all values of the data files; null when the catalog has no statistics for the column. */
  readonly nullRatio: number | null;
  /** Range from the statistics, as the text DuckLake stores; null when there is none. */
  readonly min: string | null;
  readonly max: string | null;
}

/** The state of a table after a snapshot that added or removed data files or delete files. */
export interface GrowthPoint {
  readonly snapshot: SnapshotId;
  /** ISO 8601, UTC; null when the snapshot has expired. */
  readonly time: string | null;
  /** Data files after this snapshot. */
  readonly files: number;
  /** Data files plus delete files after this snapshot. */
  readonly sizeBytes: number;
  /** The snapshot compacted the table (`merge_adjacent`). */
  readonly compaction: boolean;
}

/** The growth of the whole lake: the `growth` of `TableStatistics` summed over all tables. */
export interface LakeGrowth {
  /** Oldest first; `files` and `sizeBytes` are the state after the snapshot. */
  readonly growth: readonly GrowthPoint[];
  /**
   * True when snapshots were merged to keep `growth` short; each point is the state after the last snapshot it holds.
   */
  readonly growthMerged?: true;
}

/**
 * What one snapshot did to the live rows, bytes and data files of one table; the numbers are changes and can be
 * negative.
 */
export interface GrowthChange {
  readonly tableId: number;
  /** Null: the sum of all snapshots before the first one that was asked for. */
  readonly snapshot: SnapshotId | null;
  /** Rows in data files minus deleted rows, plus inlined rows. */
  readonly rows: number;
  /** Data files plus delete files. */
  readonly sizeBytes: number;
  /** Data files. */
  readonly files: number;
  /** Change in the number of visible files whose row count covers later snapshots (see `TableStats.approximate`). */
  readonly partialFiles: number;
}

export interface GrowthChanges {
  readonly changes: readonly GrowthChange[];
  /** True when the catalog has more inlined tables than were read; their rows are not counted. */
  readonly inlinedMore?: true;
  /** True when the list of the inlined tables or the statement that reads their rows failed; none are counted. */
  readonly inlinedFailed?: true;
}

export interface TableStatistics {
  readonly snapshot: SnapshotId;
  /** The same numbers as `TableStats`. */
  readonly rows: number;
  readonly files: number;
  readonly deleteFiles: number;
  readonly dataBytes: number;
  readonly deleteBytes: number;
  readonly approximate?: true;
  readonly largestFileBytes: number;
  /** Data files below `smallFileBytes`. */
  readonly smallFiles: number;
  readonly smallFileBytes: number;
  /** Empty for a table without data files, else one entry per bin, empty ones included. */
  readonly sizeHistogram: readonly FileSizeBin[];
  /** Absent for a table that is not partitioned at the snapshot. */
  readonly partitioning?: PartitionStatistics;
  /** Every column of the table at the snapshot, nested ones included, in table order. */
  readonly columns: readonly ColumnStatistics[];
  /** True when min and max come from only part of the file statistics because there are too many. */
  readonly columnsPartial?: true;
  /** True when the null counts or the ranges of the columns could not be read; the columns show without them. */
  readonly columnsUnread?: true;
  /** Oldest first. */
  readonly growth: readonly GrowthPoint[];
  /**
   * True when snapshots were merged to keep `growth` short; each point is the state after the last snapshot it holds.
   */
  readonly growthMerged?: true;
}

/** Kinds of rows that a healthy catalog does not have; `CatalogReader.consistency` looks for them. */
export const CONSISTENCY_CHECKS = [
  'files-without-table',
  'files-unknown-partitioning',
  'delete-files-without-data-file',
  'stats-without-column',
  'partition-values-without-partitioning',
  'partition-columns-without-partitioning',
  'sort-expressions-without-sort-order',
  'tables-without-schema',
  'views-without-schema',
  'tables-without-columns',
  'negative-counts',
  'delete-count-over-records',
  'files-without-size',
  'snapshot-range-invalid',
  'row-ids-overlap',
] as const;

export type ConsistencyCheck = (typeof CONSISTENCY_CHECKS)[number];

/** One row that breaks a check. */
export interface ConsistencySample {
  /** The table the row belongs to; null for a view. */
  readonly tableId: number | null;
  /** What `id` is the id of. */
  readonly kind: 'data-file' | 'delete-file' | 'table' | 'view' | 'partitioning' | 'sort-order';
  readonly id: number;
  /** The number that explains the row (the id it points to in vain, the count, the end of the earlier range). */
  readonly value: number | null;
}

export interface ConsistencyProblem {
  readonly check: ConsistencyCheck;
  /** All rows that break the check. */
  readonly count: number;
  /** The first of them by id, at most the limit that was asked for. */
  readonly samples: readonly ConsistencySample[];
}

export interface ConsistencyReport {
  /** The checks that found something, in the order of `CONSISTENCY_CHECKS`. */
  readonly problems: readonly ConsistencyProblem[];
  /** Checks that could not run because the catalog lacks a table or column they need. */
  readonly unavailable: readonly ConsistencyCheck[];
}

// The ids after `after` up to `next` (exclusive) do not exist.
interface SnapshotGap {
  readonly after: SnapshotId;
  readonly next: SnapshotId;
}

/** A table with small data files: its file count and how many are below `SMALL_FILE_BYTES`. */
export interface SmallFileTable {
  readonly tableId: number;
  readonly files: number;
  readonly small: number;
}

/**
 * The data files of a table that have a delete file at the newest state. A merge leaves such a file alone, and a
 * rewrite with `delete_threshold => 0` rewrites every one of them, small or not.
 */
export interface DeletedFiles {
  /** Those below `SMALL_FILE_BYTES`. */
  readonly small: number;
  /** All of them. */
  readonly files: number;
  /** The size of `files`. */
  readonly bytes: number;
}

/** A table with small data files that have a delete file, with its names at the newest state. */
export interface TableDeletedFiles extends DeletedFiles {
  readonly tableId: number;
  readonly schema: string;
  readonly table: string;
}

// SmallFileTable plus the bytes of the small files and the files with a delete file (null: not readable).
interface SmallFileBytes extends SmallFileTable {
  readonly smallBytes: number;
  readonly deleted: DeletedFiles | null;
}

/** A table whose data files with a delete file have lost a large share of their rows (newest state). */
export interface DeleteHeavyTable {
  readonly tableId: number;
  /** Data files in which at least the floor share of the rows is deleted. */
  readonly files: number;
  /** Of those, the files with at least the threshold share deleted: what a rewrite with that threshold rewrites. */
  readonly atThreshold: number;
  /** `record_count` of the `files`. */
  readonly records: number;
  /** `delete_count` of the `files`. */
  readonly deleted: number;
  /** Size of the data files of `files`. */
  readonly sizeBytes: number;
}

export interface MaintenanceFacts {
  readonly snapshotGaps: {
    /** All holes. */
    readonly count: number;
    /** All snapshot ids that are missing in the holes. */
    readonly missing: number;
    /** The oldest holes, at most the limit that was asked for. */
    readonly first: readonly SnapshotGap[];
  };
  /** Tables made of small files at the newest state (`SMALL_FILES` in `thresholds.ts`), most small files first. */
  readonly smallFiles: readonly SmallFileBytes[];
  /** Inlined rows (not yet written to Parquet) per table, for tables that have any. */
  readonly inlined: readonly { readonly tableId: number; readonly rows: number }[];
  /** True when more tables hold inlined data than the limit lets `inlined` count. */
  readonly inlinedMore?: true;
  /** True when the inlined rows of some tables could not be read; `inlined` leaves those tables out. */
  readonly inlinedFailed?: true;
}

/** A data file or delete file of the catalog, with the place where it should be. */
export interface StoredFile {
  readonly kind: 'data' | 'delete';
  readonly id: number;
  readonly tableId: number;
  /** Names of the newest version of the table; null when the catalog has no row for the table. */
  readonly schema: string | null;
  readonly table: string | null;
  readonly beginSnapshot: SnapshotId;
  /** Null while a snapshot still needs the file as its newest state; else the first snapshot that does not. */
  readonly endSnapshot: SnapshotId | null;
  /** The full path as DuckLake resolves it; null when the table or schema row is missing. */
  readonly location: string | null;
  readonly sizeBytes: number | null;
  /** `record_count` of a data file, `delete_count` of a delete file. */
  readonly records: number | null;
  readonly encrypted: boolean;
  /** `file_format` of a data file, `format` of a delete file (`parquet`, `puffin` for a deletion vector). */
  readonly format: string;
}

export interface FileLocations {
  /** The `data_path` as stored; null when there is none. */
  readonly dataPath: string | null;
  /** The files of the scope by kind and id, at most the limit that was asked for. */
  readonly files: readonly StoredFile[];
  /** The scope has more files than the limit; `files` holds the first ones. */
  readonly more: boolean;
  /** Full paths of files scheduled for deletion; they are in no file row, but are no orphans. */
  readonly scheduled: readonly string[];
  /** More files are scheduled than the limit allows; `scheduled` holds the first. */
  readonly moreScheduled: boolean;
  /** For a table or a schema: its directory (ending in `/`); null for the lake and for a table or schema without row. */
  readonly directory: string | null;
  /** For a table: files of other tables in its directory (e.g. a dropped table of the same name); no orphans. */
  readonly shared: readonly string[];
}

/** The scope of a health read: the whole lake (neither field), one table, or the tables of one schema. */
export interface HealthScopeRef {
  readonly tableId?: number;
  readonly schemaId?: number;
}

/** Read-only view of one DuckLake catalog; reads take a snapshot id (`info().latestSnapshot` for the current state). */
export interface CatalogReader {
  /** Validates that the database is a supported DuckLake catalog; throws `NOT_A_DUCKLAKE` / `UNSUPPORTED_VERSION`. */
  info(): Promise<CatalogInfo>;
  /** The snapshots, newest first: all of them, or the newest `limit`. */
  snapshots(limit?: number): Promise<SnapshotInfo[]>;
  schemas(snapshot: SnapshotId): Promise<SchemaInfo[]>;
  tables(schemaId: number, snapshot: SnapshotId): Promise<TableInfo[]>;
  /** The views of a schema; `null` reads those of every schema in one statement. */
  views(schemaId: number | null, snapshot: SnapshotId): Promise<ViewInfo[]>;
  /** Top-level columns of a table in table order, nested fields in `children`. */
  columns(tableId: number, snapshot: SnapshotId): Promise<ColumnInfo[]>;
  /** Every table and view of every schema. */
  entries(snapshot: SnapshotId): Promise<CatalogEntry[]>;
  /**
   * The columns and nested fields of every table by table id, read in one statement; each table's in the order of
   * `columns()`, a column before its fields.
   */
  columnEntries(snapshot: SnapshotId): Promise<Map<number, CatalogColumnEntry[]>>;
  /** Every row of `ducklake_metadata`, ordered as in `properties()`. */
  metadata(): Promise<MetadataEntry[]>;
  /** The number of snapshots, as in `properties()`. */
  snapshotCount(): Promise<number>;
  /** Info, metadata and snapshot summary in one; a caller that needs only a part reads that part. */
  properties(): Promise<CatalogProperties>;
  /** The files waiting for the cleanup of old files, as in `storage()`. A caller that has read `metadata()` hands it over (or the pending read), so that the options are not read twice. */
  scheduledForDeletion(
    metadata?: readonly MetadataEntry[] | PromiseLike<readonly MetadataEntry[]>,
  ): Promise<StorageInfo['scheduledForDeletion']>;
  /** The snapshots Expire Snapshots takes now, as in `storage()`; the same hand-over of `metadata` as `scheduledForDeletion`. */
  expirableSnapshots(
    metadata?: readonly MetadataEntry[] | PromiseLike<readonly MetadataEntry[]>,
  ): Promise<StorageInfo['expirableSnapshots']>;
  /** The files of the lake; with `scope` the data and delete files of its tables (the other figures stay the lake's). */
  storage(snapshot: SnapshotId, scope?: HealthScopeRef): Promise<StorageInfo>;
  /** Tables with data files below `SMALL_FILE_BYTES` at the snapshot, most small files first. */
  smallFiles(snapshot: SnapshotId, signal?: AbortSignal): Promise<SmallFileTable[]>;
  /**
   * File state of the whole lake, or of the tables in `scope`, after each snapshot up to `snapshot`, at most `limit`
   * points (older ones merge).
   */
  lakeGrowth(
    snapshot: SnapshotId,
    limit?: number,
    signal?: AbortSignal,
    scope?: HealthScopeRef,
  ): Promise<LakeGrowth>;
  /**
   * What each snapshot did to the live rows, bytes and files of each table; snapshots before `first` sum up as
   * `snapshot: null`. The sum up to a snapshot equals what `tables` reads.
   */
  growthChanges(first: SnapshotId, signal?: AbortSignal): Promise<GrowthChanges>;
  /**
   * The partitioning in force at the snapshot; undefined when the table is not partitioned then. `columns`, the
   * `columns()` of the same table and snapshot when already read, names the keys; without it they are read again.
   */
  partitioning(
    tableId: number,
    snapshot: SnapshotId,
    columns?: readonly ColumnInfo[],
  ): Promise<PartitioningInfo | undefined>;
  /** The sort order in force at the snapshot; undefined when the table is not sorted then. */
  sortOrder(tableId: number, snapshot: SnapshotId): Promise<SortOrderInfo | undefined>;
  /** `columns` names the tagged columns, as for `partitioning`. */
  tags(tableId: number, snapshot: SnapshotId, columns?: readonly ColumnInfo[]): Promise<TagsInfo>;
  /** Scalar and table macros of a schema, by name; `null` reads those of every schema in one statement. */
  macros(schemaId: number | null, snapshot: SnapshotId): Promise<MacroInfo[]>;
  /** The changes of one snapshot with their objects named; empty when the snapshot has no recorded changes. */
  snapshotChanges(snapshotId: SnapshotId): Promise<ResolvedChange[]>;
  /** The newest `limit` snapshots of the range (all without one) with resolved changes, read in a few statements. */
  snapshotActivity(
    limit?: number,
    range?: SnapshotRange,
    signal?: AbortSignal,
  ): Promise<SnapshotActivityPage>;
  /**
   * Snapshots at which a table or view exists, over all versions (a rename starts a new one). Undefined when the
   * catalog has no row for the id, e.g. after expiry.
   */
  lifetime(kind: 'table' | 'view', id: number): Promise<Lifetime | undefined>;
  /**
   * The tables, views and macros whose last version was in the schema and ended, newest drop first; only those with a
   * snapshot left at which they existed (a name dropped twice is two objects).
   */
  droppedObjects(schemaId: number): Promise<DroppedObject[]>;
  /**
   * Files, sizes, partitions, column statistics and growth of a table at a snapshot. The signal stops PostgreSQL,
   * DuckDB and Quack queries, not SQLite's.
   */
  tableStatistics(tableId: number, snapshot: SnapshotId, signal?: AbortSignal): Promise<TableStatistics>;
  /**
   * Counts the rows that break each check and returns the first `sampleLimit`; `snapshot` is the newest. With
   * `scope.tableId` only checks and rows that concern the table run.
   */
  consistency(
    scope: HealthScopeRef,
    snapshot: SnapshotId,
    sampleLimit: number,
    signal?: AbortSignal,
  ): Promise<ConsistencyReport>;
  /** Snapshot numbering gaps, tables with small files and inlined rows, at most `limit` entries per list. */
  maintenanceFacts(scope: HealthScopeRef, limit: number, signal?: AbortSignal): Promise<MaintenanceFacts>;
  /**
   * The tables of the scope with small data files that have a delete file at the newest state, at most `limit`, by
   * table id. A merge leaves these files alone, so the Merge script rewrites them first.
   */
  deletedSmallFiles(scope: HealthScopeRef, limit: number, signal?: AbortSignal): Promise<TableDeletedFiles[]>;
  /**
   * Tables with data files that have at least `floor` of their rows deleted (newest state), most first. `floor` and
   * `threshold` are shares 0 to 1; `threshold` is the one `ducklake_rewrite_data_files` applies.
   */
  deleteHeavyTables(
    scope: HealthScopeRef,
    floor: number,
    threshold: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<DeleteHeavyTable[]>;
  /**
   * Every data and delete file a snapshot still needs with its expected path, plus files scheduled for deletion; at
   * most `limit` each. Relative paths resolve against `dataPath`, the `data_path` of `metadata()`.
   */
  fileLocations(
    scope: HealthScopeRef,
    dataPath: string | null,
    limit: number,
    signal?: AbortSignal,
  ): Promise<FileLocations>;
  /**
   * The newest `limit` schema versions of a table: one per snapshot at which its name, a column or a column comment
   * began or ended.
   */
  schemaHistory(tableId: number, limit?: number, signal?: AbortSignal): Promise<SchemaHistory>;
  /** Id and name of every top-level column the table ever had. */
  columnHistory(
    tableId: number,
    signal?: AbortSignal,
  ): Promise<{ readonly id: number; readonly name: string }[]>;
  close(): Promise<void>;
}
