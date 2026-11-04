import type * as Duckdb from '@duckdb/node-api';
import { AantjeError, messageOf } from '../errors';
import type { SnapshotId } from '../catalog/model';
import {
  changeColumnsQuery,
  changeCountsQuery,
  changesQuery,
  columnsQuery,
  dataPathQuery,
  newestSnapshotQuery,
  nextSnapshotQuery,
  previewQuery,
  setupStatements,
} from './attach';
import { rowKindOf, summariseChanges, summaryLine } from './changes';
import type { ChangesSummary } from './changes';
import { dataError, firstLine, MISSING_LOCAL_FILE, MISSING_OBJECT, secretsOf } from './errors';
import type { CatalogFacts, Phase } from './errors';
import { maskSecrets } from '../secrets';
import { guardedOpen, interruptRepeatedly, loadEngine, MAX_TIMEOUT_MS } from './open-lake';
import type { GuardedOpen } from './open-lake';
import { CHANGE_COLUMNS, PREVIEW_LIMIT } from './types';
import { guardRelation } from './guard';
import type { GuardOptions } from './guard';
import type { DataAccess, GridColumn, GridData, GridValue, RelationColumn, TableRef } from './types';

/**
 * Reads a table's first rows in a private in-memory DuckDB with the DuckLake attached read-only; `signal` covers the
 * call.
 */
export function previewTable(access: DataAccess, table: TableRef, signal?: AbortSignal): Promise<GridData> {
  return withLake(access, table, signal, async (connection) => {
    const started = performance.now();
    const reader = await connection.runAndReadAll(previewQuery(table));
    const all = reader.getRowsJson().map((row) => row.map(toGridValue));
    return {
      table,
      columns: gridColumns(reader),
      rows: all.slice(0, PREVIEW_LIMIT),
      limit: PREVIEW_LIMIT,
      truncated: all.length > PREVIEW_LIMIT,
      elapsedMs: Math.round(performance.now() - started),
    };
  });
}

export interface ChangesResult {
  /** The first `PREVIEW_LIMIT` change rows as a grid with row kinds and a summary line. */
  readonly data: GridData;
  /** Counted over all changes of the range, not only the rows of `data`. */
  readonly summary: ChangesSummary;
}

/**
 * Rows a table gained, lost or changed after snapshot `from` up to `to` (inclusive), via `table_changes`; an expired
 * `from` starts at the next existing snapshot, no-op updates are dropped.
 */
export async function readChanges(
  access: DataAccess,
  table: TableRef,
  range: { readonly from: SnapshotId; readonly to: SnapshotId },
  signal?: AbortSignal,
): Promise<ChangesResult> {
  const { from, to } = range;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
    throw new AantjeError(
      'QUERY_FAILED',
      `The changes of "${table.schema}.${table.table}" need two snapshots, the second after the first (got @${from} and @${to}).`,
    );
  }
  return withLake(
    access,
    table,
    signal,
    async (connection) => {
      const started = performance.now();
      // table_changes is inclusive and refuses an expired start, so begin at the first existing snapshot after `from`.
      // A missing `to` still gets the error that names it.
      const next = (await connection.runAndReadAll(nextSnapshotQuery(from))).getRowsJson()[0]?.[0];
      const start = next === null || next === undefined ? to : Number(next);
      const columns = (await connection.runAndReadAll(changeColumnsQuery(table, start, to))).columnNames();
      const reader = await connection.runAndReadAll(changesQuery(table, start, to, columns));
      const read = reader.getRowsJson().map((row) => row.map(toGridValue));
      const more = read.length > PREVIEW_LIMIT;
      // A row of a change type this version does not know is left out; the summary counts them over the range.
      const known = read
        .flatMap((row) => {
          const kind = rowKindOf(row[CHANGE_COLUMNS - 1]);
          return kind === undefined ? [] : [{ row, kind }];
        })
        .slice(0, PREVIEW_LIMIT);
      if (more && known.at(-1)?.kind === 'update-before') {
        known.pop();
      }
      const rows = known.map(({ row }) => row);
      const groups = (
        await connection.runAndReadAll(changeCountsQuery(table, start, to, columns))
      ).getRowsJson();
      const summary = summariseChanges(
        groups.map(([snapshot, changeType, count]) => ({
          snapshot: Number(snapshot),
          changeType: typeof changeType === 'string' ? changeType : '',
          rows: Number(count),
        })),
        range,
        more,
      );
      return {
        data: {
          table,
          columns: gridColumns(reader),
          rows,
          limit: PREVIEW_LIMIT,
          truncated: more,
          elapsedMs: Math.round(performance.now() - started),
          rowKinds: known.map(({ kind }) => kind),
          summary: summaryLine(summary, rows.length),
        },
        summary,
      };
    },
    // The read uses table_changes over the range, which also reads data and delete files of older snapshots.
    { range: { from, to } },
  );
}

/**
 * The columns of a table or view as DuckDB resolves them. Binding a view's SQL opens files of table functions such as
 * `read_csv`, so call it for a view only after the user trusted the connection.
 */
export function describeRelation(
  access: DataAccess,
  table: TableRef,
  signal?: AbortSignal,
): Promise<readonly RelationColumn[]> {
  return withLake(access, table, signal, async (connection) => {
    // Types come from the result as in the grid: DESCRIBE quotes struct field names only where required, so the tree
    // and grid header would differ. DESCRIBE supplies only nullability (its third column, 'YES' / 'NO').
    const result = await connection.runAndReadAll(columnsQuery(table));
    const described = (await connection.runAndReadAll(`DESCRIBE ${columnsQuery(table)}`)).getRowsJson();
    return result.columnNames().map((name, index): RelationColumn => ({
      name,
      type: typeOf(result, index),
      nullable: (described[index]?.[2] ?? 'YES') !== 'NO',
    }));
  });
}

/**
 * Runs the checks that come before a read and reads nothing: for code that hands a relation to an engine of the user
 * (the notebook) and must not do so for one that aantje refuses to read.
 */
export function checkRelation(access: DataAccess, table: TableRef, signal?: AbortSignal): Promise<void> {
  return withLake(access, table, signal, () => Promise.resolve());
}

function withLake<T>(
  access: DataAccess,
  table: TableRef,
  signal: AbortSignal | undefined,
  query: (connection: Duckdb.DuckDBConnection) => Promise<T>,
  guard: Pick<GuardOptions, 'range'> = {},
): Promise<T> {
  return withEngine(
    access,
    `"${table.schema}.${table.table}"`,
    signal,
    async (connection) => {
      // One transaction for the checks and the read: both see the snapshot that the first statement pins, so an author
      // of the catalog cannot swap a view or a file path between them (on PostgreSQL, where the writer is not locked out).
      await connection.run('BEGIN TRANSACTION');
      try {
        // Before the first statement that binds the relation: a view's SQL runs with the user's rights, and a file path
        // is an address. Trust follows what is read at this snapshot; an untrusted view is refused for the caller to ask.
        await guardRelation(connection, table, access.snapshot, {
          trusted: access.viewsTrusted,
          range: guard.range,
        });
        return await query(connection);
      } finally {
        // Also after a failure, which leaves the transaction aborted; the error handler asks the connection more.
        await connection.run('ROLLBACK').catch(() => undefined);
      }
    },
    async (cause, phase, connection) => {
      if (cause instanceof AantjeError) {
        return cause;
      }
      // A gone file reads differently at an older snapshot, so ask for the newest.
      const facts =
        connection &&
        phase === 'query' &&
        (MISSING_OBJECT.test(String(cause)) || MISSING_LOCAL_FILE.test(String(cause)))
          ? await catalogFacts(connection, access)
          : {};
      return dataError(cause, phase, access, table, facts);
    },
  );
}

async function withEngine<T>(
  access: DataAccess,
  subject: string,
  signal: AbortSignal | undefined,
  query: (connection: Duckdb.DuckDBConnection) => Promise<T>,
  fail: GuardedOpen<T>['fail'],
  limitSetupOnly = false,
): Promise<T> {
  return guardedOpen({
    engine: await loadEngine(),
    access,
    signal,
    setup: setupStatements(access),
    limitSetupOnly,
    cancelledText: `Reading ${subject} was cancelled.`,
    activity: `Reading ${subject}`,
    use: ({ connection }) => query(connection),
    fail,
  });
}

/** Facts for error messages only; what the catalog cannot answer is left out. Exported for its test. */
export async function catalogFacts(
  connection: Pick<Duckdb.DuckDBConnection, 'runAndReadAll'>,
  access: DataAccess,
): Promise<CatalogFacts> {
  const first = async (sql: string): Promise<unknown> => {
    try {
      return (await connection.runAndReadAll(sql)).getRowsJson()[0]?.[0];
    } catch {
      return undefined;
    }
  };
  const newest = access.snapshot === undefined ? undefined : await first(newestSnapshotQuery());
  const dataPath = await first(dataPathQuery());
  return {
    ...(newest === null || newest === undefined ? {} : { newest: Number(newest) }),
    ...(typeof dataPath === 'string' ? { dataPath: maskSecrets(dataPath, secretsOf(access)) } : {}),
  };
}

/**
 * A failed health check statement: `text` is the whole engine message without secrets, `timedOut` marks the statement
 * limit.
 */
export class LakeFailure extends Error {
  constructor(
    readonly phase: Phase,
    readonly text: string,
    readonly timedOut = false,
  ) {
    super(firstLine(text));
    this.name = 'LakeFailure';
  }
}

function lakeFailure(cause: unknown, phase: Phase, access: DataAccess, timedOut = false): LakeFailure {
  const raw = messageOf(cause);
  // DuckDB echoes the statement ("LINE 1: ..."), which adds nothing.
  const text = maskSecrets(raw, secretsOf(access)).replace(/\r?\n\r?\nLINE \d+:[\s\S]*$/, '');
  return new LakeFailure(phase, text, timedOut);
}

/** Read-only statements of the health check on one attached lake. */
export interface LakeSession {
  /** Runs one statement and returns JSON rows; failures are `LakeFailure`, `limitMs` ends a slower statement. */
  rows(sql: string, limitMs?: number): Promise<readonly (readonly GridValue[])[]>;
}

/**
 * Runs `use` on a session with the lake at its newest snapshot. The caller limits each statement; `access.timeoutMs`
 * limits the attach only, so that a server that accepts the connection and never answers ends the setup. A failed setup is a `LakeFailure` with its `phase`; `use` should catch its statements' failures. A
 * statement that exceeded its limit is still interrupted and waited for (up to `INTERRUPT_GRACE_MS`) before the engine
 * closes, because closing a connection with a running statement blocks the thread.
 */
export function withLakeSession<T>(
  access: DataAccess,
  signal: AbortSignal | undefined,
  use: (session: LakeSession) => Promise<T>,
): Promise<T> {
  return withEngine(
    { ...access, snapshot: undefined },
    'the lake',
    signal,
    async (connection) => {
      const { session, settle } = sessionOf(connection, access);
      try {
        return await use(session);
      } finally {
        await settle();
      }
    },
    (cause, phase) =>
      Promise.resolve(cause instanceof LakeFailure ? cause : lakeFailure(cause, phase, access)),
    true,
  );
}

// How long the session waits for an interrupted statement: before the next statement and before the close.
const INTERRUPT_GRACE_MS = 3000;

function sessionOf(
  connection: Duckdb.DuckDBConnection,
  access: DataAccess,
): { session: LakeSession; settle: () => Promise<void> } {
  // After a timeout the statement may still run (a blocked network read cannot be interrupted); the next one waits.
  let pending: Promise<void> | undefined;
  let stopInterrupt: (() => void) | undefined;
  // Whether the interrupted statement ended within the grace.
  const settled = async (): Promise<boolean> => {
    if (pending === undefined) return true;
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([
      pending,
      new Promise((resolve) => {
        grace = setTimeout(resolve, INTERRUPT_GRACE_MS);
      }),
    ]);
    clearTimeout(grace);
    return pending === undefined;
  };
  const session: LakeSession = {
    async rows(sql, limitMs) {
      if (!(await settled())) {
        throw new LakeFailure(
          'query',
          'The engine is still busy with a statement that exceeded its time limit.',
          true,
        );
      }
      const running = connection
        .runAndReadAll(sql)
        .then((reader) => reader.getRowsJson().map((row) => row.map(toGridValue)));
      let timer: NodeJS.Timeout | undefined;
      let expired = false;
      try {
        if (limitMs === undefined) return await running;
        const limit = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => {
              expired = true;
              reject(
                new LakeFailure(
                  'query',
                  `The statement exceeded its time limit of ${limitMs / 1000} s and was cancelled.`,
                  true,
                ),
              );
            },
            Math.min(limitMs, MAX_TIMEOUT_MS),
          );
        });
        return await Promise.race([running, limit]);
      } catch (cause) {
        throw cause instanceof LakeFailure ? cause : lakeFailure(cause, 'query', access);
      } finally {
        clearTimeout(timer);
        if (expired) {
          stopInterrupt = interruptRepeatedly(connection);
          pending = running
            .catch(() => undefined)
            .then(() => {
              stopInterrupt?.();
              stopInterrupt = undefined;
              pending = undefined;
            });
        }
      }
    },
  };
  return {
    session,
    // Before the close: the interval must not poke a closed handle, whether the statement ended or was given up on.
    async settle() {
      if (!(await settled())) {
        stopInterrupt?.();
        stopInterrupt = undefined;
        access.log?.warn(
          `A statement that exceeded its time limit did not end within ${INTERRUPT_GRACE_MS / 1000} s of being interrupted; the engine is closed anyway.`,
        );
      }
    },
  };
}

function gridColumns(reader: Duckdb.DuckDBResultReader): GridColumn[] {
  return reader.columnNames().map((name, index): GridColumn => {
    const type = typeOf(reader, index);
    return { name, type, kind: kindOf(type) };
  });
}

function typeOf(reader: Duckdb.DuckDBResultReader, index: number): string {
  return reader.columnTypes()[index]?.toString() ?? '';
}

export function kindOf(type: string): GridColumn['kind'] {
  if (/^U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)$|^(FLOAT|DOUBLE)$|^DECIMAL\(\d+,\d+\)$/.test(type))
    return 'number';
  if (type === 'BOOLEAN') return 'boolean';
  // Lists and arrays end in "[]" / "[n]"; structs, maps and unions start with their keyword; INTERVAL arrives as an
  // object.
  if (/^(STRUCT|MAP|UNION)\(|\]$|^INTERVAL$/.test(type)) return 'nested';
  return 'text';
}

/** Turns nested values (objects, arrays) into compact JSON text; other values pass through. */
export function toGridValue(value: Duckdb.Json): GridValue {
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
}
