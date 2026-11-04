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
  FileLocations,
  HealthScopeRef,
  MaintenanceFacts,
  SmallFileTable,
  StoredFile,
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

// Inlined rows per table, summed over the inlined tables of its schema versions.
async function inlinedRowsPerTable(
  attempt: Attempt,
  scope: HealthScopeRef,
  limit: number,
  signal?: AbortSignal,
): Promise<{ inlined: { tableId: number; rows: number }[]; more: boolean }> {
  const rows = new Map<number, number>();
  // One extra table tells whether the list was cut.
  const found = (await attempt(queries.inlinedTables(scope, limit + 1), signal)) ?? [];
  for (const table of found.slice(0, limit)) {
    const name = toText(table.table_name);
    // The name is part of the statement: only names DuckLake writes are used.
    if (!queries.INLINED_TABLE.test(name)) continue;
    const count = await attempt(queries.inlinedRows(name), signal);
    const id = toNumber(table.table_id);
    rows.set(id, (rows.get(id) ?? 0) + toNumber(count?.[0]?.row_count ?? 0));
  }
  return {
    inlined: [...rows].filter(([, count]) => count > 0).map(([id, count]) => ({ tableId: id, rows: count })),
    more: found.length > limit,
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

type MaintenanceReads = Pick<
  CatalogReader,
  'smallFiles' | 'consistency' | 'maintenanceFacts' | 'deleteHeavyTables' | 'fileLocations'
>;

/** Reads for the health check and maintenance advisor: consistency, small and delete-heavy files, file locations. */
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
      const [gaps, small, { inlined, more }] = await Promise.all([
        scope.tableId === undefined ? attempt(queries.snapshotGaps(limit), signal) : [],
        attempt(queries.smallFileTables(scope, limit), signal),
        inlinedRowsPerTable(attempt, scope, limit, signal),
      ]);
      return {
        snapshotGaps: {
          count: toNumber(gaps?.[0]?.total ?? 0),
          missing: toNumber(gaps?.[0]?.missing ?? 0),
          first: (gaps ?? []).map((row) => ({ after: toNumber(row.after_id), next: toNumber(row.next_id) })),
        },
        smallFiles: (small ?? []).map((row) => ({
          tableId: toNumber(row.table_id),
          files: toNumber(row.file_count),
          small: toNumber(row.small_count),
          smallBytes: toNumber(row.small_bytes),
        })),
        inlined,
        ...(more ? { inlinedMore: true as const } : {}),
      };
    },

    async deleteHeavyTables(scope, floor, threshold, limit, signal): Promise<DeleteHeavyTable[]> {
      const basisPoints = (share: number): number => Math.round(share * 10_000);
      const rows = await attempt(
        queries.deleteHeavyTables(scope, basisPoints(floor), basisPoints(threshold), limit),
        signal,
      );
      return (rows ?? []).map((row) => ({
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
