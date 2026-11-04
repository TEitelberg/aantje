import type { SchemaInfo, SnapshotId, ViewInfo } from '../catalog/model';
import type { ConnectionProfile } from '../connections/profile';
import type { ConnectionStore } from '../connections/store';
import { AantjeError } from '../errors';
import type { ConnectionState, TreeNode } from '../tree/refs';
import { relationOf } from './relation';
import type { Relation } from './relation';
import type { DataAccess, RelationColumn, TableRef } from './types';

/** Everything the data engine needs to read a catalog at a snapshot (undefined: the latest). */
export type DataAccessFactory = (
  profile: ConnectionProfile,
  snapshot: SnapshotId | undefined,
) => Promise<DataAccess>;

type Confirm = (profile: ConnectionProfile) => Promise<void>;
type Profiles = Pick<ConnectionStore, 'get'>;

/**
 * The columns of a view for the tree. DuckDB must run the view's SQL, so the order is fixed: user confirms, access
 * (settings, secrets) is read, engine starts. A missing connection is an error.
 */
export function resolveViewColumns(deps: {
  readonly store: Profiles;
  readonly confirm: Confirm;
  readonly dataAccess: DataAccessFactory;
  readonly describe: (
    access: DataAccess,
    table: TableRef,
    signal?: AbortSignal,
  ) => Promise<readonly RelationColumn[]>;
}): (
  connectionId: string,
  schema: SchemaInfo,
  view: ViewInfo,
  snapshot: SnapshotId,
  signal: AbortSignal,
) => Promise<readonly RelationColumn[]> {
  return async (connectionId, schema, view, snapshot, signal) => {
    const profile = deps.store.get(connectionId);
    if (!profile) {
      throw new AantjeError('INVALID_PROFILE', 'The connection does not exist (any more).');
    }
    await deps.confirm(profile);
    const access = await deps.dataAccess(profile, snapshot);
    // The user just confirmed, so the view guard may bind this view's SQL.
    return deps.describe(
      { ...access, viewsTrusted: true },
      { schema: schema.name, table: view.name },
      signal,
    );
  };
}

/** What a data command acts on: a node's table or view, its connection and that connection's state. */
export interface DataTarget {
  readonly relation: Relation;
  readonly profile: ConnectionProfile;
  readonly state: ConnectionState;
}

/** The target of a data command; views need the one-time confirmation first. Undefined for other nodes. */
export function resolveTarget(deps: {
  readonly store: Profiles;
  readonly confirm: Confirm;
  readonly state: (connectionId: string) => ConnectionState;
}): (node: TreeNode | undefined) => Promise<DataTarget | undefined> {
  return async (node) => {
    const relation = node && relationOf(node.ref);
    const profile = relation && deps.store.get(relation.connectionId);
    if (!relation || !profile) {
      return undefined;
    }
    // Read before the question: trusting the connection reloads the tree, and a reopening state has no snapshot.
    const state = deps.state(profile.id);
    if (relation.kind === 'view') {
      await deps.confirm(profile);
    }
    return { relation, profile, state };
  };
}
