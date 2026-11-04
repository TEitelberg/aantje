import { parseChanges } from '../changes';
import type { Row } from '../drivers/driver';
import type {
  CatalogReader,
  ColumnInfo,
  Lifetime,
  ResolvedChange,
  SchemaHistory,
  SchemaVersion,
  SnapshotActivityPage,
} from '../model';
import * as queries from '../queries/history';
import { ACTIVITY_LIMIT } from '../thresholds';
import { toIsoUtc } from '../timestamp';
import { columnTree } from './columns';
import { ID_CHUNK, resolveActivity, resolveChanges } from './lookups';
import { toNumber, toText, toTextOrNull } from './rows';
import type { Attempt, Run } from './rows';

// `begin_snapshot` inclusive, `end_snapshot` exclusive, NULL while valid.
function validAt(row: Row, snapshot: number): boolean {
  return (
    snapshot >= toNumber(row.begin_snapshot) &&
    (row.end_snapshot === null || snapshot < toNumber(row.end_snapshot))
  );
}

function rowBoundaries(lists: readonly (readonly Row[])[]): number[] {
  const found = new Set<number>();
  for (const row of lists.flat()) {
    found.add(toNumber(row.begin_snapshot));
    if (row.end_snapshot !== null) {
      found.add(toNumber(row.end_snapshot));
    }
  }
  return [...found].sort((a, b) => a - b);
}

function columnsAt(columns: readonly Row[], comments: readonly Row[], snapshot: number): ColumnInfo[] {
  const commentOf = new Map(
    comments
      .filter((row) => validAt(row, snapshot))
      .map((row) => [toNumber(row.column_id), row.comment_text] as const),
  );
  return columnTree(
    columns
      .filter((row) => validAt(row, snapshot))
      .toSorted(
        (a, b) =>
          toNumber(a.column_order) - toNumber(b.column_order) ||
          toNumber(a.column_id) - toNumber(b.column_id),
      )
      .map((row) => ({ ...row, comment_text: commentOf.get(toNumber(row.column_id)) ?? null })),
  );
}

type HistoryReads = Pick<
  CatalogReader,
  'snapshotChanges' | 'snapshotActivity' | 'lifetime' | 'schemaHistory' | 'columnHistory'
>;

/** Reads of what happened to the catalog: changes per snapshot, lifetimes and the schema history of a table. */
export function historyReads(run: Run, attempt: Attempt): HistoryReads {
  return {
    async snapshotChanges(snapshotId): Promise<ResolvedChange[]> {
      const rows = await run(queries.changesOf(snapshotId));
      return resolveChanges(attempt, parseChanges(toTextOrNull(rows[0]?.changes_made ?? null)), snapshotId);
    },

    async snapshotActivity(limit = ACTIVITY_LIMIT, range, signal): Promise<SnapshotActivityPage> {
      const from = range?.from ?? 0;
      const to = range?.to ?? Number.MAX_SAFE_INTEGER;
      // One extra row tells whether older snapshots exist.
      const rows =
        (await attempt(queries.snapshotActivity(from, to, limit + 1), signal)) ??
        (await run(queries.snapshotActivity(from, to, limit + 1, false), signal));
      const page = rows.slice(0, limit).map((row) => ({
        id: toNumber(row.snapshot_id),
        time: toIsoUtc(toText(row.snapshot_time)),
        author: toTextOrNull(row.author ?? null),
        commitMessage: toTextOrNull(row.commit_message ?? null),
        changes: parseChanges(toTextOrNull(row.changes_made)),
      }));
      return { snapshots: await resolveActivity(attempt, page, signal), more: rows.length > limit };
    },

    async lifetime(kind, id): Promise<Lifetime | undefined> {
      const [row] = await run(queries.lifetime(kind, id));
      const begin = row?.first_snapshot;
      if (begin === null || begin === undefined) {
        return undefined;
      }
      return {
        begin: toNumber(begin),
        end: toNumber(row?.open_versions) > 0 ? null : toNumber(row?.last_end),
      };
    },

    async schemaHistory(tableId, limit = Infinity, signal): Promise<SchemaHistory> {
      const [tables, columns, comments] = await Promise.all([
        run(queries.tableVersions(tableId), signal),
        run(queries.columnRows(tableId), signal),
        run(queries.columnCommentRows(tableId), signal),
      ]);
      const all = rowBoundaries([tables, columns, comments]);
      // `slice(-0)` is the whole list.
      const snapshots = limit > 0 ? all.slice(-limit) : [];
      const commits = new Map<number, Row>();
      for (let at = 0; at < snapshots.length; at += ID_CHUNK) {
        const ids = snapshots.slice(at, at + ID_CHUNK);
        const rows =
          (await attempt(queries.snapshotCommits(ids), signal)) ??
          (await run(queries.snapshotCommits(ids, false), signal));
        for (const row of rows) {
          commits.set(toNumber(row.snapshot_id), row);
        }
      }
      return {
        versions: snapshots.map((snapshot): SchemaVersion => {
          const commit = commits.get(snapshot);
          const table = tables.find((row) => validAt(row, snapshot));
          return {
            snapshot,
            time: commit ? toIsoUtc(toText(commit.snapshot_time)) : null,
            author: toTextOrNull(commit?.author ?? null),
            commitMessage: toTextOrNull(commit?.commit_message ?? null),
            table: table
              ? { schemaName: toTextOrNull(table.schema_name ?? null), name: toText(table.object_name) }
              : null,
            columns: table ? columnsAt(columns, comments, snapshot) : [],
          };
        }),
        more: all.length > snapshots.length,
      };
    },

    async columnHistory(tableId, signal) {
      const rows = await run(queries.columnHistory(tableId), signal);
      return rows.map((row) => ({ id: toNumber(row.column_id), name: toText(row.column_name) }));
    },
  };
}
