import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import type { FileProfile } from '../../src/connections/profile';
import type { DataAccess } from '../../src/data/types';

/** Shared by all runs, so the extensions are downloaded once (needs network the first time). */
export const extensionDirectory = fileURLToPath(new URL('../.cache/duckdb-extensions', import.meta.url));

const dataFixtures = fileURLToPath(new URL('../fixtures/data/', import.meta.url));

/**
 * Why the engine tests cannot run (extensions neither cached nor downloadable), or undefined when they can. With
 * `AANTJE_REQUIRE_ENGINE=1` (CI) it throws instead, so that the test file fails and a green run cannot hide skipped tests.
 */
export async function engineSkipReason(): Promise<string | undefined> {
  try {
    const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
    const connection = await instance.connect();
    try {
      for (const extension of ['ducklake', 'sqlite', 'httpfs', 'postgres', 'quack']) {
        await connection.run(`INSTALL ${extension}`);
        await connection.run(`LOAD ${extension}`);
      }
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
    return undefined;
  } catch (error) {
    const reason = `the DuckDB extensions ducklake, sqlite, httpfs, postgres and quack are not cached in test/.cache/duckdb-extensions and cannot be downloaded (${(error as Error).message.split('\n')[0]})`;
    if (process.env['AANTJE_REQUIRE_ENGINE'] === '1') {
      throw new Error(`AANTJE_REQUIRE_ENGINE=1 forbids skipping the engine tests, but ${reason}`, {
        cause: error,
      });
    }
    return reason;
  }
}

export interface DataFixture {
  readonly profile: FileProfile;
  readonly directory: string;
  remove(): Promise<void>;
}

/**
 * A private copy of a data fixture whose `data_path` points to the copy: the stored path is relative and DuckLake
 * resolves it against the working directory of the reader, which is different for every test run. With
 * `remoteDataPath` (e.g. `s3://bucket/`) the catalog points there instead, to a place that has no files.
 */
export async function copyDataFixture(
  kind: 'sqlite' | 'duckdb',
  remoteDataPath?: string,
): Promise<DataFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'aantje-data-'));
  try {
    return await prepareDataFixture(directory, kind, remoteDataPath);
  } catch (error) {
    // The caller never gets a fixture to remove.
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function prepareDataFixture(
  directory: string,
  kind: 'sqlite' | 'duckdb',
  remoteDataPath: string | undefined,
): Promise<DataFixture> {
  const file = `data-catalog.${kind}`;
  await cp(join(dataFixtures, file), join(directory, file));
  await cp(join(dataFixtures, `${kind}-files`), join(directory, `${kind}-files`), { recursive: true });
  const dataPath = remoteDataPath ?? `${join(directory, `${kind}-files`).replaceAll('\\', '/')}/`;

  const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
  const connection = await instance.connect();
  try {
    if (kind === 'sqlite') {
      await connection.run('LOAD sqlite');
    }
    const path = join(directory, file).replaceAll("'", "''");
    await connection.run(`ATTACH '${path}' AS meta${kind === 'sqlite' ? ' (TYPE sqlite)' : ''}`);
    await connection.run(
      `UPDATE meta.ducklake_metadata SET value = '${dataPath.replaceAll("'", "''")}' WHERE key = 'data_path'`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  return {
    profile: { id: kind, name: kind, kind, path: join(directory, file) },
    directory,
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}

// Engine-behaviour tests read as a trusted connection (the view-trust gate has its own tests); override with `extra`.
export function accessFor(fixture: DataFixture, extra: Partial<DataAccess> = {}): DataAccess {
  return { profile: fixture.profile, s3: {}, extensionDirectory, viewsTrusted: true, ...extra };
}

export interface Lake {
  readonly profile: FileProfile;
  remove(): Promise<void>;
}

/**
 * A fresh DuckLake (DuckDB metadata, data files next to it) that `statements` fill, written by the real engine.
 * Small inserts become Parquet files unless `inlining` lets DuckLake keep them in the catalog.
 */
export async function createLake(statements: readonly string[], inlining = false): Promise<Lake> {
  const directory = await mkdtemp(join(tmpdir(), 'aantje-lake-'));
  const path = join(directory, 'lake.ducklake');
  try {
    const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
    const connection = await instance.connect();
    try {
      await connection.run('LOAD ducklake');
      await connection.run(
        `ATTACH 'ducklake:${path.replaceAll("'", "''")}' AS lake (DATA_INLINING_ROW_LIMIT ${inlining ? 10 : 0})`,
      );
      await connection.run('USE lake');
      for (const sql of statements) {
        await connection.run(sql);
      }
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  } catch (error) {
    // A statement that fails leaves no directory behind: the caller never gets a lake to remove.
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    profile: { id: 'lake', name: 'lake', kind: 'duckdb', path },
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}
