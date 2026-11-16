import { quoteIdentifier, quoteLiteral } from '../catalog/ddl';
import { setupStatements } from '../data/attach';
import { secretsOf } from '../data/errors';
import { guardRelation } from '../data/guard';
import { withOpenLake } from '../data/open-lake';
import type { DataAccess, TableRef } from '../data/types';
import { loadEngine } from '../duckdb/engine';
import { extensionFailure, scrubbed } from '../duckdb/messages';
import { AantjeError } from '../errors';
import { selectList } from './mapping';
import { ICEBERG, icebergSetup } from './statements';
import type { IcebergTarget } from './target';

/** What to do with a table that the Iceberg catalog has already. */
export type ExistingTables = 'stop' | 'replace';

/**
 * What is copied: the whole lake, one schema into a namespace, or one table to a namespace and name. The tables of the
 * lake keep their schema as namespace; the tables of a schema keep their names.
 */
export type CopyScope =
  | { readonly kind: 'lake' }
  | { readonly kind: 'schema'; readonly schema: string; readonly namespace: string }
  | {
      readonly kind: 'table';
      readonly schema: string;
      readonly table: string;
      readonly namespace: string;
      readonly name: string;
    };

export const LAKE_COPY: CopyScope = { kind: 'lake' };

export interface CopyRequest {
  /** The lake; `snapshot` undefined copies the newest one. */
  readonly access: DataAccess;
  readonly target: IcebergTarget;
  /** The client secret or token of the target. */
  readonly secret: string | undefined;
  readonly existing: ExistingTables;
  /** The whole lake when undefined. */
  readonly scope?: CopyScope;
  /** The `PARTITIONED BY` list of each table that Iceberg can partition like the lake, by `schema.table`. */
  readonly partitions?: ReadonlyMap<string, string>;
  /** The line under the title of the progress notification. */
  readonly report?: (text: string) => void;
}

/** Where a table of the lake goes in the Iceberg catalog. */
export interface IcebergName {
  readonly namespace: string;
  readonly name: string;
}

export interface TableCopy extends TableRef {
  readonly status: 'copied' | 'failed';
  /** The Iceberg table it was (to be) written to. */
  readonly iceberg: IcebergName;
  readonly rows?: number;
  /** The Iceberg snapshot that the copy wrote. */
  readonly icebergSnapshot?: string;
  /** Columns that Iceberg got as another type, for example `id: UBIGINT as DECIMAL(20,0)`. */
  readonly converted?: readonly string[];
  /** True when the table was written partitioned like the DuckLake table. */
  readonly partitioned?: true;
  /** The first line of the failure, free of secrets. */
  readonly error?: string;
}

export interface CopyResult {
  /** The DuckLake snapshot every table was read at. */
  readonly snapshot: number;
  readonly snapshotTime: string | undefined;
  readonly tables: readonly TableCopy[];
}

const ICE = ICEBERG;

const tableKey = (table: TableRef): string => `${table.schema}.${table.table}`;
export const quoted = (table: TableRef): string =>
  `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)}`;
/** The Iceberg table in the engine: `ice."namespace"."name"`. */
export const icebergTable = ({ namespace, name }: IcebergName): string =>
  `${ICE}.${quoteIdentifier(namespace)}.${quoteIdentifier(name)}`;

/** Where a table of the lake goes for the scope of a copy. */
export function icebergNameOf(scope: CopyScope, table: TableRef): IcebergName {
  if (scope.kind === 'table') return { namespace: scope.namespace, name: scope.name };
  return { namespace: scope.kind === 'schema' ? scope.namespace : table.schema, name: table.table };
}

/** Whether a table of the lake belongs to the scope of a copy. */
export const inScope = (scope: CopyScope, table: TableRef): boolean =>
  scope.kind === 'lake' ||
  (table.schema === scope.schema && (scope.kind === 'schema' || table.table === scope.table));

/** The table properties that tell where an Iceberg table came from, so that the origin can be read on any machine. */
export function originProperties(table: TableRef, snapshot: number, time: string | undefined): string {
  const properties: [string, string][] = [
    ['aantje.ducklake.table', tableKey(table)],
    ['aantje.ducklake.snapshot-id', String(snapshot)],
  ];
  if (time !== undefined) properties.push(['aantje.ducklake.snapshot-time', time]);
  return properties.map(([key, value]) => `${quoteLiteral(key)} = ${quoteLiteral(value)}`).join(', ');
}

/**
 * Copies the tables of the scope (the whole lake, a schema, a table), all at one snapshot, into the Iceberg catalog of
 * the target. Views and macros are not copied. Each table is one Iceberg commit, so a reader of the catalog sees it
 * complete or not at all; a table that fails is reported and the others go on. The read is the guarded read of the data
 * preview, in the same transaction. A table is partitioned like the DuckLake table where Iceberg has its transforms, and
 * gets table properties with its origin.
 */
export async function copyToIceberg(request: CopyRequest, signal?: AbortSignal): Promise<CopyResult> {
  const { access, target, secret, existing } = request;
  const scope = request.scope ?? LAKE_COPY;
  const hidden = [...secretsOf(access), ...(secret ? [secret] : [])];
  const report = request.report ?? (() => undefined);
  return withOpenLake({
    engine: await loadEngine(),
    access,
    signal,
    setup: setupStatements(access, undefined, undefined, icebergSetup(target, secret)),
    // The copy runs as long as it takes; the time limit covers the attach.
    limitSetupOnly: true,
    cancelledText: 'The sync to Iceberg was cancelled.',
    activity: 'Attaching the lake and the Iceberg catalog',
    use: async ({ connection }) => {
      const rows = async (sql: string): Promise<unknown[][]> =>
        (await connection.runAndReadAll(sql)).getRowsJson();
      const newest = Number((await rows("SELECT max(snapshot_id) FROM ducklake_snapshots('lake')"))[0]?.[0]);
      const snapshot = access.snapshot ?? newest;
      const found = (
        await rows(`SELECT snapshot_time FROM ducklake_snapshots('lake') WHERE snapshot_id = ${snapshot}`)
      )[0]?.[0];
      const time = typeof found === 'string' ? found : undefined;
      const tables = (
        await rows(
          `SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = 'lake' AND NOT internal ORDER BY 1, 2`,
        )
      )
        .map(([schema, name]): TableRef => ({ schema: String(schema), table: String(name) }))
        .filter((table) => inScope(scope, table));
      if (tables.length === 0) {
        throw new AantjeError('QUERY_FAILED', `The lake has no table to copy at snapshot ${snapshot}.`);
      }
      const present = new Set(
        (
          await rows(`SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = '${ICE}'`)
        ).map(([schema, name]) => `${String(schema)}.${String(name)}`),
      );
      const isPresent = (table: TableRef): boolean => {
        const { namespace, name } = icebergNameOf(scope, table);
        return present.has(`${namespace}.${name}`);
      };
      const clashes = tables.filter(isPresent);
      if (existing === 'stop' && clashes.length > 0) {
        const names = clashes
          .slice(0, 5)
          .map((table) => {
            const { namespace, name } = icebergNameOf(scope, table);
            return `${namespace}.${name}`;
          })
          .join(', ');
        throw new AantjeError(
          'QUERY_FAILED',
          `The Iceberg catalog "${target.name}" already has ${clashes.length} of these tables (${names}${clashes.length > 5 ? ', ...' : ''}). Nothing was written. Sync again and choose to replace them.`,
        );
      }

      const copies: TableCopy[] = [];
      for (const [index, table] of tables.entries()) {
        signal?.throwIfAborted();
        report(`${tableKey(table)} (${index + 1} of ${tables.length})`);
        copies.push(await copyTable(table, clashes.includes(table)));
      }
      return { snapshot, snapshotTime: time, tables: copies };

      async function copyTable(table: TableRef, replace: boolean): Promise<TableCopy> {
        const iceberg = icebergNameOf(scope, table);
        const destination = icebergTable(iceberg);
        try {
          await connection.run(`CREATE SCHEMA IF NOT EXISTS ${ICE}.${quoteIdentifier(iceberg.namespace)}`);
          if (replace) await connection.run(`DROP TABLE ${destination}`);
          const partitioned = request.partitions?.get(tableKey(table));
          await connection.run('BEGIN TRANSACTION');
          try {
            await guardRelation(connection, table, snapshot, {
              trusted: access.viewsTrusted,
              storage: access.storage?.config,
            });
            const source = `lake.${quoted(table)} AT (VERSION => ${snapshot})`;
            const described = await rows(`DESCRIBE SELECT * FROM ${source}`);
            const { list, converted } = selectList(
              described.map(([name, type]) => [String(name), String(type)]),
            );
            const result = await connection.runAndReadAll(
              `CREATE TABLE ${destination}${partitioned === undefined ? '' : ` PARTITIONED BY (${partitioned})`} AS SELECT ${list} FROM ${source}`,
            );
            // In the commit of the table: setting properties writes no Iceberg snapshot of its own.
            await connection.run(
              `ALTER TABLE ${destination} SET (${originProperties(table, snapshot, time)})`,
            );
            await connection.run('COMMIT');
            return {
              ...table,
              status: 'copied',
              iceberg,
              rows: Number(result.rowsChanged),
              ...(converted.length === 0 ? {} : { converted }),
              ...(partitioned === undefined ? {} : { partitioned: true as const }),
              icebergSnapshot: await icebergSnapshotOf(rows, destination),
            };
          } catch (failure) {
            await connection.run('ROLLBACK').catch(() => undefined);
            throw failure;
          }
        } catch (failure) {
          if (signal?.aborted) throw failure;
          return { ...table, status: 'failed', iceberg, error: scrubbed(failure, hidden).line };
        }
      }
    },
    fail: (cause, phase) => {
      if (cause instanceof AantjeError) return cause;
      const { line } = scrubbed(cause, hidden);
      return phase === 'extension'
        ? extensionFailure('A DuckDB extension that the Iceberg sync needs', line)
        : new AantjeError('CONNECTION_FAILED', `Cannot sync to Iceberg: ${line}`, { cause: new Error(line) });
    },
  });
}

/** The newest Iceberg snapshot of the table as text (the ids are 64 bit); undefined when the extension cannot say. */
export async function icebergSnapshotOf(
  rows: (sql: string) => Promise<unknown[][]>,
  table: string,
): Promise<string | undefined> {
  try {
    const found = await rows(
      `SELECT CAST(snapshot_id AS VARCHAR) FROM iceberg_snapshots(${table}) ORDER BY sequence_number DESC LIMIT 1`,
    );
    const id = found[0]?.[0];
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The target in words for a message. */
export const describeTarget = (target: IcebergTarget): string =>
  `${target.name} (${target.warehouse} at ${target.endpoint})`;
