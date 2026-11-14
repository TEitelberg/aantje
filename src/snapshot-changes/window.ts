import type { CatalogReader, SnapshotActivity, SnapshotId } from '../catalog/model';
import { ACTIVITY_LIMIT } from '../catalog/thresholds';
import { plural } from '../shell/model';
import { activityOfSchema } from '../shell/schema-scope';
import type { ReportScope } from '../shell/scope';

/** The newest snapshots that a report of snapshots by time read, with their changes. */
export interface SnapshotWindow {
  readonly connection: string;
  /** The newest snapshot of the catalog, not necessarily among `snapshots`. */
  readonly latest: SnapshotId;
  /** Newest first. */
  readonly snapshots: readonly SnapshotActivity[];
  /** The catalog has older snapshots than these. */
  readonly more: boolean;
}

/** A window of the lake, or of one schema: then `snapshots` are those that changed it, with only their changes. */
export interface ScopedWindow extends SnapshotWindow {
  readonly scope: ReportScope;
  /** For a schema: how many snapshots of the lake were read, of which `snapshots` are those that changed it. */
  readonly read?: number;
}

/** The newest `limit` snapshots of the lake with their changes, and the newest snapshot of the catalog. */
export async function readNewest(
  reader: CatalogReader,
  signal?: AbortSignal,
  limit = ACTIVITY_LIMIT,
): Promise<Omit<SnapshotWindow, 'connection'>> {
  const page = await reader.snapshotActivity(limit, undefined, signal);
  return {
    // The page starts with the newest snapshot; only a catalog without snapshots needs the info.
    latest: page.snapshots[0]?.id ?? (await reader.info()).latestSnapshot,
    snapshots: page.snapshots,
    more: page.more,
  };
}

/** The newest snapshots of the lake as the window of the scope. */
export function scopedWindow(
  connection: string,
  scope: ReportScope,
  newest: Omit<SnapshotWindow, 'connection'>,
): ScopedWindow {
  const { latest, snapshots, more } = newest;
  return scope.kind === 'schema'
    ? {
        connection,
        scope,
        latest,
        snapshots: activityOfSchema(snapshots, scope.name),
        more,
        read: snapshots.length,
      }
    : { connection, scope, latest, snapshots, more };
}

type AnyWindow = SnapshotWindow & { readonly scope?: ReportScope; readonly read?: number };

const ofSchema = (window: AnyWindow): boolean => window.scope?.kind === 'schema';

/** Says that the snapshots read are the newest ones; `extra` goes after "Older ones are not read". */
export function olderNote(window: AnyWindow, extra?: string): string {
  const shown =
    ofSchema(window) && window.read !== undefined
      ? `Of the ${window.read} newest snapshots, the ${window.snapshots.length} that changed the schema are shown.`
      : `The ${window.snapshots.length} newest snapshots are shown.`;
  return `${shown} Older ones are not read${extra === undefined ? '' : `; ${extra}`}.`;
}

/** The line under the title: the connection, the snapshots read and the newest one. */
export const windowSubtitle = (window: AnyWindow): string =>
  `${window.connection} · ${plural(window.snapshots.length, 'snapshot', 'snapshots')} ${ofSchema(window) ? 'of the schema' : 'read'}, latest @${window.latest}`;
