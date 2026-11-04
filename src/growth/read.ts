import type { CatalogReader } from '../catalog/model';
import { LAKE_SCOPE } from '../shell/scope';
import type { ReportScope } from '../shell/scope';
import { activityOfSchema, tablesChangedIn } from '../shell/schema-scope';
import { expiredAmong } from './model';
import type { GrowthData } from './model';

const GROWTH_LIMIT = 500;

/**
 * Reads the newest `limit` snapshots, the tables and their row, byte and file changes; `focus` starts the page. For a
 * schema the snapshots that changed it and its tables.
 */
export async function readGrowth(
  reader: CatalogReader,
  connection: string,
  focus: number | null,
  signal?: AbortSignal,
  limit = GROWTH_LIMIT,
  scope: ReportScope = LAKE_SCOPE,
): Promise<GrowthData> {
  const read = await reader.snapshotActivity(limit, undefined, signal);
  const page =
    scope.kind === 'schema' ? { ...read, snapshots: activityOfSchema(read.snapshots, scope.name) } : read;
  // The page starts with the newest snapshot; only a catalog without snapshots needs the info.
  const latestSnapshot = read.snapshots[0]?.id ?? (await reader.info()).latestSnapshot;
  // The newest snapshot of the lake, not of the schema: the sums start from the oldest snapshot that was read.
  const first = Math.min(...read.snapshots.map(({ id }) => id), latestSnapshot);
  const [entries, { changes, inlinedMore, inlinedFailed }] = await Promise.all([
    reader.entries(latestSnapshot),
    reader.growthChanges(first, signal),
  ]);
  const tables = entries
    .filter((entry) => entry.kind === 'table' && (scope.kind === 'lake' || entry.schemaId === scope.id))
    .map(({ id, schemaName, name }) => ({ id, schema: schemaName, name }));
  const own = new Set([...tables.map(({ id }) => id), ...tablesChangedIn(page.snapshots)]);
  return {
    connection,
    scope,
    focus,
    latest: latestSnapshot,
    snapshots: page.snapshots,
    more: page.more,
    ...(scope.kind === 'schema'
      ? { read: read.snapshots.length, expired: expiredAmong(read.snapshots.map(({ id }) => id)) }
      : {}),
    tables,
    changes: scope.kind === 'lake' ? changes : changes.filter(({ tableId }) => own.has(tableId)),
    inlinedMore: inlinedMore === true,
    inlinedFailed: inlinedFailed === true,
  };
}
