import { queryCancelled } from '../catalog/drivers/limits';
import type { CatalogReader, SchemaInfo, SnapshotId, TableInfo } from '../catalog/model';
import { SMALL_FILE_BYTES } from '../catalog/thresholds';
import { GROWTH_POINT_LIMIT } from '../catalog/statistics';
import { LAKE_SCOPE } from '../shell/scope';
import type { ReportScope } from '../shell/scope';
import { DEFAULT_SORT, TABLE_LIMIT, sortedTables } from './model';
import type { StorageData, StorageTable } from './model';

// Schemas whose tables are read at the same time: a lake can have hundreds of schemas.
const READ_AT_ONCE = 4;

export type StorageReader = Pick<
  CatalogReader,
  'schemas' | 'tables' | 'storage' | 'smallFiles' | 'lakeGrowth'
>;

const stopped = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw queryCancelled();
  }
};

async function allTables(
  reader: Pick<CatalogReader, 'schemas' | 'tables'>,
  snapshot: SnapshotId,
  scope: ReportScope,
  signal: AbortSignal | undefined,
): Promise<{ schema: SchemaInfo; table: TableInfo }[]> {
  const schemas = (await reader.schemas(snapshot)).filter(
    ({ id }) => scope.kind === 'lake' || id === scope.id,
  );
  const result: { schema: SchemaInfo; table: TableInfo }[] = [];
  for (let start = 0; start < schemas.length; start += READ_AT_ONCE) {
    stopped(signal);
    const batch = await Promise.all(
      schemas
        .slice(start, start + READ_AT_ONCE)
        .map(async (schema) =>
          (await reader.tables(schema.id, snapshot)).map((table) => ({ schema, table })),
        ),
    );
    result.push(...batch.flat());
  }
  return result;
}

/** The totals, every table with size and small files, and the growth of the lake or schema at the snapshot the tree shows. */
export async function readStorage(
  reader: StorageReader,
  connection: string,
  snapshot: SnapshotId,
  now: Date,
  signal?: AbortSignal,
  scope: ReportScope = LAKE_SCOPE,
): Promise<StorageData> {
  const scopeRef = scope.kind === 'schema' ? { schemaId: scope.id } : {};
  const [storage, found, small, lake] = await Promise.all([
    reader.storage(snapshot, scopeRef),
    allTables(reader, snapshot, scope, signal),
    reader.smallFiles(snapshot, signal),
    reader.lakeGrowth(snapshot, GROWTH_POINT_LIMIT, signal, scopeRef),
  ]);
  stopped(signal);
  const smallOf = new Map(small.map(({ tableId, small: count }) => [tableId, count]));
  const tables: StorageTable[] = found.map(({ schema, table }) => ({
    id: table.id,
    schemaId: schema.id,
    schema: schema.name,
    name: table.name,
    files: table.stats.files,
    sizeBytes: table.stats.sizeBytes,
    rows: table.stats.rows,
    ...(table.stats.approximate ? { approximate: true as const } : {}),
    smallFiles: smallOf.get(table.id) ?? 0,
  }));
  return {
    connection,
    scope,
    snapshot,
    readAt: now.toISOString(),
    storage,
    smallFileBytes: SMALL_FILE_BYTES,
    rows: tables.reduce((sum, table) => sum + table.rows, 0),
    ...(tables.some((table) => table.approximate) ? { approximate: true as const } : {}),
    tableCount: tables.length,
    tables: sortedTables(tables, DEFAULT_SORT).slice(0, TABLE_LIMIT),
    growth: lake.growth,
    ...(lake.growthMerged ? { growthMerged: true as const } : {}),
  };
}
