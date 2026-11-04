import { isAantjeError } from '../errors';
import type { Driver } from './drivers/driver';
import type { CatalogReader } from './model';
import type { Query } from './queries/shared';
import { coreReads } from './reader/core';
import { detailReads } from './reader/details';
import { growthReads } from './reader/growth';
import { historyReads } from './reader/history';
import { maintenanceReads } from './reader/maintenance';
import type { Attempt, Run } from './reader/rows';
import { statisticsReads } from './reader/table-statistics';

/** Reads a DuckLake catalog through `driver`; the reader owns the driver and closes it with `close()`. */
export function createCatalogReader(driver: Driver): CatalogReader {
  const run: Run = (query: Query, signal?: AbortSignal) =>
    driver.query(query.sql, query.params, signal ? { signal } : undefined);

  const attempt: Attempt = async (query, signal) => {
    try {
      return await run(query, signal);
    } catch (cause) {
      if (isAantjeError(cause) && cause.code === 'QUERY_FAILED') {
        return undefined;
      }
      throw cause;
    }
  };

  return {
    ...coreReads(run, attempt),
    ...detailReads(run, attempt),
    ...statisticsReads(run, attempt),
    ...growthReads(run, attempt),
    ...historyReads(run, attempt),
    ...maintenanceReads(run, attempt),
    close: () => driver.close(),
  };
}
