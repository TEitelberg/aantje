import type { ResolvedChange, SnapshotActivity } from '../catalog/model';

const concernsSchema = (change: ResolvedChange, schema: string): boolean =>
  change.object === 'schema' ? change.name === schema : change.schemaName === schema;

/**
 * The snapshots that changed something of the schema (the schema itself, or a table, view or macro in it), each with
 * only those changes. Snapshot tags and changes of other schemas drop out.
 */
export function activityOfSchema(snapshots: readonly SnapshotActivity[], schema: string): SnapshotActivity[] {
  return snapshots.flatMap((snapshot) => {
    const changes = snapshot.changes.filter((change) => concernsSchema(change, schema));
    return changes.length === 0 ? [] : [{ ...snapshot, changes }];
  });
}

/** The ids of the tables of the schema that the snapshots changed, dropped tables included. */
export function tablesChangedIn(snapshots: readonly SnapshotActivity[]): Set<number> {
  return new Set(
    snapshots.flatMap(({ changes }) =>
      changes.flatMap(({ object, objectId }) => (object === 'table' && objectId !== null ? [objectId] : [])),
    ),
  );
}
