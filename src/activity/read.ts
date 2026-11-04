import type { CatalogReader } from '../catalog/model';
import { ACTIVITY_LIMIT } from '../catalog/thresholds';
import { LAKE_SCOPE } from '../shell/scope';
import type { ReportScope } from '../shell/scope';
import { activityOfSchema } from '../shell/schema-scope';
import type { ActivityData } from './model';

/**
 * Reads the newest snapshots with their authors, messages and changes, and the newest snapshot of the catalog. For a
 * schema, of those snapshots the ones that changed it.
 */
export async function readActivity(
  reader: CatalogReader,
  connection: string,
  signal?: AbortSignal,
  scope: ReportScope = LAKE_SCOPE,
): Promise<ActivityData> {
  const page = await reader.snapshotActivity(ACTIVITY_LIMIT, undefined, signal);
  // The page starts with the newest snapshot; only a catalog without snapshots needs the info.
  const latest = page.snapshots[0]?.id ?? (await reader.info()).latestSnapshot;
  return {
    connection,
    scope,
    latest,
    snapshots: scope.kind === 'schema' ? activityOfSchema(page.snapshots, scope.name) : page.snapshots,
    more: page.more,
    ...(scope.kind === 'schema' ? { read: page.snapshots.length } : {}),
  };
}
