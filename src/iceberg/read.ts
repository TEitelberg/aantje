import type { CatalogReader } from '../catalog/model';
import { isMaintenanceAction } from '../catalog/changes';
import type { ChangeAction } from '../catalog/changes';
import { readIcebergFacts } from './rest';
import type { Fetch } from './rest';
import { icebergKeyOf, icebergRefOf } from './records';
import type { IcebergCopyRecord } from './records';
import { judge } from './status';
import type { LakeChange, LakeFacts, LakeStatus } from './status';
import type { IcebergTarget } from './target';

export interface IcebergCheck {
  readonly status: LakeStatus;
  /** The newest snapshot of the lake when it was checked. */
  readonly newest: number;
  readonly checkedAt: string;
  /** Set when the Iceberg catalog could not be asked at all (sign-in, unreachable); the tables are then not checked. */
  readonly icebergError: string | undefined;
}

/** What the lake says about the copied tables: one read of its tables and one of the snapshots since the oldest copy. */
export async function readLakeFacts(
  reader: Pick<CatalogReader, 'info' | 'entries' | 'snapshotActivity'>,
  records: readonly IcebergCopyRecord[],
): Promise<LakeFacts> {
  const { latestSnapshot: newest } = await reader.info();
  const oldest = Math.min(...records.map((record) => record.snapshot));
  const [entries, activity] = await Promise.all([
    reader.entries(newest),
    newest > oldest
      ? reader.snapshotActivity(undefined, { from: oldest + 1, to: newest })
      : { snapshots: [] },
  ]);
  const tables = new Map(
    entries
      .filter((entry) => entry.kind === 'table')
      .map((entry) => [entry.id, { schema: entry.schemaName, name: entry.name }] as const),
  );
  const touched = new Map<number, LakeChange[]>();
  for (const snapshot of activity.snapshots) {
    const actions = new Map<number, Set<ChangeAction | 'renamed'>>();
    for (const change of snapshot.changes) {
      if (change.object !== 'table' || change.objectId === null || isMaintenanceAction(change.action))
        continue;
      actions.set(change.objectId, (actions.get(change.objectId) ?? new Set()).add(change.action));
    }
    for (const [id, kinds] of actions)
      touched.set(id, [
        ...(touched.get(id) ?? []),
        { snapshot: snapshot.id, time: snapshot.time, actions: kinds },
      ]);
  }
  return {
    newest,
    tables,
    changes: (tableId, after) =>
      (touched.get(tableId) ?? [])
        .filter((change) => change.snapshot > after)
        .toSorted((a, b) => a.snapshot - b.snapshot),
  };
}

/** Compares the records of one copy target with the lake and the Iceberg catalog. */
export async function checkCopy(deps: {
  readonly reader: Pick<CatalogReader, 'info' | 'entries' | 'snapshotActivity'>;
  readonly records: readonly IcebergCopyRecord[];
  readonly target: IcebergTarget;
  readonly secret: string | undefined;
  readonly fetcher?: Fetch;
  readonly now?: () => Date;
}): Promise<IcebergCheck> {
  const { records, target } = deps;
  const [lake, iceberg] = await Promise.all([
    readLakeFacts(deps.reader, records),
    readIcebergFacts(target, deps.secret, records.map(icebergRefOf), deps.fetcher),
  ]);
  // A catalog that cannot be asked at all is the reason of every table, not a table that is missing.
  const facts =
    iceberg.error === undefined
      ? iceberg.facts
      : new Map(
          records.map((record) => [
            icebergKeyOf(record),
            { kind: 'error', message: iceberg.error ?? '' } as const,
          ]),
        );
  return {
    status: judge(records, lake, facts),
    newest: lake.newest,
    checkedAt: (deps.now?.() ?? new Date()).toISOString(),
    icebergError: iceberg.error,
  };
}
