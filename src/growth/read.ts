import type { CatalogReader } from '../catalog/model';
import { ACTIVITY_LIMIT } from '../catalog/thresholds';
import { LAKE_SCOPE } from '../shell/scope';
import type { ReportScope } from '../shell/scope';
import { tablesChangedIn } from '../shell/schema-scope';
import { readNewest, scopedWindow } from '../snapshot-changes/window';
import { expiredAmong } from './model';
import type { GrowthData } from './model';

/**
 * Reads the newest `limit` snapshots, the tables and their row, byte and file changes; `focus` starts the page. For a
 * schema the snapshots that changed it and its tables.
 */
export async function readGrowth(
  reader: CatalogReader,
  connection: string,
  focus: number | null,
  signal?: AbortSignal,
  limit = ACTIVITY_LIMIT,
  scope: ReportScope = LAKE_SCOPE,
): Promise<GrowthData> {
  const newest = await readNewest(reader, signal, limit);
  const window = scopedWindow(connection, scope, newest);
  // The oldest snapshot of the lake that was read, not of the schema: the sums start from there.
  const first = Math.min(...newest.snapshots.map(({ id }) => id), newest.latest);
  const [entries, { changes, inlinedMore, inlinedFailed }] = await Promise.all([
    reader.entries(newest.latest),
    reader.growthChanges(first, signal),
  ]);
  const tables = entries
    .filter((entry) => entry.kind === 'table' && (scope.kind === 'lake' || entry.schemaId === scope.id))
    .map(({ id, schemaName, name }) => ({ id, schema: schemaName, name }));
  const own = new Set([...tables.map(({ id }) => id), ...tablesChangedIn(window.snapshots)]);
  return {
    ...window,
    focus,
    ...(scope.kind === 'schema' ? { expired: expiredAmong(newest.snapshots.map(({ id }) => id)) } : {}),
    tables,
    changes: scope.kind === 'lake' ? changes : changes.filter(({ tableId }) => own.has(tableId)),
    inlinedMore: inlinedMore === true,
    inlinedFailed: inlinedFailed === true,
  };
}
