import { CLEANUP_OVERDUE_DAYS, SMALL_FILE_BYTES } from '../catalog/thresholds';
import type {
  ConsistencyCheck,
  ConsistencyProblem,
  ConsistencyReport,
  ConsistencySample,
  MaintenanceFacts,
  MetadataEntry,
  StorageInfo,
} from '../catalog/model';
import { groupedPlural } from '../shell/numbers';
import { scheduledLine, scheduledNote } from '../shell/scheduled-text';
import { autoCompactFindings } from './auto-compact';
import { ago, finding, listed, META, qualified, tableScope } from './finding';
import type { TableNames } from './finding';
import { CHECKS } from './model';
import type { CheckId, FindingScope, HealthFinding, HealthScope } from './model';

// More snapshots than this gets a hint to expire some.
const MANY_SNAPSHOTS = 10_000;

/** More inlined rows than this gets a hint to flush them to Parquet. */
export const LARGE_INLINED_ROWS = 10_000;

// At least this many small files (`SMALL_FILES` in `catalog/thresholds.ts`) gets a warning.
const SMALL_FILES_WARNING = 1_000;

const NAMED = 5;

export interface HealthCatalogFacts {
  readonly now: Date;
  readonly scope: HealthScope;
  readonly latest: number;
  readonly tables: TableNames;
  readonly specVersion: string;
  readonly dataPath: string | null;
  readonly snapshotCount: number;
  readonly consistency?: ConsistencyReport;
  readonly maintenance?: MaintenanceFacts;
  readonly scheduled?: StorageInfo['scheduledForDeletion'];
  readonly metadata?: readonly MetadataEntry[];
  /** The schemas of the newest snapshot by id. */
  readonly schemas?: ReadonlyMap<number, string>;
  /** Most findings reported per check. */
  readonly limit: number;
}

interface CatalogResult {
  readonly findings: readonly HealthFinding[];
  /** Findings left out because their check reached the limit. */
  readonly omitted: number;
  /** The catalog cut the list at the limit, so more may exist. */
  readonly truncated: boolean;
}

const KIND_TEXT: Record<ConsistencySample['kind'], string> = {
  'data-file': 'data file',
  'delete-file': 'delete file',
  table: 'table',
  view: 'view',
  partitioning: 'partitioning',
  'sort-order': 'sort order',
};

interface ProblemText {
  readonly check: CheckId;
  readonly title: string;
  readonly what: string;
  readonly cause: string;
  readonly fix: string;
  readonly sql: string;
  readonly value?: (value: number | null) => string;
}

const BACKUP =
  'Restore the catalog from a backup taken before the damage. Do not run Clean Up Old Files or Delete Orphaned Files first: the Parquet files may be the only copy of the data.';

const PROBLEMS: Record<ConsistencyCheck, ProblemText> = {
  'files-without-table': {
    check: 'catalog.files-without-table',
    title: 'File rows of the catalog belong to a table that does not exist',
    what: 'data or delete file rows name a table that has no row in ducklake_table',
    cause:
      'Rows of ducklake_table were deleted by hand, or a copy of the catalog lost them (partial restore, interrupted migration).',
    fix: BACKUP,
    sql: `SELECT f.* FROM ${META}.ducklake_data_file f WHERE NOT EXISTS (SELECT 1 FROM ${META}.ducklake_table t WHERE t.table_id = f.table_id);`,
  },
  'files-unknown-partitioning': {
    check: 'catalog.files-unknown-partitioning',
    title: 'Data files refer to a partitioning that does not exist',
    what: 'data files name a partition id that has no row in ducklake_partition_info',
    cause:
      'Rows of ducklake_partition_info were removed, or a copy of the catalog is incomplete. The files can still be read, but their partition values cannot be put in context.',
    fix: 'Check the partitioning with the Partitioning folder of the table and restore the catalog from a backup if rows are missing.',
    sql: `SELECT f.* FROM ${META}.ducklake_data_file f WHERE f.partition_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${META}.ducklake_partition_info p WHERE p.table_id = f.table_id AND p.partition_id = f.partition_id);`,
    value: (value) => `partition ${value}`,
  },
  'delete-files-without-data-file': {
    check: 'catalog.delete-files-without-data-file',
    title: 'Delete files refer to a data file that does not exist',
    what: 'delete files name a data file that has no row in ducklake_data_file',
    cause:
      'The row of the data file was removed (by hand, or by a partial restore) while its delete file stayed.',
    fix: BACKUP,
    sql: `SELECT d.* FROM ${META}.ducklake_delete_file d WHERE NOT EXISTS (SELECT 1 FROM ${META}.ducklake_data_file f WHERE f.data_file_id = d.data_file_id);`,
    value: (value) => `data file #${value}`,
  },
  'stats-without-column': {
    check: 'catalog.stats-without-column',
    title: 'File statistics refer to a column that the table does not have',
    what: 'statistics rows name a column that has no row in ducklake_column',
    cause:
      'A writer dropped a column without removing its statistics, or rows of ducklake_column are missing.',
    fix: 'Reading is not affected as long as the column rows exist for the columns you query. If columns are missing, restore the catalog from a backup.',
    sql: `SELECT s.* FROM ${META}.ducklake_file_column_stats s WHERE NOT EXISTS (SELECT 1 FROM ${META}.ducklake_column c WHERE c.table_id = s.table_id AND c.column_id = s.column_id);`,
    value: (value) => `column #${value}`,
  },
  'partition-values-without-partitioning': {
    check: 'catalog.partition-values-without-partitioning',
    title: 'Partition values belong to a file that has no partitioning',
    what: 'partition values name a data file that has no partition id or does not exist',
    cause:
      'A writer wrote partition values for a file but not its partition id, or the data file was removed without them.',
    fix: 'Ask the author of the writer. Rewriting the data files of the table (Rewrite Data Files) does not remove these rows.',
    sql: `SELECT v.* FROM ${META}.ducklake_file_partition_value v LEFT JOIN ${META}.ducklake_data_file f ON f.data_file_id = v.data_file_id WHERE f.data_file_id IS NULL OR f.partition_id IS NULL;`,
    value: (value) => `key ${value}`,
  },
  'partition-columns-without-partitioning': {
    check: 'catalog.partition-columns-without-partitioning',
    title: 'Partition columns belong to a partitioning that does not exist',
    what: 'partition columns name a partitioning that has no row in ducklake_partition_info',
    cause:
      'Rows of ducklake_partition_info were removed, or a writer left the columns of a dropped partitioning.',
    fix: 'Set the partitioning again with ALTER TABLE ... SET PARTITIONED BY, or restore the catalog from a backup.',
    sql: `SELECT c.* FROM ${META}.ducklake_partition_column c WHERE NOT EXISTS (SELECT 1 FROM ${META}.ducklake_partition_info p WHERE p.table_id = c.table_id AND p.partition_id = c.partition_id);`,
    value: (value) => `column #${value}`,
  },
  'sort-expressions-without-sort-order': {
    check: 'catalog.sort-expressions-without-sort-order',
    title: 'Sort expressions belong to a sort order that does not exist',
    what: 'sort expressions name a sort order that has no row in ducklake_sort_info',
    cause:
      'Rows of ducklake_sort_info were removed, or a writer left the expressions of a dropped sort order.',
    fix: 'Set the sort order again with ALTER TABLE ... SET SORTED BY, or restore the catalog from a backup.',
    sql: `SELECT e.* FROM ${META}.ducklake_sort_expression e WHERE NOT EXISTS (SELECT 1 FROM ${META}.ducklake_sort_info i WHERE i.table_id = e.table_id AND i.sort_id = e.sort_id);`,
    value: (value) => `key ${value}`,
  },
  'tables-without-schema': {
    check: 'catalog.tables-without-schema',
    title: 'Tables belong to a schema that does not exist',
    what: 'tables name a schema that has no row in ducklake_schema',
    cause: 'Rows of ducklake_schema were deleted by hand, or a copy of the catalog lost them.',
    fix: BACKUP,
    sql: `SELECT t.* FROM ${META}.ducklake_table t WHERE NOT EXISTS (SELECT 1 FROM ${META}.ducklake_schema s WHERE s.schema_id = t.schema_id);`,
    value: (value) => `schema #${value}`,
  },
  'views-without-schema': {
    check: 'catalog.views-without-schema',
    title: 'Views belong to a schema that does not exist',
    what: 'views name a schema that has no row in ducklake_schema',
    cause: 'Rows of ducklake_schema were deleted by hand, or a copy of the catalog lost them.',
    fix: BACKUP,
    sql: `SELECT v.* FROM ${META}.ducklake_view v WHERE NOT EXISTS (SELECT 1 FROM ${META}.ducklake_schema s WHERE s.schema_id = v.schema_id);`,
    value: (value) => `schema #${value}`,
  },
  'tables-without-columns': {
    check: 'catalog.tables-without-columns',
    title: 'Tables of the newest snapshot have no column',
    what: 'tables have no column at the newest snapshot',
    cause: 'Rows of ducklake_column were deleted by hand, or a writer ended all columns of a table.',
    fix: BACKUP,
    sql: `SELECT t.* FROM ${META}.ducklake_table t WHERE t.end_snapshot IS NULL AND NOT EXISTS (SELECT 1 FROM ${META}.ducklake_column c WHERE c.table_id = t.table_id AND c.end_snapshot IS NULL);`,
  },
  'negative-counts': {
    check: 'catalog.negative-counts',
    title: 'Files have a negative row count or size',
    what: 'data or delete files have a negative count or size',
    cause: 'A writer stored a wrong number (an overflow, a failed upload that was recorded).',
    fix: 'Ask the author of the writer. The numbers feed the sizes and row counts of the tree and the statistics; a Parquet file of that name may have to be read with the Deep check.',
    sql: `SELECT 'data' AS kind, data_file_id AS file_id, record_count, file_size_bytes FROM ${META}.ducklake_data_file WHERE record_count < 0 OR file_size_bytes < 0 UNION ALL SELECT 'delete', delete_file_id, delete_count, file_size_bytes FROM ${META}.ducklake_delete_file WHERE delete_count < 0 OR file_size_bytes < 0;`,
    value: (value) => `count ${value}`,
  },
  'delete-count-over-records': {
    check: 'catalog.delete-count-over-records',
    title: 'Delete files delete more rows than their data file holds',
    what: 'delete files list more deleted rows than their data file has rows',
    cause: 'The delete file or the record count of the data file is wrong (a writer bug or a damaged copy).',
    fix: 'The row counts of the table are wrong until this is fixed. Ask the author of the writer, or restore the catalog from a backup.',
    sql: `SELECT d.delete_file_id, d.data_file_id, d.delete_count, f.record_count FROM ${META}.ducklake_delete_file d JOIN ${META}.ducklake_data_file f ON f.data_file_id = d.data_file_id WHERE d.delete_count > f.record_count;`,
    value: (value) => `${value} deleted rows`,
  },
  'files-without-size': {
    check: 'catalog.files-without-size',
    title: 'Files have no size in the catalog',
    what: 'data or delete files have no size or a size of zero',
    cause: 'A writer did not record the size of the file (the field is optional for some writers).',
    fix: 'The sizes of the tree and the statistics are too small. The storage check cannot compare these files by size.',
    sql: `SELECT 'data' AS kind, data_file_id AS file_id, file_size_bytes FROM ${META}.ducklake_data_file WHERE file_size_bytes IS NULL OR file_size_bytes <= 0 UNION ALL SELECT 'delete', delete_file_id, file_size_bytes FROM ${META}.ducklake_delete_file WHERE file_size_bytes IS NULL OR file_size_bytes <= 0;`,
    value: (value) => `size ${value ?? 'NULL'}`,
  },
  'snapshot-range-invalid': {
    check: 'catalog.snapshot-range-invalid',
    title: 'Files are valid for an impossible range of snapshots',
    what: 'data or delete files end before they begin, or begin after the newest snapshot',
    cause: 'A writer committed with a wrong snapshot id, or rows were edited by hand.',
    fix: 'Time travel and the newest state may show the wrong files. Ask the author of the writer, or restore the catalog from a backup.',
    sql: `SELECT 'data' AS kind, data_file_id AS file_id, begin_snapshot, end_snapshot FROM ${META}.ducklake_data_file WHERE end_snapshot < begin_snapshot OR begin_snapshot > (SELECT MAX(snapshot_id) FROM ${META}.ducklake_snapshot) UNION ALL SELECT 'delete', delete_file_id, begin_snapshot, end_snapshot FROM ${META}.ducklake_delete_file WHERE end_snapshot < begin_snapshot OR begin_snapshot > (SELECT MAX(snapshot_id) FROM ${META}.ducklake_snapshot);`,
    value: (value) => `begins at snapshot @${value}`,
  },
  'row-ids-overlap': {
    check: 'catalog.row-ids-overlap',
    title: 'Data files of a table claim the same row ids',
    what: 'data files of the newest state start at a row id that an earlier file already covers',
    cause:
      'Two writers wrote to the table without seeing each other, or a file was added twice. Row ids identify rows for deletes and for the change feed.',
    fix: 'Deletes and Show Changes may hit the wrong rows. Ask the author of the writers, or restore the catalog from a backup.',
    sql: `SELECT table_id, data_file_id, row_id_start, record_count FROM ${META}.ducklake_data_file WHERE end_snapshot IS NULL AND row_id_start IS NOT NULL ORDER BY table_id, row_id_start;`,
    value: (value) => `row ids reach ${value}`,
  },
};

export function catalogFindings(facts: HealthCatalogFacts): CatalogResult {
  const small = smallFileFindings(facts);
  const inlined = largeInlinedFindings(facts);
  const compact = autoCompactFindings({
    metadata: facts.metadata ?? [],
    schemas: facts.schemas ?? new Map(),
    tables: facts.tables,
    scope: facts.scope,
    limit: facts.limit,
  });
  return {
    findings: [
      ...specFindings(facts),
      ...(facts.consistency?.problems ?? []).map((problem) => problemFinding(problem, facts)),
      ...snapshotFindings(facts),
      ...small.findings,
      ...inlined.findings,
      ...compact.findings,
    ],
    omitted: small.omitted + inlined.omitted + compact.omitted,
    truncated: small.truncated || facts.maintenance?.inlinedMore === true,
  };
}

function specFindings(facts: HealthCatalogFacts): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const newer = /^1\.(\d+)$/.exec(facts.specVersion);
  if (newer && Number(newer[1]) > 1) {
    findings.push(
      finding('catalog.spec-version-newer', {
        severity: 'info',
        scope: { kind: 'lake' },
        title: `The catalog is written for DuckLake specification ${facts.specVersion}, newer than the 1.0 and 1.1 that aantje was tested with`,
        detail: `ducklake_metadata.version is ${facts.specVersion}. aantje reads every 1.x catalog.`,
        cause: 'The catalog was created or migrated by a newer DuckLake extension.',
        fix: 'Nothing to do now. If a read or a check fails, update aantje.',
        inspectSql: `SELECT * FROM ${META}.ducklake_metadata WHERE key = 'version';`,
      }),
    );
  }
  if (facts.dataPath === null || facts.dataPath === '') {
    findings.push(
      finding('catalog.data-path-missing', {
        severity: 'error',
        scope: { kind: 'lake' },
        title: 'The catalog has no data path',
        detail:
          'ducklake_metadata has no global entry data_path, so DuckLake does not know where the data files are.',
        cause: 'The catalog was never attached with a DATA_PATH, or the entry was deleted.',
        fix: "Attach the lake once with ATTACH ... (DATA_PATH 's3://bucket/prefix/') in a writable session, or restore the entry.",
        inspectSql: `SELECT * FROM ${META}.ducklake_metadata WHERE key = 'data_path';`,
      }),
    );
  }
  return findings;
}

// Gaps, count and pending cleanup concern the whole lake: a schema report shows them as lake findings, a table report has none.
function snapshotFindings(facts: HealthCatalogFacts): HealthFinding[] {
  if (facts.scope.kind === 'table') return [];
  const findings: HealthFinding[] = [];
  const gaps = facts.maintenance?.snapshotGaps;
  if (gaps && gaps.count > 0) findings.push(snapshotGapsFinding(gaps));
  if (facts.snapshotCount > MANY_SNAPSHOTS) findings.push(manySnapshotsFinding(facts.snapshotCount));
  const { scheduled } = facts;
  if (scheduled && scheduled.count > 0) findings.push(cleanupFinding(scheduled, facts.now));
  return findings;
}

function snapshotGapsFinding({ count, missing, first }: MaintenanceFacts['snapshotGaps']): HealthFinding {
  const ranges = first.map(({ after, next }) =>
    next - after === 2 ? `@${after + 1}` : `@${after + 1} to @${next - 1}`,
  );
  return finding('catalog.snapshot-gaps', {
    severity: 'info',
    scope: { kind: 'lake' },
    title: 'Snapshots between the first and the newest one no longer exist',
    detail: `${groupedPlural(missing, 'snapshot id')} missing in ${groupedPlural(count, 'gap')}: ${listed(ranges, NAMED)}. Time travel to them is not possible.`,
    cause: 'Expire Snapshots removed them. That is normal after maintenance.',
    fix: 'Nothing to do. If you did not expire snapshots, find out who did.',
    inspectSql: `SELECT snapshot_id, snapshot_time FROM ${META}.ducklake_snapshot ORDER BY snapshot_id;`,
  });
}

function manySnapshotsFinding(snapshotCount: number): HealthFinding {
  return finding('catalog.many-snapshots', {
    severity: 'info',
    scope: { kind: 'lake' },
    title: 'The catalog holds a very large number of snapshots',
    detail: `${groupedPlural(snapshotCount, 'snapshot')} (more than ${MANY_SNAPSHOTS.toLocaleString('en-US')}). Reads of the catalog and the history get slower with every snapshot, and the files they need stay in the store.`,
    cause: 'Snapshots are not expired by themselves.',
    fix: 'Open Expire Snapshots in the Maintenance menu, read its dry run, and run Clean Up Old Files after it.',
    inspectSql: `SELECT count(*), min(snapshot_time), max(snapshot_time) FROM ${META}.ducklake_snapshot;`,
  });
}

// Rows of several tables: the schema of a schema report, else the lake.
function widerScope({ scope, schemas }: HealthCatalogFacts): FindingScope {
  return scope.kind === 'schema'
    ? { kind: 'schema', id: scope.schemaId, name: schemas?.get(scope.schemaId) ?? `#${scope.schemaId}` }
    : { kind: 'lake' };
}

function problemFinding(problem: ConsistencyProblem, facts: HealthCatalogFacts): HealthFinding {
  const text = PROBLEMS[problem.check];
  const tables = new Set(problem.samples.map((sample) => sample.tableId));
  const only = facts.scope.kind === 'table' ? facts.scope.tableId : tables.size === 1 ? [...tables][0] : null;
  const scope: FindingScope =
    only === null || only === undefined ? widerScope(facts) : tableScope(only, facts.tables);
  const samples = problem.samples.map((sample) => {
    const value = text.value ? `, ${text.value(sample.value)}` : '';
    if (sample.kind === 'table') {
      return `${qualified(tableScope(sample.id, facts.tables))}${value}`;
    }
    const table = sample.tableId === null ? '' : ` of ${qualified(tableScope(sample.tableId, facts.tables))}`;
    return `${KIND_TEXT[sample.kind]} #${sample.id}${table}${value}`;
  });
  const cut =
    problem.count > problem.samples.length
      ? ` (the first ${problem.samples.length} of ${problem.count})`
      : '';
  return finding(text.check, {
    severity: CHECKS[text.check].severities[0],
    scope,
    title: text.title,
    detail: `${groupedPlural(problem.count, 'row')}: ${text.what}${cut}. ${listed(samples, NAMED)}.`,
    cause: text.cause,
    fix: text.fix,
    inspectSql: text.sql,
  });
}

function cleanupFinding(scheduled: StorageInfo['scheduledForDeletion'], now: Date): HealthFinding {
  const since = scheduled.oldestScheduledAt === null ? NaN : Date.parse(scheduled.oldestScheduledAt);
  const waited = Number.isNaN(since) ? 0 : now.getTime() - since;
  const overdue = waited > CLEANUP_OVERDUE_DAYS * 86_400_000;
  const when =
    scheduled.oldestScheduledAt === null
      ? ''
      : ` The oldest has waited since ${scheduled.oldestScheduledAt} (${ago(waited)}).`;
  const note = scheduledNote(scheduled);
  return finding(overdue ? 'catalog.cleanup-overdue' : 'catalog.cleanup-pending', {
    severity: overdue ? 'warning' : 'info',
    scope: { kind: 'lake' },
    title: overdue
      ? 'Files that maintenance replaced have been waiting for the cleanup for more than a week'
      : 'Files that maintenance replaced are waiting for the cleanup',
    detail: `${scheduledLine(scheduled)} (table ducklake_files_scheduled_for_deletion).${when} They take space in the store and nothing reads them.${note === '' ? '' : ` ${note}`}`,
    cause:
      'Expire Snapshots, a merge or a rewrite scheduled them; DuckLake deletes them only when Clean Up Old Files runs.',
    fix: 'Open Clean Up Old Files in the Maintenance menu, read its dry run and run the real call. Schedule it if it should happen regularly.',
    inspectSql: `SELECT * FROM ${META}.ducklake_files_scheduled_for_deletion ORDER BY schedule_start;`,
  });
}

function smallFileFindings(facts: HealthCatalogFacts): {
  findings: HealthFinding[];
  omitted: number;
  truncated: boolean;
} {
  const tables = facts.maintenance?.smallFiles ?? [];
  const shown = tables.slice(0, facts.limit);
  return {
    findings: shown.map(({ tableId, files, small }) => {
      const scope = tableScope(tableId, facts.tables);
      const heavy = small >= SMALL_FILES_WARNING;
      return finding('catalog.small-files', {
        severity: heavy ? 'warning' : 'info',
        scope,
        object: `table:${tableId}`,
        title: heavy
          ? 'The table is made of a very large number of small files'
          : 'Most files of the table are small',
        detail: `${small.toLocaleString('en-US')} of its ${groupedPlural(files, 'data file')} ${small === 1 ? 'is' : 'are'} below ${SMALL_FILE_BYTES / 1024 / 1024} MiB (${Math.round((small / files) * 100)} %). The thresholds are those of the statistics report.`,
        cause: 'Many small inserts or streaming appends each write a file of their own.',
        fix: `Open Merge Adjacent Files for ${qualified(scope)} in the Maintenance menu, run it, then Clean Up Old Files.`,
        inspectSql: `SELECT count(*) AS files, count(*) FILTER (WHERE file_size_bytes < ${SMALL_FILE_BYTES}) AS small FROM ${META}.ducklake_data_file WHERE table_id = ${tableId} AND end_snapshot IS NULL;`,
      });
    }),
    omitted: tables.length - shown.length,
    // The catalog is asked for one table more than reported; getting it means the list was cut.
    truncated: (facts.maintenance?.smallFiles.length ?? 0) > facts.limit,
  };
}

function largeInlinedFindings(facts: HealthCatalogFacts): { findings: HealthFinding[]; omitted: number } {
  const tables = (facts.maintenance?.inlined ?? []).filter(({ rows }) => rows > LARGE_INLINED_ROWS);
  const shown = tables.slice(0, facts.limit);
  return {
    findings: shown.map(({ tableId, rows }) => {
      const scope = tableScope(tableId, facts.tables);
      return finding('catalog.large-inlined-data', {
        severity: 'info',
        scope,
        object: `table:${tableId}`,
        title: 'A large amount of data is kept inside the catalog',
        detail: `${groupedPlural(rows, 'row')} of ${qualified(scope)} are inlined in the catalog database (more than ${LARGE_INLINED_ROWS.toLocaleString('en-US')}), not in Parquet files.`,
        cause:
          'Small inserts stay in the catalog while they are below the inlining row limit of the table; nothing writes them out by itself.',
        fix: `Open Flush Inlined Data for ${qualified(scope)} in the Maintenance menu and run it.`,
        inspectSql: `SELECT * FROM ${META}.ducklake_inlined_data_tables WHERE table_id = ${tableId};`,
      });
    }),
    omitted: tables.length - shown.length,
  };
}
