// The catalog that completion, hover and the name check read: one per connection, and the columns of its views once
// the user trusted them.
import type { CatalogReader, SnapshotId } from '../catalog/model';
import type { ConnectionProfile } from '../connections/profile';
import { resolveViewColumns } from '../data/resolve';
import type { DataAccessFactory } from '../data/resolve';
import type { ViewTrustStore } from '../data/trust';
import { AantjeError, isAborted, userMessageOf } from '../errors';
import type { Logger } from '../log';
import { catalogOfReader } from './catalog';
import type { SqlCatalog, ViewColumnSource } from './catalog';

/**
 * The completion catalog per connection; rebuilt when the explorer reconnects (a refresh does) or changes snapshot. A
 * catalog that is dropped aborts its reads of view columns.
 */
export function catalogCache(source: {
  reader(connectionId: string): CatalogReader | undefined;
  snapshot(connectionId: string): SnapshotId | undefined;
  /** How the catalog of the connection binds its views; without it, views offer no columns. */
  views?(connectionId: string, signal: AbortSignal): ViewColumnSource;
}): { of(connectionId: string): SqlCatalog | undefined; invalidate(): void } {
  const cache = new Map<
    string,
    { reader: CatalogReader; snapshot: SnapshotId; catalog: SqlCatalog; dropped: AbortController }
  >();
  const drop = (connectionId: string): void => {
    cache.get(connectionId)?.dropped.abort();
    cache.delete(connectionId);
  };
  return {
    of(connectionId) {
      const reader = source.reader(connectionId);
      const snapshot = source.snapshot(connectionId);
      if (!reader || snapshot === undefined) {
        drop(connectionId);
        return undefined;
      }
      const hit = cache.get(connectionId);
      if (hit?.reader === reader && hit.snapshot === snapshot) return hit.catalog;
      drop(connectionId);
      const dropped = new AbortController();
      const catalog = catalogOfReader(reader, snapshot, 'lake', source.views?.(connectionId, dropped.signal));
      cache.set(connectionId, { reader, snapshot, catalog, dropped });
      return catalog;
    },
    invalidate: () => {
      for (const connectionId of [...cache.keys()]) drop(connectionId);
    },
  };
}

/**
 * How completion binds the views of a connection: the explorer's path (`resolveViewColumns`, the view guard included)
 * once the user trusted the connection's views. It never asks; a failed read is logged and the view offers no columns.
 */
export function trustedViewColumns(deps: {
  readonly store: { get(id: string): ConnectionProfile | undefined };
  readonly trust: Pick<ViewTrustStore, 'isTrusted'>;
  readonly dataAccess: DataAccessFactory;
  readonly describe: Parameters<typeof resolveViewColumns>[0]['describe'];
  readonly log: Pick<Logger, 'warn'>;
}): (connectionId: string, signal: AbortSignal) => ViewColumnSource {
  const { store, trust, log } = deps;
  const resolve = resolveViewColumns({
    store,
    dataAccess: deps.dataAccess,
    describe: deps.describe,
    confirm: (profile) =>
      trust.isTrusted(profile)
        ? Promise.resolve()
        : Promise.reject(new AantjeError('ABORTED', `The views of "${profile.name}" are not trusted.`)),
  });
  return (connectionId, signal) => ({
    trusted: () => {
      const profile = store.get(connectionId);
      return profile !== undefined && trust.isTrusted(profile);
    },
    read: (schema, view, snapshot) => resolve(connectionId, schema, view, snapshot, signal),
    failed: (schema, view, error) => {
      if (isAborted(error)) return;
      log.warn(
        `Completion offers no columns of the view "${schema.name}.${view.name}": ${userMessageOf(error)}`,
      );
    },
  });
}
