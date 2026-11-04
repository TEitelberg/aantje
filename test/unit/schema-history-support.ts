import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { createCatalogReader } from '../../src/catalog/reader';
import { buildHistory } from '../../src/schema-history/model';
import type { SchemaHistoryData } from '../../src/schema-history/model';
import { HISTORY_ID } from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { historyFixture } from '../support/sources/history';

/** The time every snapshot gets in the data of the tests: the real ones differ with every generated variant. */
export const TIME = '2026-11-01T10:00:00.000Z';

/** The schema history of a table of the history fixture, read with the real reader on the SQLite variant, with fixed times. */
export async function historySchema(
  tableId: number = HISTORY_ID.evolving,
  limit?: number,
): Promise<SchemaHistoryData> {
  const reader = createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
  try {
    const data = buildHistory(
      'History',
      tableId,
      (await reader.info()).latestSnapshot,
      await reader.schemaHistory(tableId, limit),
    );
    return { ...data, snapshots: data.snapshots.map((snapshot) => ({ ...snapshot, time: TIME })) };
  } finally {
    await reader.close();
  }
}
