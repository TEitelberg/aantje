import { readFile, stat } from 'node:fs/promises';
import initSqlJs from 'sql.js';
import type { ParamsObject } from 'sql.js';
import { AantjeError, isErrnoException, messageOf } from '../../errors';
import type { Driver, QueryOptions, Row, Value } from './driver';
import { catalogClosed, queryCancelled, queryFailed, unreadableFile, unsafeInteger } from './limits';

interface SqliteOptions {
  /** SQLite file that holds the `ducklake_*` tables. */
  readonly path: string;
  /** Location of `sql-wasm.wasm` (copied to `dist/` by the build). */
  readonly wasmPath: string;
}

/**
 * Opens an in-memory copy (sql.js): the file stays untouched and a writer's lock does not block; reconnect to see new
 * commits.
 */
export async function openSqlite({ path, wasmPath }: SqliteOptions): Promise<Driver> {
  const bytes = await readCatalogFile(path);
  const SQL = await initSqlJs({ wasmBinary: toArrayBuffer(await readFile(wasmPath)) });
  const db = new SQL.Database(bytes);
  try {
    db.run('PRAGMA query_only = ON');
    db.exec('SELECT count(*) FROM sqlite_master');
  } catch (cause) {
    db.close();
    throw new AantjeError('CONNECTION_FAILED', `"${path}" is not a valid SQLite database.`, { cause });
  }

  // Like the other drivers: a query after close() names the closed connection, not a failed statement, because
  // the reader takes QUERY_FAILED for a missing table.
  let closed = false;
  return {
    query(sql: string, params: readonly Value[] = [], options?: QueryOptions): Promise<Row[]> {
      if (closed) {
        return Promise.reject(catalogClosed());
      }
      if (options?.signal?.aborted) {
        return Promise.reject(queryCancelled());
      }
      try {
        const statement = db.prepare(sql);
        try {
          statement.bind(params.map((value) => (typeof value === 'boolean' ? Number(value) : value)));
          const rows: Row[] = [];
          while (statement.step()) {
            rows.push(toRow(statement.getAsObject()));
          }
          return Promise.resolve(rows);
        } finally {
          statement.free();
        }
      } catch (cause) {
        return Promise.reject(queryFailed(messageOf(cause), cause));
      }
    },
    close(): Promise<void> {
      if (!closed) {
        closed = true;
        db.close();
      }
      return Promise.resolve();
    },
  };
}

async function readCatalogFile(path: string): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    const code = isErrnoException(cause) ? cause.code : undefined;
    throw unreadableFile(path, code, cause);
  }
  // A non-empty write-ahead log holds commits missing from the main file and cannot be replayed here.
  const wal = await stat(`${path}-wal`).catch(() => undefined);
  if (wal && wal.size > 0) {
    throw new AantjeError(
      'CONNECTION_FAILED',
      `"${path}" has an uncheckpointed write-ahead log. Close the application that writes to it or run a checkpoint, then connect again.`,
    );
  }
  return bytes;
}

function toRow(object: ParamsObject): Row {
  const row: Record<string, Value> = {};
  for (const [key, value] of Object.entries(object)) {
    // sql.js returns every integer as a double: one beyond 2^53 is already rounded. Like the other drivers, refuse it
    // instead of passing on a wrong id or count.
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw unsafeInteger(value);
    }
    row[key.toLowerCase()] = value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value;
  }
  return row;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
