import type { ActivityData } from '../../src/activity/model';
import { readActivity } from '../../src/activity/read';
import type { EditedCatalogs } from '../support/edited-catalog';
import { historyFixture } from '../support/sources/history';

/** The snapshots `from` to `to` (both included) get this author and commit message. */
export type Authored = readonly [from: number, to: number, author: string, message: string];

const quoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/**
 * Statements that give the snapshots of the history fixture times that do not depend on the run: snapshot `n` was
 * committed on the day `2026-10-20 + n / 10` at ten o'clock plus `n` minutes. Snapshot 25 keeps its author `tillmann`
 * and its message `Nightly import`; `authors` adds more.
 */
export function timeStatements(authors: readonly Authored[]): string[] {
  return [
    "UPDATE ducklake_snapshot SET snapshot_time = printf('2026-10-%02d 10:%02d:00.000000+00', 20 + snapshot_id / 10, snapshot_id % 60)",
    ...authors.map(
      ([from, to, author, message]) =>
        `UPDATE ducklake_snapshot_changes SET author = ${quoted(author)}, commit_message = ${quoted(message)} WHERE snapshot_id BETWEEN ${from} AND ${to}`,
    ),
  ];
}

/** The activity data of the history fixture with the times above, read with the real reader on an edited SQLite copy. */
export async function historyActivity(
  catalogs: EditedCatalogs,
  ...authors: readonly Authored[]
): Promise<ActivityData> {
  const reader = await catalogs.open(historyFixture.sqlite, ...timeStatements(authors));
  return readActivity(reader, 'History');
}
