import type { ConnectionProfile } from '../connections/profile';
import { AantjeError } from '../errors';
import type { Driver } from './drivers/driver';
import type { CatalogInfo, CatalogReader } from './model';
import { createCatalogReader } from './reader';

interface OpenOptions {
  /** Password of a PostgreSQL profile or token of a Quack one; it lives in secret storage, never in the profile. */
  readonly password?: string;
  /** Location of `sql-wasm.wasm`, which the SQLite driver needs. */
  readonly wasmPath: string;
  /** Maximum duration of one query in milliseconds (DuckDB, PostgreSQL and Quack). */
  readonly statementTimeoutMs?: number;
  /** DuckDB `extension_directory` for the quack extension (setting `aantje.duckdb.extensionDirectory`). */
  readonly extensionDirectory?: string;
}

/** A catalog that passed the check: the reader, which owns the connection, and what the check read. */
export interface OpenedCatalog {
  readonly reader: CatalogReader;
  readonly info: CatalogInfo;
}

/**
 * Opens a profile's catalog and checks it is a supported DuckLake catalog; the caller gets the result of the check
 * and need not ask again. Failures close the connection and never contain the password.
 */
export async function openCatalog(profile: ConnectionProfile, options: OpenOptions): Promise<OpenedCatalog> {
  let driver: Driver | undefined;
  try {
    driver = await openDriver(profile, options);
    const reader = createCatalogReader(driver);
    return { reader, info: await reader.info() };
  } catch (error) {
    await driver?.close().catch(() => undefined);
    throw error instanceof AantjeError
      ? error
      : new AantjeError(
          'CONNECTION_FAILED',
          'Could not open the catalog. See the "aantje" output channel for details.',
          {
            cause: error,
          },
        );
  }
}

// Imported on demand so the native DuckDB binding and `pg` load only when used.
async function openDriver(profile: ConnectionProfile, options: OpenOptions): Promise<Driver> {
  switch (profile.kind) {
    case 'sqlite': {
      const { openSqlite } = await import('./drivers/sqlite');
      return openSqlite({ path: profile.path, wasmPath: options.wasmPath });
    }
    case 'duckdb': {
      const { openDuckdb } = await import('./drivers/duckdb');
      return openDuckdb({ path: profile.path, statementTimeoutMs: options.statementTimeoutMs });
    }
    case 'postgres': {
      const { openPostgres } = await import('./drivers/postgres');
      return openPostgres({
        host: profile.host,
        port: profile.port,
        database: profile.database,
        user: profile.user,
        password: options.password,
        ssl: profile.ssl,
        metadataSchema: profile.metadataSchema,
        statementTimeoutMs: options.statementTimeoutMs,
      });
    }
    case 'quack': {
      const { openQuack } = await import('./drivers/quack');
      return openQuack({
        host: profile.host,
        port: profile.port,
        token: options.password,
        ssl: profile.ssl,
        fingerprint: profile.fingerprint,
        statementTimeoutMs: options.statementTimeoutMs,
        extensionDirectory: options.extensionDirectory,
      });
    }
  }
}
