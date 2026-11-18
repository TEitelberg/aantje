import type { Row } from '../drivers/driver';
import type { CatalogReader, SnapshotId, TableChange } from '../model';
import * as queries from '../queries/activity';
import { inlinedTables } from '../queries/maintenance';
import { snapshotCommits } from '../queries/history';
import { chunksOf } from './lookups';
import { toIsoUtcOrNull, toNumber, toText, toTextOrNull } from './rows';
import type { Attempt, Run, WithCommits } from './rows';

// The inlined tables whose rows are read for their snapshots; more are left out (their rows rarely stay unflushed).
const INLINED_LIMIT = 1000;

// The tables of the first read are those that exist; a later read only moves their snapshot forward.
function keepNewest(into: Map<number, SnapshotId>, rows: readonly Row[] | undefined, add = false): void {
  for (const row of rows ?? []) {
    if (row.last_change === null || row.last_change === undefined) continue;
    const table = toNumber(row.table_id);
    const known = into.get(table);
    if (known !== undefined || add) into.set(table, Math.max(known ?? -1, toNumber(row.last_change)));
  }
}

/** The last change of each table, with its commit; see `queries/activity.ts`. */
export function activityReads(
  run: Run,
  attempt: Attempt,
  withCommits: WithCommits,
): Pick<CatalogReader, 'lastTableChanges'> {
  return {
    async lastTableChanges(snapshot, signal) {
      const newest = new Map<number, SnapshotId>();
      keepNewest(newest, await run(queries.lastChanges(snapshot), signal), true);
      // Older catalogs lack the partition and sort tables, or the inlined data.
      keepNewest(newest, await attempt(queries.layoutChanges(snapshot), signal));
      const inlined = (await attempt(inlinedTables({}, INLINED_LIMIT), signal)) ?? [];
      if (inlined.length > 0) {
        const tables = inlined.map((row) => ({
          tableId: toNumber(row.table_id),
          name: toText(row.table_name),
        }));
        keepNewest(newest, await attempt(queries.inlinedChanges(tables, snapshot), signal));
      }
      const ids = [...new Set(newest.values())];
      const commits = new Map<number, Row>();
      for (const chunk of chunksOf(ids)) {
        for (const row of await withCommits((columns) => snapshotCommits(chunk, columns), signal)) {
          commits.set(toNumber(row.snapshot_id), row);
        }
      }
      // A snapshot that expired has no row: the change was before the next snapshot that is left.
      const before = new Map<number, string | null>();
      for (const id of ids.filter((candidate) => !commits.has(candidate))) {
        const [next] = await run(queries.nextSnapshot(id), signal);
        before.set(id, toIsoUtcOrNull(next?.snapshot_time ?? null));
      }
      return [...newest].map(([tableId, id]): TableChange => {
        const commit = commits.get(id);
        return {
          tableId,
          snapshot: id,
          time: toIsoUtcOrNull(commit?.snapshot_time ?? null),
          before: before.get(id) ?? null,
          author: toTextOrNull(commit?.author ?? null),
          commitMessage: toTextOrNull(commit?.commit_message ?? null),
        };
      });
    },
  };
}
