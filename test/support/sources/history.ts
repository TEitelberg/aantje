import { fileURLToPath } from 'node:url';
import { inject } from 'vitest';
import { openDuckdb } from '../../../src/catalog/drivers/duckdb';
import { openPostgres } from '../../../src/catalog/drivers/postgres';
import { openSqlite } from '../../../src/catalog/drivers/sqlite';
import { wasmPath } from '../fixtures';
import { duckdbSource } from './duckdb';
import { openQuackFixture, quackSkipReason } from './quack';
import type { CatalogSource } from './types';

const directory = fileURLToPath(new URL('../../fixtures/history/', import.meta.url));

/** Absolute paths of the checked-in history fixture (see test/fixtures/history/README.md). */
export const historyFixture = {
  directory,
  sqlite: `${directory}history.sqlite`,
  duckdb: `${directory}history.duckdb`,
  /** The SQLite catalog after `ducklake_expire_snapshots`: metadata only, snapshots 0, 55 and 56 are left. */
  expired: `${directory}history-expired.sqlite`,
  postgresDump: `${directory}history.postgres.sql`,
} as const;

/**
 * The history fixture opened as sqlite, duckdb, postgres and quack (the last two only with AANTJE_POSTGRES=1, like
 * `catalogSources`). Not part of `catalogSources`: the reader contract suites compare that one with expected.ts.
 */
export const historySources: readonly CatalogSource[] = [
  {
    name: 'sqlite',
    skipReason: () => undefined,
    open: () => openSqlite({ path: historyFixture.sqlite, wasmPath }),
  },
  {
    name: 'duckdb',
    skipReason: () => duckdbSource.skipReason(),
    open: () => openDuckdb({ path: historyFixture.duckdb }),
  },
  {
    name: 'postgres',
    skipReason: () => {
      if (inject('postgresHistory')) {
        return undefined;
      }
      return process.env.AANTJE_POSTGRES === '1'
        ? 'Docker is not available'
        : 'set AANTJE_POSTGRES=1 to run it (needs Docker)';
    },
    open: () => {
      const fixture = inject('postgresHistory');
      if (!fixture) {
        return Promise.reject(new Error('The Postgres fixture is not running; check skipReason() first.'));
      }
      return openPostgres(fixture);
    },
  },
  {
    name: 'quack',
    skipReason: () => quackSkipReason(inject('quackHistory')),
    open: () => openQuackFixture(inject('quackHistory')),
  },
];
