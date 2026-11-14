import type { SnapshotId } from '../catalog/model';
import { compareText, groupBy } from '../order';
import { formatUtc, plural, tableLabel } from '../shell/model';
import type { Card } from '../shell/model';
import { OTHER_LANE, POINT_KINDS, buildModel } from '../snapshot-changes/model';
import type { Model, PointKind } from '../snapshot-changes/model';
import { olderNote } from '../snapshot-changes/window';
import type { ScopedWindow } from '../snapshot-changes/window';

/** What the extension reads and posts to the Activity page: the newest snapshots of the lake or a schema. */
export type ActivityData = ScopedWindow;

export const NO_AUTHOR = '';
const NO_AUTHOR_LABEL = '(no author)';

/** Shown for snapshots without an author; the usual case, not an error. */
export const AUTHOR_HINT =
  'Most writers record no author and no message, so these snapshots have none; that is normal. A writer records them with set_commit_message inside the transaction that writes (a call outside a transaction sets nothing). Use the name the lake is attached as instead of lake:';
export const AUTHOR_EXAMPLE =
  "BEGIN; CALL ducklake_set_commit_message('lake', 'me', 'Nightly import'); INSERT INTO ...; COMMIT;";

// Most authors in the table and tables in the chart; the filters reach the others.
const MAX_AUTHORS = 50;
const TOP_TABLES = 20;

export interface ActivityFilter {
  /** The author to show (`NO_AUTHOR` for none); undefined shows all. */
  readonly author?: string | undefined;
  /** The key of the lane of one table; undefined shows all. */
  readonly table?: string | undefined;
  /** The kinds of change to count; a snapshot needs one of them. */
  readonly kinds: readonly PointKind[];
  /** Part of the commit message, regardless of case; empty for all. */
  readonly text: string;
  /** Snapshots from the first to the second, both included; undefined for all that were read. */
  readonly range?: { readonly from: SnapshotId; readonly to: SnapshotId } | undefined;
}

export type KindCounts = Readonly<Record<PointKind, number>>;

interface Commit {
  readonly id: SnapshotId;
  /** ISO 8601, UTC. */
  readonly time: string;
  readonly author: string | null;
  readonly message: string | null;
}

export interface Day {
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string;
  readonly commits: number;
  /** Changes by kind: a snapshot that changed two tables counts twice. */
  readonly kinds: KindCounts;
}

interface AuthorRow {
  /** `NO_AUTHOR` for the snapshots without one. */
  readonly author: string;
  readonly commits: number;
  readonly first: string;
  readonly last: string;
  /** The commit message of the newest snapshot of the author that has one. */
  readonly message: string | null;
}

export interface TableRow {
  readonly key: string;
  readonly label: string;
  readonly changes: number;
  readonly kinds: KindCounts;
}

export interface ActivitySummary {
  /** Newest first. */
  readonly commits: readonly Commit[];
  /** Oldest first, days without a commit left out. */
  readonly days: readonly Day[];
  readonly authors: readonly AuthorRow[];
  readonly omittedAuthors: number;
  /** The most changed tables first, at most `TOP_TABLES`. */
  readonly tables: readonly TableRow[];
  readonly omittedTables: number;
  readonly kinds: KindCounts;
  /** Tables that the commits changed, whether in the top or not. */
  readonly tablesChanged: number;
}

const emptyKinds = (): Record<PointKind, number> => ({
  insert: 0,
  update: 0,
  delete: 0,
  ddl: 0,
  maintenance: 0,
});

/** The author key; a missing and an empty author are the same. */
export const authorKey = (author: string | null): string => author ?? NO_AUTHOR;

export const authorLabel = (author: string): string => (author === NO_AUTHOR ? NO_AUTHOR_LABEL : author);

const tableName = (lane: Model['lanes'][number]): string =>
  lane.dropped ? `${tableLabel(lane)} (dropped)` : tableLabel(lane);

export const activityModelOf = (data: ActivityData): Model => buildModel(data.snapshots, data.more);

/** The authors and tables the filter offers, from all snapshots read. */
export function choices(model: Model): {
  readonly authors: readonly { readonly key: string; readonly label: string }[];
  readonly tables: readonly { readonly key: string; readonly label: string }[];
} {
  const authors = [...new Set(model.snapshots.map((snapshot) => authorKey(snapshot.author)))]
    .toSorted((a, b) => compareText(authorLabel(a), authorLabel(b)))
    .map((key) => ({ key, label: authorLabel(key) }));
  const tables = model.lanes
    .filter((lane) => lane.key !== OTHER_LANE)
    .map((lane) => ({ key: lane.key, label: tableName(lane) }))
    .toSorted((a, b) => compareText(a.label, b.label));
  return { authors, tables };
}

/** The matching snapshots and the days, authors, tables and kinds counted from them. */
export function summarizeActivity(model: Model, filter: ActivityFilter): ActivitySummary {
  const kinds = new Set(filter.kinds);
  const text = filter.text.trim().toLowerCase();
  const narrowed = kinds.size < POINT_KINDS.length || filter.table !== undefined;
  const bySnapshot = groupBy(
    model.points.filter(
      (point) => kinds.has(point.kind) && (filter.table === undefined || point.lane === filter.table),
    ),
    (point) => point.snapshot,
  );
  const visible = model.snapshots.filter(
    (snapshot) =>
      (!filter.range || (snapshot.id >= filter.range.from && snapshot.id <= filter.range.to)) &&
      (filter.author === undefined || authorKey(snapshot.author) === filter.author) &&
      (text === '' || (snapshot.commitMessage ?? '').toLowerCase().includes(text)) &&
      (!narrowed || bySnapshot.has(snapshot.id)),
  );
  const days = new Map<string, { commits: number; kinds: Record<PointKind, number> }>();
  const authors = groupBy(visible, (snapshot) => authorKey(snapshot.author));
  const tables = new Map<string, Record<PointKind, number>>();
  const total = emptyKinds();
  for (const snapshot of visible) {
    const day = days.get(snapshot.time.slice(0, 10)) ?? { commits: 0, kinds: emptyKinds() };
    day.commits += 1;
    days.set(snapshot.time.slice(0, 10), day);
    for (const point of bySnapshot.get(snapshot.id) ?? []) {
      day.kinds[point.kind] += 1;
      total[point.kind] += 1;
      if (point.lane !== OTHER_LANE) {
        const counts = tables.get(point.lane) ?? emptyKinds();
        counts[point.kind] += 1;
        tables.set(point.lane, counts);
      }
    }
  }
  const authorRows = [...authors].map(([author, own]): AuthorRow => {
    // The snapshots are oldest first.
    return {
      author,
      commits: own.length,
      first: own[0]?.time ?? '',
      last: own.at(-1)?.time ?? '',
      message: own.findLast((snapshot) => (snapshot.commitMessage ?? '') !== '')?.commitMessage ?? null,
    };
  });
  const sortedAuthors = authorRows.toSorted(
    (a, b) => b.commits - a.commits || compareText(authorLabel(a.author), authorLabel(b.author)),
  );
  const tableRows = [...tables]
    .flatMap(([key, counts]): TableRow[] => {
      const lane = model.lanes.find((candidate) => candidate.key === key);
      const changes = POINT_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
      return lane ? [{ key, label: tableName(lane), changes, kinds: counts }] : [];
    })
    .toSorted((a, b) => b.changes - a.changes || compareText(a.label, b.label));
  return {
    commits: visible
      .map(({ id, time, author, commitMessage }) => ({ id, time, author, message: commitMessage }))
      .toReversed(),
    days: [...days]
      .toSorted(([a], [b]) => compareText(a, b))
      .map(([day, counts]) => ({ day, commits: counts.commits, kinds: counts.kinds })),
    authors: sortedAuthors.slice(0, MAX_AUTHORS),
    omittedAuthors: sortedAuthors.length - Math.min(sortedAuthors.length, MAX_AUTHORS),
    tables: tableRows.slice(0, TOP_TABLES),
    omittedTables: tableRows.length - Math.min(tableRows.length, TOP_TABLES),
    kinds: total,
    tablesChanged: tableRows.length,
  };
}

export function activityCards(summary: ActivitySummary, read: number): Card[] {
  const last = summary.commits[0];
  return [
    {
      label: 'Snapshots',
      value: String(summary.commits.length),
      detail: `of ${read} read`,
      severity: 'ok',
    },
    {
      label: 'Authors',
      value: String(summary.authors.length + summary.omittedAuthors),
      severity: 'ok',
    },
    { label: 'Tables changed', value: String(summary.tablesChanged), severity: 'ok' },
    { label: 'Days with commits', value: String(summary.days.length), severity: 'ok' },
    {
      label: 'Latest commit',
      value: last ? formatUtc(last.time) : 'none',
      severity: 'ok',
    },
  ];
}

export const omittedAuthorsNote = (omitted: number): string =>
  `${plural(omitted, 'author', 'authors')} not shown: the ${MAX_AUTHORS} with the most commits are listed. Choose an author in the filter to see the others.`;

export const omittedTablesNote = (omitted: number): string =>
  `${plural(omitted, 'table', 'tables')} not shown: the ${TOP_TABLES} most changed are drawn. Choose a table in the filter to see the others.`;

export const activityOlderNote = (data: ActivityData): string => olderNote(data);
