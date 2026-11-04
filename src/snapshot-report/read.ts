import type { CatalogReader } from '../catalog/model';
import type { SnapshotReportData } from './model';

/** Reads the newest `limit` snapshots with their changes. */
export async function readSnapshotReport(
  reader: CatalogReader,
  limit: number,
  signal?: AbortSignal,
): Promise<Omit<SnapshotReportData, 'connection'>> {
  const page = await reader.snapshotActivity(limit, undefined, signal);
  return {
    // The page starts with the newest snapshot; only a catalog without snapshots needs the info.
    latest: page.snapshots[0]?.id ?? (await reader.info()).latestSnapshot,
    snapshots: page.snapshots,
    more: page.more,
  };
}
