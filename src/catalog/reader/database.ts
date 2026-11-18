import { isAantjeError } from '../../errors';
import { compareText } from '../../order';
import type { Row } from '../drivers/driver';
import type { CatalogDatabase, CatalogDatabaseTable, CatalogEngine, CatalogReader } from '../model';
import * as queries from '../queries/database';
import { CATALOG_TABLE, DUCKLAKE_TABLES } from '../queries/database';
import { INLINED_TABLE } from '../queries/maintenance';
import type { Query } from '../queries/shared';
import { toBoolean, toIsoUtcOrNull, toNumber, toNumberOrNull, toText, toTextOrNull } from './rows';
import type { Run } from './rows';

type Part = Pick<CatalogDatabase, 'engine' | 'version' | 'sizeBytes' | 'freeBytes' | 'sizesPerTable'> &
  Partial<Pick<CatalogDatabase, 'schema' | 'ssl'>> & {
    readonly tables: readonly CatalogDatabaseTable[];
  };

// What one engine read: the parts it got, and what it could not read with the reason the engine gave.
interface Reading {
  readonly unread: string[];
  /** Runs a statement; a failed statement (no privilege, no such view) gives undefined and a line in `unread`. */
  optional(what: string, query: Query): Promise<Row[] | undefined>;
}

function reading(run: Run, signal: AbortSignal | undefined): Reading {
  const unread: string[] = [];
  return {
    unread,
    async optional(what, query) {
      try {
        return await run(query, signal);
      } catch (cause) {
        if (!isAantjeError(cause) || cause.code !== 'QUERY_FAILED') throw cause;
        unread.push(`${what}: ${cause.userMessage.split(/\r?\n/)[0] ?? ''}`);
        return undefined;
      }
    },
  };
}

const bySize = (a: CatalogDatabaseTable, b: CatalogDatabaseTable): number =>
  (b.totalBytes ?? -1) - (a.totalBytes ?? -1) ||
  (b.rows ?? -1) - (a.rows ?? -1) ||
  compareText(a.name, b.name);

const positiveOrNull = (value: number | null): number | null => (value === null || value < 0 ? null : value);

async function postgres(read: Reading, run: Run, signal?: AbortSignal): Promise<Part> {
  const [database] = await run(queries.postgresDatabase(), signal);
  const tables = (await read.optional('The tables of the catalog', queries.postgresTables())) ?? [];
  return {
    engine: 'postgres',
    version: toTextOrNull(database?.version ?? null),
    schema: toText(database?.schema_name),
    sizeBytes: toNumberOrNull(database?.database_bytes ?? null),
    freeBytes: null,
    ssl: database?.ssl === null || database?.ssl === undefined ? null : toBoolean(database.ssl),
    sizesPerTable: true,
    tables: tables.map((row) => ({
      name: toText(row.table_name),
      // `reltuples` is -1 for a table that was never vacuumed or analyzed.
      rows: positiveOrNull(toNumberOrNull(row.row_estimate ?? null)),
      totalBytes: toNumber(row.total_bytes),
      tableBytes: toNumber(row.table_bytes),
      indexBytes: toNumber(row.index_bytes),
      toastBytes: toNumber(row.toast_bytes),
      deadRows: toNumberOrNull(row.dead_rows ?? null) ?? 0,
      liveRows: toNumberOrNull(row.live_rows ?? null) ?? 0,
      insertedRows: toNumberOrNull(row.inserted_rows ?? null) ?? 0,
      deletedRows: toNumberOrNull(row.deleted_rows ?? null) ?? 0,
      lastVacuum: toIsoUtcOrNull(row.last_vacuum),
      lastAutovacuum: toIsoUtcOrNull(row.last_autovacuum),
      lastAnalyze: toIsoUtcOrNull(row.last_analyze),
      lastAutoanalyze: toIsoUtcOrNull(row.last_autoanalyze),
    })),
  };
}

// The rows of each named table, one statement each; a table that cannot be counted keeps null rows.
async function counted(read: Reading, names: readonly string[]): Promise<CatalogDatabaseTable[]> {
  const tables: CatalogDatabaseTable[] = [];
  for (const name of names) {
    const rows = await read.optional(`The rows of ${name}`, queries.tableRows(name));
    tables.push({ name, rows: rows ? toNumber(rows[0]?.row_count) : null, totalBytes: null });
  }
  return tables;
}

async function sqlite(read: Reading, run: Run, signal?: AbortSignal): Promise<Part> {
  const [facts] = await run(queries.sqliteDatabase(), signal);
  const pageSize = toNumber(facts?.page_size);
  const names = (await run(queries.sqliteTables(), signal))
    .map((row) => toText(row.table_name))
    .filter((name) => CATALOG_TABLE.test(name));
  const tables = await counted(read, names);
  // `dbstat` exists only where SQLite was built with it; without it the tables have rows and no sizes.
  let sizes: Row[] | undefined;
  try {
    sizes = await run(queries.sqliteTableBytes(), signal);
  } catch (cause) {
    if (!isAantjeError(cause) || cause.code !== 'QUERY_FAILED') throw cause;
  }
  const bytes = new Map((sizes ?? []).map((row) => [toText(row.table_name), toNumber(row.total_bytes)]));
  return {
    engine: 'sqlite',
    version: toTextOrNull(facts?.version ?? null),
    sizeBytes: pageSize * toNumber(facts?.page_count),
    freeBytes: pageSize * toNumber(facts?.free_pages),
    sizesPerTable: sizes !== undefined,
    tables: tables.map((table) => ({ ...table, totalBytes: bytes.get(table.name) ?? null })),
  };
}

async function duckdb(run: Run, signal?: AbortSignal): Promise<Part> {
  const [facts] = await run(queries.duckdbDatabase(), signal);
  const blockSize = toNumberOrNull(facts?.block_size ?? null);
  const blocks = (value: unknown): number | null =>
    blockSize === null || typeof value !== 'number' ? null : blockSize * value;
  return {
    engine: 'duckdb',
    version: toTextOrNull(facts?.version ?? null),
    sizeBytes: blocks(facts?.total_blocks),
    freeBytes: blocks(facts?.free_blocks),
    sizesPerTable: false,
    tables: (await run(queries.duckdbTables(), signal))
      .map((row) => ({
        name: toText(row.table_name),
        rows: toNumberOrNull(row.row_count ?? null),
        totalBytes: null,
      }))
      .filter((table) => CATALOG_TABLE.test(table.name)),
  };
}

// A Quack server answers SELECT on its tables but tells nothing about its database file.
async function quack(read: Reading, inlined: readonly { readonly name: string }[]): Promise<Part> {
  return {
    engine: 'quack',
    version: null,
    sizeBytes: null,
    freeBytes: null,
    sizesPerTable: false,
    tables: (await counted(read, [...DUCKLAKE_TABLES, ...inlined.map(({ name }) => name)])).filter(
      (table) => table.rows !== null,
    ),
  };
}

async function inlinedTables(
  run: Run,
  signal?: AbortSignal,
): Promise<{ readonly name: string; readonly tableId: number }[]> {
  try {
    return (await run(queries.inlinedDataTables(), signal))
      .map((row) => ({ name: toText(row.table_name), tableId: toNumber(row.table_id) }))
      .filter(({ name }) => INLINED_TABLE.test(name));
  } catch (cause) {
    // A catalog of specification 1.0 has no inlined data.
    if (isAantjeError(cause) && cause.code === 'QUERY_FAILED') return [];
    throw cause;
  }
}

/** The read of the Catalog Dashboard. */
export function databaseReads(run: Run): Pick<CatalogReader, 'catalogDatabase'> {
  return {
    async catalogDatabase(engine: CatalogEngine, signal?: AbortSignal): Promise<CatalogDatabase> {
      const read = reading(run, signal);
      const inlined = await inlinedTables(run, signal);
      const part =
        engine === 'postgres'
          ? await postgres(read, run, signal)
          : engine === 'sqlite'
            ? await sqlite(read, run, signal)
            : engine === 'duckdb'
              ? await duckdb(run, signal)
              : await quack(read, inlined);
      // The quack tables count their inlined tables themselves; the other engines list them with the rest. A quack
      // table that is missing was left out, so that a catalog of 1.0 does not list them as unread.
      const unread = engine === 'quack' ? [] : read.unread;
      return { ...part, tables: part.tables.toSorted(bySize), inlined, unread };
    },
  };
}
