import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { ResolvedAction, ResolvedChange, SnapshotActivity } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import type { SnapshotReportData } from '../../src/snapshot-report/model';
import { HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { historyFixture } from '../support/sources/history';

/** The report data of the history fixture, read with the real reader on the SQLite variant. */
export async function historyReport(): Promise<SnapshotReportData> {
  const reader = createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
  try {
    const { snapshots, more } = await reader.snapshotActivity();
    return {
      connection: 'History',
      latest: HISTORY_LATEST_SNAPSHOT,
      snapshots,
      more,
    };
  } finally {
    await reader.close();
  }
}

/** A change of a table, named as a reader names it. */
export function tableChange(
  id: number,
  action: ResolvedAction,
  schemaName: string | null = 'shop',
  name: string | null = `t${id}`,
): ResolvedChange {
  return { action, object: 'table', objectId: id, schemaName, name, raw: `${action}:${id}` };
}

export function snapshot(
  id: number,
  changes: readonly ResolvedChange[],
  extra: Partial<Pick<SnapshotActivity, 'author' | 'commitMessage'>> = {},
): SnapshotActivity {
  return {
    id,
    time: `2026-11-01T00:00:${String(id % 60).padStart(2, '0')}.000Z`,
    author: null,
    commitMessage: null,
    changes,
    ...extra,
  };
}
