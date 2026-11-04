import { createCatalogReader } from '../../src/catalog/reader';
import type { CatalogReader } from '../../src/catalog/model';
import { openDuckdb } from '../../src/catalog/drivers/duckdb';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { openSqlSession } from '../../src/sql/session';
import type { RunOptions, SqlEvent, SqlSession, SqlSessionOptions } from '../../src/sql/session';
import { accessFor } from './data-support';
import type { DataFixture } from './data-support';
import { wasmPath } from '../support/fixtures';

/** Every event of a script; the session stays open for the next call. */
export async function events(session: SqlSession, script: string, options?: RunOptions): Promise<SqlEvent[]> {
  const all: SqlEvent[] = [];
  for await (const event of session.run(script, options)) {
    all.push(event);
  }
  return all;
}

type Of<K extends SqlEvent['kind']> = Extract<SqlEvent, { kind: K }>;

/** The events of one kind, in order. */
export function only<K extends SqlEvent['kind']>(list: readonly SqlEvent[], kind: K): Of<K>[] {
  return list.filter((event): event is Of<K> => event.kind === kind);
}

/** The single result set of a script that has one statement. */
export async function query(session: SqlSession, sql: string): Promise<Of<'resultSet'>> {
  const [result] = only(await events(session, sql), 'resultSet');
  if (!result) throw new Error(`No result set for: ${sql}`);
  return result;
}

export async function openFixtureSession(
  fixture: DataFixture,
  mode: SqlSessionOptions['mode'] = 'read-write',
  extra: Partial<SqlSessionOptions> = {},
): Promise<SqlSession> {
  return openSqlSession({ access: accessFor(fixture), mode, ...extra });
}

/** The Explorer's view of the catalog file of a fixture (the session must not hold a DuckDB file open). */
export async function openReader(fixture: DataFixture): Promise<CatalogReader> {
  const { profile } = fixture;
  return createCatalogReader(
    profile.kind === 'sqlite'
      ? await openSqlite({ path: profile.path, wasmPath })
      : await openDuckdb({ path: profile.path }),
  );
}

/** Ids of the snapshots the Explorer sees, newest first. */
export async function snapshotIds(fixture: DataFixture): Promise<number[]> {
  const reader = await openReader(fixture);
  try {
    return (await reader.snapshots()).map(({ id }) => id);
  } finally {
    await reader.close();
  }
}
