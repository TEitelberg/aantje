import type { SnapshotId } from '../catalog/model';
import type { RowKind } from './types';

// `table_changes` row types; an update is two rows with the same `rowid`, pre-image and post-image.
const ROW_KINDS: Readonly<Record<string, RowKind>> = {
  insert: 'insert',
  delete: 'delete',
  update_preimage: 'update-before',
  update_postimage: 'update-after',
};

/** Undefined for a change type this version does not know (a newer DuckLake, an edited catalog): the row is left out. */
export function rowKindOf(changeType: unknown): RowKind | undefined {
  return typeof changeType === 'string' ? ROW_KINDS[changeType] : undefined;
}

// An update counts as one change, not a pair of rows.
interface ChangeCounts {
  readonly insert: number;
  readonly update: number;
  readonly delete: number;
}

interface SnapshotChanges extends ChangeCounts {
  readonly snapshot: SnapshotId;
}

export interface ChangesSummary {
  /** The changes made after this snapshot ... */
  readonly from: SnapshotId;
  /** ... up to and including this one. */
  readonly to: SnapshotId;
  readonly counts: ChangeCounts;
  readonly total: number;
  /** Rows of a change type this version does not know, over the whole range; not in `counts`, `snapshots` or the grid. */
  readonly unknown: number;
  /** The snapshots that changed rows, oldest first. */
  readonly snapshots: readonly SnapshotChanges[];
  /** The grid holds fewer rows than the changes have. */
  readonly truncated: boolean;
}

/** Rows of one change type in one snapshot. */
export interface ChangeGroup {
  readonly snapshot: SnapshotId;
  readonly changeType: string;
  readonly rows: number;
}

/** Aggregates change rows; only the post-image counts an update, so the pair is one change. */
export function summariseChanges(
  groups: readonly ChangeGroup[],
  range: { readonly from: SnapshotId; readonly to: SnapshotId },
  truncated: boolean,
): ChangesSummary {
  const bySnapshot = new Map<SnapshotId, { insert: number; update: number; delete: number }>();
  let unknown = 0;
  for (const { snapshot, changeType, rows } of groups) {
    const kind = rowKindOf(changeType);
    if (kind === undefined) {
      unknown += rows;
      continue;
    }
    const counts = bySnapshot.get(snapshot) ?? { insert: 0, update: 0, delete: 0 };
    bySnapshot.set(snapshot, counts);
    if (kind === 'insert') counts.insert += rows;
    else if (kind === 'delete') counts.delete += rows;
    else if (kind === 'update-after') counts.update += rows;
  }
  const snapshots = [...bySnapshot]
    .map(([snapshot, counts]) => ({ snapshot, ...counts }))
    .sort((a, b) => a.snapshot - b.snapshot);
  const counts = {
    insert: snapshots.reduce((sum, entry) => sum + entry.insert, 0),
    update: snapshots.reduce((sum, entry) => sum + entry.update, 0),
    delete: snapshots.reduce((sum, entry) => sum + entry.delete, 0),
  };
  return {
    ...range,
    counts,
    total: counts.insert + counts.update + counts.delete,
    unknown,
    snapshots,
    truncated,
  };
}

// Grid rows for all changes; an update has two.
function rowCount({ insert, update, delete: deleted }: ChangeCounts): number {
  return insert + 2 * update + deleted;
}

// Snapshots the summary line names; the others are counted.
const NAMED_SNAPSHOTS = 8;

/** E.g. "4 inserted, 1 updated, 1 deleted (6 changes) after @15 until @18 · @16 +4 · @17 ~1 · @18 −1". */
export function summaryLine(summary: ChangesSummary, shownRows: number): string {
  const { from, to, counts, total, unknown, snapshots, truncated } = summary;
  const range = `after @${from} until @${to}`;
  const leftOut =
    unknown > 0 ? [`${unknown} ${unknown === 1 ? 'row' : 'rows'} of an unknown change type left out`] : [];
  if (total === 0) {
    return unknown > 0 ? [`No known changes ${range}`, ...leftOut].join(' · ') : `No changes ${range}.`;
  }
  const parts = [
    counts.insert > 0 ? `${counts.insert} inserted` : '',
    counts.update > 0 ? `${counts.update} updated` : '',
    counts.delete > 0 ? `${counts.delete} deleted` : '',
  ].filter(Boolean);
  const perSnapshot = snapshots
    .slice(0, NAMED_SNAPSHOTS)
    .map(
      ({ snapshot, insert, update, delete: deleted }) =>
        `@${snapshot} ${[
          insert > 0 ? `+${insert}` : '',
          update > 0 ? `~${update}` : '',
          deleted > 0 ? `−${deleted}` : '',
        ]
          .filter(Boolean)
          .join(' ')}`,
    );
  const more = snapshots.length - perSnapshot.length;
  const line = [
    `${parts.join(', ')} (${total} ${total === 1 ? 'change' : 'changes'}) ${range}`,
    ...perSnapshot,
    ...(more > 0 ? [`and ${more} more ${more === 1 ? 'snapshot' : 'snapshots'}`] : []),
    ...leftOut,
  ].join(' · ');
  return truncated ? `${line} · showing the first ${shownRows} of ${rowCount(counts)} rows` : line;
}
