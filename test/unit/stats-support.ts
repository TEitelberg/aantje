import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { TableStatistics } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { HISTORY_ID } from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { historyFixture } from '../support/sources/history';

/** The statistics of tables of the history fixture, read with the real reader on the SQLite variant. */
export async function historyStatistics(): Promise<{
  events: TableStatistics;
  eventsAtYear: TableStatistics;
  customers: TableStatistics;
  notes: TableStatistics;
  log: TableStatistics;
  logMerged: TableStatistics;
}> {
  const reader = createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
  try {
    return {
      events: await reader.tableStatistics(HISTORY_ID.events, 56),
      eventsAtYear: await reader.tableStatistics(HISTORY_ID.events, 8),
      customers: await reader.tableStatistics(HISTORY_ID.customers, 56),
      notes: await reader.tableStatistics(HISTORY_ID.notes, 56),
      log: await reader.tableStatistics(HISTORY_ID.log, 56),
      logMerged: await reader.tableStatistics(HISTORY_ID.log, 52),
    };
  } finally {
    await reader.close();
  }
}
