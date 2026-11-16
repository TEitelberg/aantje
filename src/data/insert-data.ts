import type * as Duckdb from '@duckdb/node-api';
import { queryCancelled } from '../catalog/drivers/limits';
import type { SnapshotId } from '../catalog/model';
import type { Tokenize } from '../ddl-script/check';
import {
  BATCH_ROWS,
  batchText,
  insertScript,
  measureQuery,
  overLimits,
  scriptBytes,
  valuesQuery,
} from '../ddl-script/insert-data';
import type { InsertScript, RowsMeasure } from '../ddl-script/insert-data';
import type { CreatedTable } from '../ddl-script/table-ddl';
import type { BoundColumn } from '../export/copy';
import { describeQuery } from '../export/copy';
import { replacingFile } from '../export/file';
import type { Append } from '../export/file';
import { groupedPlural } from '../shell/numbers';
import { newestSnapshotQuery } from './attach';
import { withWholeRelation } from './engine';
import type { DataAccess, TableRef } from './types';

// Script as INSERT with Data in the read-only engine of the data preview: a first read binds the columns and measures
// the rows in one aggregate query, a second one at the same snapshot streams the text of the rows. Between them aantje
// asks when the script would be large. Nothing runs in the lake but reads.

/** What the first read found: the snapshot it read at, the bound columns and the measure of the rows. */
export interface MeasuredRelation extends RowsMeasure {
  readonly snapshot: SnapshotId | undefined;
  readonly columns: readonly BoundColumn[];
}

const numberOf = (value: unknown): number => Number(value ?? 0);
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Binds the columns of a table or view and measures its rows in one aggregate query, without reading them out: the
 * rows, and the bytes and line breaks of their text in the script. A read of the newest snapshot names the snapshot it
 * read, so that the rows are read there again.
 */
export function measureRelation(
  access: DataAccess,
  table: TableRef,
  signal?: AbortSignal,
): Promise<MeasuredRelation> {
  return withWholeRelation(access, table, signal, async (connection, relation) => {
    const described = await connection.runAndReadAll(describeQuery(`SELECT * FROM ${relation}`));
    const columns = described
      .getRowsJson()
      .map(([name, type]) => ({ name: textOf(name), type: textOf(type) }));
    const newest =
      access.snapshot ??
      (await connection.runAndReadAll(newestSnapshotQuery())).getRowsJson()[0]?.[0] ??
      undefined;
    const [rows, bytes, lineBreaks] =
      (await connection.runAndReadAll(measureQuery(relation, columns))).getRowsJson()[0] ?? [];
    return {
      snapshot: newest === undefined ? undefined : Number(newest),
      columns,
      rows: numberOf(rows),
      bytes: numberOf(bytes),
      lineBreaks: numberOf(lineBreaks),
    };
  });
}

/**
 * Reads the rows of the relation and hands the script to `append` part by part: the head, each INSERT of `BATCH_ROWS`
 * rows, the tail. `columns` are the ones that the measure bound, whose types the script casts to. The rows that it
 * wrote.
 */
export function streamScript(
  access: DataAccess,
  table: TableRef,
  script: InsertScript,
  columns: readonly BoundColumn[],
  append: Append,
  signal?: AbortSignal,
): Promise<number> {
  return withWholeRelation(access, table, signal, async (connection, relation) => {
    await append(script.head);
    const rows =
      columns.length === 0
        ? 0
        : await appendBatches(connection, valuesQuery(relation, columns), script, append, signal);
    await append(script.tail);
    return rows;
  });
}

/** Streams the lines of `valuesQuery` and hands them to `append` as INSERT statements of `BATCH_ROWS` rows; the rows. */
async function appendBatches(
  connection: Duckdb.DuckDBConnection,
  query: string,
  script: InsertScript,
  append: Append,
  signal: AbortSignal | undefined,
): Promise<number> {
  const result = await connection.stream(query);
  let rows = 0;
  let batch: string[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const lines = batch;
    batch = [];
    rows += lines.length;
    await append(batchText(script, lines));
  };
  try {
    for await (const chunk of result.yieldRowsJson()) {
      if (signal?.aborted) throw queryCancelled();
      for (const [line] of chunk) {
        batch.push(textOf(line));
        if (batch.length === BATCH_ROWS) await flush();
      }
    }
    await flush();
    return rows;
  } finally {
    result.closeSync();
  }
}

/** What the command asks the user and where its result goes; the VS Code adapter or a test answers. */
export interface InsertDataEnv {
  /**
   * A read of the relation at the snapshot (undefined: the newest) under a notification with Cancel, with the view
   * trust of the connection (`DataActions.read`).
   */
  readonly read: <T>(
    snapshot: SnapshotId | undefined,
    title: string,
    read: (access: DataAccess, signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  readonly tokenize: Tokenize;
  /** The table as Script as CREATE writes it; undefined for a view, whose CREATE TABLE has the bound columns. */
  readonly table?: () => Promise<CreatedTable>;
  /** Asks what to do with a large script: create it in an editor, save it to a file, or nothing (undefined). */
  readonly ask: (question: {
    readonly rows: number;
    readonly bytes: number;
  }) => Promise<'create' | 'save' | undefined>;
  /** Asks for the .sql file; undefined when the user cancelled. */
  readonly savePath: () => Promise<string | undefined>;
  /** Opens the script in a new SQL document bound to the connection, without running it. */
  readonly open: (text: string) => Promise<void>;
  readonly info: (message: string) => void;
}

/**
 * Script as INSERT with Data on a table or view: measures it, builds the script around its rows and asks first when
 * there are more than `ROW_LIMIT` rows or the script would be larger than `SIZE_LIMIT`. Then the rows are read, into a
 * new SQL document, or for Save as File straight into the file, part by part.
 */
export async function scriptInsertWithData(
  env: InsertDataEnv,
  table: TableRef,
  snapshot: SnapshotId | undefined,
): Promise<void> {
  const name = `${table.schema}.${table.table}`;
  const measured = await env.read(snapshot, `Measuring ${name}...`, (access, signal) =>
    measureRelation(access, table, signal),
  );
  const script = await insertScript(
    {
      schemaName: table.schema,
      name: table.table,
      source: env.table ? { kind: 'table', table: await env.table() } : { kind: 'view' },
      columns: measured.columns,
      rows: measured.rows,
      snapshot: measured.snapshot,
    },
    env.tokenize,
  );
  const bytes = scriptBytes(script, measured);
  const choice = overLimits(measured.rows, bytes) ? await env.ask({ rows: measured.rows, bytes }) : 'create';
  if (choice === undefined) return;
  const read = (append: Append): Promise<number> =>
    env.read(measured.snapshot, `Scripting ${name}...`, (access, signal) =>
      streamScript(access, table, script, measured.columns, append, signal),
    );
  if (choice === 'save') {
    const path = await env.savePath();
    if (path === undefined) return;
    const rows = await replacingFile(path, read);
    env.info(`Saved the script with ${groupedPlural(rows, 'row')} of "${name}" to ${path}.`);
    return;
  }
  const parts: string[] = [];
  await read((text) => {
    parts.push(text);
    return Promise.resolve();
  });
  await env.open(parts.join(''));
}
