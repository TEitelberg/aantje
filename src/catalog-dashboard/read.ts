import { open, stat } from 'node:fs/promises';
import type { CatalogReader } from '../catalog/model';
import type { ConnectionProfile } from '../connections/profile';
import type { CatalogFile, DashboardData } from './model';

/** What the dashboard asks of the file system of the extension host; tests replace it. */
export interface CatalogFileSystem {
  /** The size of a file; undefined when there is none. */
  size(path: string): Promise<number | undefined>;
  /** The first bytes of a file; undefined when it cannot be read. */
  head(path: string, length: number): Promise<Uint8Array | undefined>;
}

export const nodeFileSystem: CatalogFileSystem = {
  size: async (path) => (await stat(path).catch(() => undefined))?.size,
  async head(path, length) {
    const handle = await open(path, 'r').catch(() => undefined);
    if (!handle) return undefined;
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

// Byte 18 of a SQLite header is the write version: 1 for a rollback journal, 2 for WAL.
const SQLITE_WRITE_VERSION = 18;

/** The file of a SQLite or DuckDB catalog and its write-ahead log, as they are now. */
export async function catalogFile(
  profile: ConnectionProfile,
  files: CatalogFileSystem,
): Promise<CatalogFile | undefined> {
  if (profile.kind !== 'sqlite' && profile.kind !== 'duckdb') return undefined;
  const sizeBytes = (await files.size(profile.path)) ?? null;
  const walBytes =
    (await files.size(profile.kind === 'sqlite' ? `${profile.path}-wal` : `${profile.path}.wal`)) ?? 0;
  if (profile.kind === 'duckdb') return { sizeBytes, walBytes };
  const header = await files.head(profile.path, SQLITE_WRITE_VERSION + 1);
  const version = header?.[SQLITE_WRITE_VERSION];
  return { sizeBytes, walBytes, ...(version === 1 || version === 2 ? { walMode: version === 2 } : {}) };
}

/** Reads the dashboard of a connection: the statistics of its catalog database, its file and the names of its tables. */
export async function readDashboard(
  reader: CatalogReader,
  profile: ConnectionProfile,
  signal: AbortSignal | undefined,
  files: CatalogFileSystem = nodeFileSystem,
  now = new Date(),
): Promise<DashboardData> {
  const database = await reader.catalogDatabase(profile.kind, signal);
  const file = await catalogFile(profile, files);
  const entries =
    database.inlined.length === 0 ? [] : await reader.entries((await reader.info()).latestSnapshot);
  return {
    connection: profile.name,
    readAt: now.toISOString(),
    database,
    ...(file ? { file } : {}),
    tableNames: entries
      .filter((entry) => entry.kind === 'table')
      .map((entry) => ({ id: entry.id, name: `${entry.schemaName}.${entry.name}` })),
  };
}
