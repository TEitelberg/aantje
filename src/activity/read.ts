import type { CatalogReader } from '../catalog/model';
import { LAKE_SCOPE } from '../shell/scope';
import type { ReportScope } from '../shell/scope';
import { readNewest, scopedWindow } from '../snapshot-changes/window';
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
  return scopedWindow(connection, scope, await readNewest(reader, signal));
}
