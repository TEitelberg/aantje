import { describeChange, parseChanges } from './catalog/changes';
import type { Lifetime, SnapshotId, SnapshotInfo } from './catalog/model';
import { pickerLabel } from './messages';

/** One row of the snapshot picker; `value` is the selection when the row is chosen. */
export interface SnapshotPickItem<Value = SnapshotId | 'latest'> {
  readonly label: string;
  readonly description: string;
  readonly detail: string;
  readonly value: Value;
  readonly picked: boolean;
}

/** Readable text for `ducklake_snapshot_changes.changes_made`; changes are separated by `; `, unknown ones show as stored. */
export function describeChanges(changes: string | null): string {
  const entries = parseChanges(changes);
  return entries.length > 0 ? entries.map(describeChange).join('; ') : 'No recorded changes';
}

/** Rows for the "Show Catalog at Snapshot" picker: "Latest", then snapshots newest first; the current selection is `picked`. */
export function snapshotPickItems(
  snapshots: readonly SnapshotInfo[],
  current: { readonly selected: SnapshotId | 'latest'; readonly latest: SnapshotId },
): SnapshotPickItem[] {
  return [
    {
      label: 'Latest',
      description: `@${current.latest}`,
      detail: 'Follow the newest snapshot',
      value: 'latest',
      picked: current.selected === 'latest',
    },
    ...snapshotChoices(snapshots, current.selected === 'latest' ? undefined : current.selected),
  ];
}

/** Rows for concrete snapshots, newest first, without "Latest"; `within` limits them to a lifetime, `selected` is preselected. */
export function snapshotChoices(
  snapshots: readonly SnapshotInfo[],
  selected: SnapshotId | undefined,
  within?: Lifetime,
): SnapshotPickItem<SnapshotId>[] {
  return snapshots
    .filter(
      (snapshot) =>
        !within || (snapshot.id >= within.begin && (within.end === null || snapshot.id < within.end)),
    )
    .toSorted((a, b) => b.id - a.id)
    .map((snapshot) => ({
      label: `@${snapshot.id}`,
      description: formatUtc(snapshot.time),
      detail: detailOf(snapshot),
      value: snapshot.id,
      picked: snapshot.id === selected,
    }));
}

// Free text: a message may have several lines, and a picker draws `$(name)` as an icon, so `$(` is escaped.
function detailOf(snapshot: SnapshotInfo): string {
  const message = snapshot.commitMessage?.replace(/\s+/g, ' ').trim();
  const changes = describeChanges(snapshot.changes);
  return pickerLabel(message ? `${message} · ${changes}` : changes);
}

/** `SnapshotInfo.time` (ISO 8601, UTC) as `YYYY-MM-DD HH:mm:ss UTC`, truncated at the second. */
export function formatUtc(time: string): string {
  return `${time.slice(0, 19).replace('T', ' ')} UTC`;
}
