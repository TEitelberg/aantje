// The read of the Inactive Tables report: the tables of the scope with their size, their last change from the catalog,
// and the last read of each in the local Query History, whose statements DuckDB's parser reads.
import { foldIdentifier, sameIdentifier } from '../catalog/ddl';
import { queryCancelled } from '../catalog/drivers/limits';
import type { CatalogReader, SchemaInfo, SnapshotId, TableInfo } from '../catalog/model';
import { LAKE } from '../data/attach';
import type { ReportScope } from '../shell/scope';
import { isObject } from '../guards';
import type { HistoryEntry } from '../sql/history';
import { statementReferences } from '../sql/parse-tree';
import type { Reference } from '../sql/parse-tree';
import { inactiveTables } from './model';
import type { InactiveData, InactiveTable } from './model';

// Schemas whose tables are read at the same time: a lake can have hundreds of schemas.
const READ_AT_ONCE = 4;
// The schema that an unqualified name means in the SQL editor, which attaches the lake as its default catalog.
const DEFAULT_SCHEMA = 'main';

/** What the report reads: the catalog, the statements of this user, and the parser that reads them. */
export interface InactiveSources {
  readonly reader: Pick<CatalogReader, 'info' | 'schemas' | 'tables' | 'lastTableChanges'>;
  /** The statements of this user's Query History of the connection; nothing of it leaves the machine. */
  readonly history: readonly HistoryEntry[];
  /** The `json_serialize_sql` document of a statement; nothing is run. */
  readonly serialize: (sql: string) => Promise<string>;
}

/** The names a query reads; undefined for a text that is not exactly one query (DuckDB serializes only SELECT). */
function queryReferences(serialized: string): readonly Reference[] | undefined {
  let document: unknown;
  try {
    document = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (!isObject(document) || document['error'] === true) return undefined;
  const statements = Array.isArray(document['statements']) ? document['statements'] : [];
  return statements.length === 1 ? statementReferences(statements[0]).references : undefined;
}

const stopped = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw queryCancelled();
};

async function scopeTables(
  reader: InactiveSources['reader'],
  snapshot: SnapshotId,
  scope: ReportScope,
  signal: AbortSignal | undefined,
): Promise<{ readonly schema: SchemaInfo; readonly table: TableInfo }[]> {
  const schemas = (await reader.schemas(snapshot)).filter(
    ({ id }) => scope.kind === 'lake' || id === scope.id,
  );
  const found: { schema: SchemaInfo; table: TableInfo }[] = [];
  for (let start = 0; start < schemas.length; start += READ_AT_ONCE) {
    stopped(signal);
    const batch = await Promise.all(
      schemas
        .slice(start, start + READ_AT_ONCE)
        .map(async (schema) =>
          (await reader.tables(schema.id, snapshot)).map((table) => ({ schema, table })),
        ),
    );
    found.push(...batch.flat());
  }
  return found;
}

/** The table a name of a query means: catalog `lake` or none, the schema `main` when it names none. */
function tableOf(
  reference: { readonly catalog: string; readonly schema: string; readonly name: string },
  tables: readonly { readonly id: number; readonly schema: string; readonly name: string }[],
): number | undefined {
  if (reference.catalog !== '' && !sameIdentifier(reference.catalog, LAKE)) return undefined;
  const schema = reference.schema === '' ? DEFAULT_SCHEMA : reference.schema;
  return tables.find(
    (table) => sameIdentifier(table.schema, schema) && sameIdentifier(table.name, reference.name),
  )?.id;
}

/**
 * The newest time each table was read by a query of the Query History that ran without an error. Only queries count:
 * DuckDB's parser serializes a SELECT, and a statement that writes is no read here.
 */
export async function lastReads(
  sources: Pick<InactiveSources, 'history' | 'serialize'>,
  tables: readonly { readonly id: number; readonly schema: string; readonly name: string }[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<number, number>> {
  const reads = new Map<number, number>();
  const names = new Set(tables.map((table) => foldIdentifier(table.name)));
  for (const entry of sources.history.filter((candidate) => candidate.status === 'ok')) {
    stopped(signal);
    const references = queryReferences(await sources.serialize(entry.sql));
    if (!references) continue;
    for (const reference of references) {
      if (reference.kind !== 'relation' || !names.has(foldIdentifier(reference.name))) continue;
      const id = tableOf(reference, tables);
      if (id !== undefined) reads.set(id, Math.max(reads.get(id) ?? 0, entry.startedAt));
    }
  }
  return reads;
}

/**
 * The tables of the scope at the newest snapshot without a change for `days` days before `now`, with their last change,
 * size and last read.
 */
export async function readInactive(
  sources: InactiveSources,
  connection: string,
  request: { readonly scope: ReportScope; readonly days: number },
  signal?: AbortSignal,
  now: Date = new Date(),
): Promise<InactiveData> {
  const { reader } = sources;
  const { scope, days } = request;
  const snapshot = (await reader.info()).latestSnapshot;
  const [found, changes] = await Promise.all([
    scopeTables(reader, snapshot, scope, signal),
    reader.lastTableChanges(snapshot, signal),
  ]);
  const readAt = now.toISOString();
  const changeOf = new Map(changes.map(({ tableId, ...change }) => [tableId, change]));
  const all = found.map(({ schema, table }): InactiveTable => ({
    id: table.id,
    schemaId: schema.id,
    schema: schema.name,
    name: table.name,
    comment: table.comment,
    rows: table.stats.rows,
    ...(table.stats.approximate ? { approximate: true as const } : {}),
    sizeBytes: table.stats.sizeBytes,
    files: table.stats.files,
    change: changeOf.get(table.id) ?? null,
    lastRead: null,
  }));
  const inactive = inactiveTables(all, readAt, days);
  const reads = await lastReads(sources, inactive, signal);
  return {
    connection,
    scope,
    readAt,
    snapshot,
    days,
    tables: inactive.map((table) => {
      const read = reads.get(table.id);
      return read === undefined ? table : { ...table, lastRead: new Date(read).toISOString() };
    }),
    tableCount: found.length,
  };
}
