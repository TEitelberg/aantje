import type { Row, Value } from '../drivers/driver';
import { fileLocation, joinPath, schemaDirectory, tableDirectory } from '../locations';
import type { StoredPath } from '../locations';
import { CONSISTENCY_CHECKS } from '../model';
import type {
  CatalogReader,
  ConsistencyProblem,
  ConsistencyReport,
  ConsistencySample,
  DeleteHeavyTable,
  DeletedFiles,
  FileLocations,
  HealthScopeRef,
  MaintenanceFacts,
  SmallFileTable,
  StoredFile,
  TableDeletedFiles,
} from '../model';
import * as queries from '../queries/maintenance';
import { toBoolean, toNumber, toNumberOrNull, toText, toTextOrNull } from './rows';
import type { Attempt, Run } from './rows';

function consistencySample(row: Row): ConsistencySample {
  return {
    tableId: toNumberOrNull(row.table_id),
    // The statements write one of these words.
    kind: toText(row.kind) as ConsistencySample['kind'],
    id: toNumber(row.id),
    value: toNumberOrNull(row.value),
  };
}

/**
 * The first `limit` inlined tables of the scope (one per table and schema version) and whether the catalog has more;
 * undefined when the list cannot be read. Only names that DuckLake writes are kept: the name is part of the statements
 * that read them.
 */
export async function readInlinedTables(
  attempt: Attempt,
  scope: HealthScopeRef,
  limit: number,
  signal?: AbortSignal,
): Promise<{ tables: queries.InlinedTable[]; more: boolean } | undefined> {
  // One extra table tells whether the list was cut.
  const found = await attempt(queries.inlinedTables(scope, limit + 1), signal);
  return (
    found && {
      tables: found
        .slice(0, limit)
        .map((row) => ({ tableId: toNumber(row.table_id), name: toText(row.table_name) }))
        .filter(({ name }) => queries.INLINED_TABLE.test(name)),
      more: found.length > limit,
    }
  );
}

// The still valid rows of the inlined tables in one statement. A table that the list names but that is gone fails it:
// then each table is counted alone, and only those that fail are left out.
async function countInlined(
  attempt: Attempt,
  tables: readonly queries.InlinedTable[],
  signal?: AbortSignal,
): Promise<{ counts: Row[]; failed: boolean }> {
  if (tables.length === 0) return { counts: [], failed: false };
  const all = await attempt(queries.inlinedRows(tables), signal);
  if (all) return { counts: all, failed: false };
  // A single table has just failed on its own.
  if (tables.length === 1) return { counts: [], failed: true };
  const counts: Row[] = [];
  let failed = false;
  for (const table of tables) {
    const one = await attempt(queries.inlinedRows([table]), signal);
    if (one) counts.push(...one);
    else failed = true;
  }
  return { counts, failed };
}

// Inlined rows per table, summed over the inlined tables of its schema versions; `failed` when some were not counted.
async function inlinedRowsPerTable(
  attempt: Attempt,
  scope: HealthScopeRef,
  limit: number,
  signal?: AbortSignal,
): Promise<{ inlined: { tableId: number; rows: number }[]; more: boolean; failed: boolean }> {
  const listed = await readInlinedTables(attempt, scope, limit, signal);
  const { counts, failed } = await countInlined(attempt, listed?.tables ?? [], signal);
  const rows = new Map<number, number>();
  for (const row of counts) {
    const id = toNumber(row.table_id);
    rows.set(id, (rows.get(id) ?? 0) + toNumber(row.row_count));
  }
  return {
    inlined: [...rows].filter(([, count]) => count > 0).map(([id, count]) => ({ tableId: id, rows: count })),
    more: listed?.more === true,
    failed: failed || listed === undefined,
  };
}

const stored = (path: Value | undefined, relative: Value | undefined): StoredPath => ({
  path: toText(path),
  relative: toBoolean(relative),
});

// Undefined when the schema or table has no row, so its files cannot be placed.
function levels(row: Row | undefined): { schema: StoredPath; table: StoredPath } | undefined {
  return row && row.table_path !== null && row.schema_path !== null
    ? {
        schema: stored(row.schema_path, row.schema_relative),
        table: stored(row.table_path, row.table_relative),
      }
    : undefined;
}

// Null when the data path or the table or schema row is missing.
function locationOf(dataPath: string | null, row: Row): string | null {
  const paths = levels(row);
  return dataPath !== null && paths
    ? fileLocation(dataPath, paths.schema, paths.table, stored(row.path, row.path_is_relative))
    : null;
}

function storedFile(dataPath: string | null, row: Row): StoredFile {
  return {
    kind: row.kind === 'delete' ? 'delete' : 'data',
    id: toNumber(row.file_id),
    tableId: toNumber(row.table_id),
    schema: toTextOrNull(row.schema_name ?? null),
    table: toTextOrNull(row.table_name ?? null),
    beginSnapshot: toNumber(row.begin_snapshot),
    endSnapshot: toNumberOrNull(row.end_snapshot),
    location: locationOf(dataPath, row),
    sizeBytes: toNumberOrNull(row.file_size_bytes),
    records: toNumberOrNull(row.records),
    encrypted: toNumber(row.encrypted) === 1,
    format: toText(row.format),
  };
}

// The directory of the table or, for a schema scope, of the schema; null when its rows are missing.
function directoryOf(
  dataPath: string | null,
  table: ReturnType<typeof levels>,
  schema: Row | undefined,
): string | null {
  if (dataPath === null) return null;
  if (table) return tableDirectory(dataPath, table.schema, table.table);
  return schema ? schemaDirectory(dataPath, stored(schema.schema_path, schema.schema_relative)) : null;
}

const deletedFiles = (row: Row): DeletedFiles => ({
  small: toNumber(row.deleted_small),
  files: toNumber(row.deleted_files),
  bytes: toNumber(row.deleted_bytes),
});

const NO_DELETED_FILES: DeletedFiles = { small: 0, files: 0, bytes: 0 };

// PostgreSQL gives a sum beyond 2^53 as text; the other drivers refuse it, and the statement fails.
const isCount = (value: Value | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function countsOrNull(row: Row): DeletedFiles | null {
  const [small, files, bytes] = [row.deleted_small, row.deleted_files, row.deleted_bytes];
  return isCount(small) && isCount(files) && isCount(bytes) ? { small, files, bytes } : null;
}

// The tables of small files, then their files with a delete file in a statement of their own: a broken size there
// costs only those figures, which become null, and never the tables.
async function smallFileTables(
  { run, attempt }: { readonly run: Run; readonly attempt: Attempt },
  scope: HealthScopeRef,
  limit: number,
  signal?: AbortSignal,
): Promise<MaintenanceFacts['smallFiles']> {
  const tables = await run(queries.smallFileTables(scope, limit), signal);
  const ids = tables.map((row) => toNumber(row.table_id));
  const deleted = ids.length === 0 ? [] : await attempt(queries.tableDeletedFiles(ids), signal);
  const byTable = new Map((deleted ?? []).map((row) => [toNumber(row.table_id), countsOrNull(row)]));
  const deletedOf = (tableId: number): DeletedFiles | null => {
    if (deleted === undefined) return null;
    const found = byTable.get(tableId);
    return found === undefined ? NO_DELETED_FILES : found;
  };
  return tables.map((row) => {
    const tableId = toNumber(row.table_id);
    return {
      tableId,
      files: toNumber(row.file_count),
      small: toNumber(row.small_count),
      smallBytes: toNumber(row.small_bytes),
      deleted: deletedOf(tableId),
    };
  });
}

type MaintenanceReads = Pick<
  CatalogReader,
  | 'smallFiles'
  | 'consistency'
  | 'maintenanceFacts'
  | 'deletedSmallFiles'
  | 'deleteHeavyTables'
  | 'fileLocations'
>;

/**
 * Reads for the health check, the maintenance advisor and the Merge script: consistency, small and delete-heavy files,
 * file locations.
 */
export function maintenanceReads(run: Run, attempt: Attempt): MaintenanceReads {
  return {
    async smallFiles(snapshot, signal): Promise<SmallFileTable[]> {
      return (await run(queries.smallFilesAt(snapshot), signal))
        .map((row) => ({
          tableId: toNumber(row.table_id),
          files: toNumber(row.file_count),
          small: toNumber(row.small_count),
        }))
        .toSorted((a, b) => b.small - a.small || a.tableId - b.tableId);
    },

    async consistency(scope, snapshot, sampleLimit, signal): Promise<ConsistencyReport> {
      const limit = Math.max(1, Math.trunc(sampleLimit));
      const results = await Promise.all(
        CONSISTENCY_CHECKS.map(async (check) => {
          const query = queries.consistency(check, snapshot, scope, limit);
          return {
            check,
            applies: query !== undefined,
            rows: query ? await attempt(query, signal) : undefined,
          };
        }),
      );
      return {
        problems: results.flatMap(({ check, rows }): ConsistencyProblem[] =>
          rows?.[0] ? [{ check, count: toNumber(rows[0].total), samples: rows.map(consistencySample) }] : [],
        ),
        unavailable: results.flatMap(({ check, applies, rows }) =>
          applies && rows === undefined ? [check] : [],
        ),
      };
    },

    async maintenanceFacts(scope, limit, signal): Promise<MaintenanceFacts> {
      // The file and snapshot tables are in every catalog: a failed statement there fails the read.
      const [gaps, smallFiles, { inlined, more, failed }] = await Promise.all([
        scope.tableId === undefined ? run(queries.snapshotGaps(limit), signal) : [],
        smallFileTables({ run, attempt }, scope, limit, signal),
        inlinedRowsPerTable(attempt, scope, limit, signal),
      ]);
      return {
        snapshotGaps: {
          count: toNumber(gaps[0]?.total ?? 0),
          missing: toNumber(gaps[0]?.missing ?? 0),
          first: gaps.map((row) => ({ after: toNumber(row.after_id), next: toNumber(row.next_id) })),
        },
        smallFiles,
        inlined,
        ...(more ? { inlinedMore: true as const } : {}),
        ...(failed ? { inlinedFailed: true as const } : {}),
      };
    },

    async deletedSmallFiles(scope, limit, signal): Promise<TableDeletedFiles[]> {
      return (await run(queries.deletedSmallFiles(scope, limit), signal)).map((row) => ({
        tableId: toNumber(row.table_id),
        schema: toText(row.schema_name),
        table: toText(row.table_name),
        ...deletedFiles(row),
      }));
    },

    async deleteHeavyTables(scope, floor, threshold, limit, signal): Promise<DeleteHeavyTable[]> {
      const basisPoints = (share: number): number => Math.round(share * 10_000);
      const rows = await run(
        queries.deleteHeavyTables(scope, basisPoints(floor), basisPoints(threshold), limit),
        signal,
      );
      return rows.map((row) => ({
        tableId: toNumber(row.table_id),
        files: toNumber(row.heavy_files),
        atThreshold: toNumber(row.threshold_files),
        records: toNumber(row.records),
        deleted: toNumber(row.deleted),
        sizeBytes: toNumber(row.size_bytes),
      }));
    },

    async fileLocations(scope, dataPath, limit, signal): Promise<FileLocations> {
      const [rows, scheduled, table, shared, schema] = await Promise.all([
        run(queries.storedFiles(scope, limit + 1), signal),
        attempt(queries.scheduledFiles(limit + 1), signal),
        scope.tableId === undefined ? undefined : run(queries.tableLocation(scope.tableId), signal),
        scope.tableId === undefined ? [] : run(queries.sharedFiles(scope.tableId, limit), signal),
        scope.schemaId === undefined ? undefined : run(queries.schemaLocation(scope.schemaId), signal),
      ]);
      const paths = levels(table?.[0]);
      return {
        dataPath,
        files: rows.slice(0, limit).map((row) => storedFile(dataPath, row)),
        more: rows.length > limit,
        scheduled: (scheduled ?? []).slice(0, limit).flatMap((row) => {
          if (!toBoolean(row.path_is_relative)) return [toText(row.path)];
          return dataPath === null ? [] : [joinPath(dataPath, toText(row.path))];
        }),
        moreScheduled: (scheduled?.length ?? 0) > limit,
        directory: directoryOf(dataPath, paths, schema?.[0]),
        shared: shared.flatMap((row) => locationOf(dataPath, row) ?? []),
      };
    },
  };
}
