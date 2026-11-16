// The MCP tools that hand a statement to DuckDB: explain (EXPLAIN, which runs nothing), explain_analyze (Analysis),
// profile (Statistics) and sample_rows. They run in the MCP session of the connection, never in the session of a SQL
// editor; the last three only run a statement that reads. Free of the VS Code API.
import * as z from 'zod';
import { isAantjeError } from '../errors';
import type { SqlTokenizer } from '../dependencies/parser';
import type { RunAround } from '../sql/editor';
import { analysis, profiler } from '../sql/profile';
import type { SqlEvent, SqlSession } from '../sql/session';
import type { ProfileReport } from '../tips/collect';
import type { Tip } from '../tips/model';
import { ToolError } from './catalog';
import type { OpenCatalog } from './catalog';
import type { McpSessions } from './sessions';
import { mayName, oneStatement } from './statements';
import type { CheckedStatement } from './statements';

/** The most characters of a plan, a profile or the rows that a result holds. */
export const MAX_RESULT_CHARACTERS = 256 * 1024;
/** EXPLAIN answers with a row or two. */
const EXPLAIN_ROWS = 10;

export interface ExecuteEnv {
  readonly sessions: McpSessions;
  readonly tokenizer: SqlTokenizer;
  /** Whether the user trusts the views of the connection; `confirm` asks in VS Code and throws on a decline. */
  readonly trust: {
    trusted(profile: OpenCatalog['profile']): boolean;
    confirm(profile: OpenCatalog['profile']): Promise<void>;
  };
  /** The performance tips of a plan or a profile of the connection, as Analysis and Statistics show them. */
  readonly tips: (connectionId: string) => (report: ProfileReport) => Promise<readonly Tip[]>;
  /** `aantje.queryTimeoutSeconds` in ms; undefined for none. */
  readonly timeoutMs: () => number | undefined;
  /** The rows that profile reads of a result, as Statistics in the SQL editor does (`aantje.sql.maxRows`). */
  readonly resultRows: () => number;
  /** `aantje.mcp.maxRows`: 0 returns no rows. */
  readonly sampleRows: () => number;
}

const TIP = z.object({
  kind: z.string(),
  title: z.string(),
  facts: z.array(z.string()),
  advice: z.string(),
  script: z.string().optional(),
});

const BASE = {
  connection: z.string(),
  statement: z.string(),
  elapsedMs: z.number(),
};

/** A JSON document of DuckDB, parsed; as cut text when it is too large. */
const DOCUMENT = {
  /** Null when the document was too large: then `text` holds its start. */
  json: z.unknown().nullable(),
  text: z.string().optional(),
  truncated: z.boolean(),
};

export const EXPLAINED = z.object({ ...BASE, plan: z.object(DOCUMENT) });
export const ANALYZED = z.object({ ...BASE, plan: z.object(DOCUMENT), tips: z.array(TIP) });
export const PROFILED = z.object({
  ...BASE,
  profile: z.object(DOCUMENT),
  tips: z.array(TIP),
  rowsRead: z.number(),
  resultCut: z.boolean(),
});
export const SAMPLED = z.object({
  ...BASE,
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  truncated: z.boolean(),
});

function documentOf(text: string): z.infer<z.ZodObject<typeof DOCUMENT>> {
  if (text.length > MAX_RESULT_CHARACTERS) {
    return { json: null, text: text.slice(0, MAX_RESULT_CHARACTERS), truncated: true };
  }
  try {
    return { json: JSON.parse(text) as unknown, truncated: false };
  } catch {
    return { json: null, text, truncated: false };
  }
}

/** The names that make a statement bind catalog SQL: the views, and the macros, which may read one. */
async function viewNames(catalog: OpenCatalog): Promise<Set<string>> {
  const { reader, snapshot } = catalog;
  const { latestSnapshot } = await reader.info();
  const snapshots = [...new Set([snapshot, latestSnapshot])];
  const read = await Promise.all(
    snapshots.map(async (at) => {
      const views = await reader.views(null, at);
      return views.length === 0 ? [] : [...views, ...(await reader.macros(null, at))];
    }),
  );
  return new Set(read.flat().map(({ name }) => name.toLowerCase()));
}

/** A statement that may bind a view of an untrusted connection asks in VS Code first, as Select Top 1000 Rows does. */
async function guardViews(env: ExecuteEnv, catalog: OpenCatalog, statement: CheckedStatement): Promise<void> {
  if (env.trust.trusted(catalog.profile)) return;
  if (!mayName(statement.tokens, await viewNames(catalog))) return;
  try {
    await env.trust.confirm(catalog.profile);
  } catch (error) {
    throw isAantjeError(error)
      ? new ToolError(
          `The statement may bind a view of "${catalog.profile.name}", and the user did not trust the views of this connection in VS Code. Without that trust aantje binds no view.`,
        )
      : error;
  }
}

/** A statement of the session that is no part of the result: the settings of the profiler. */
function quietRun(session: SqlSession) {
  return async (sql: string) => {
    let rows: Extract<SqlEvent, { kind: 'resultSet' }>['rows'] = [];
    for await (const event of session.run(sql)) {
      if (event.kind === 'error') throw new ToolError(session.mask(event.message));
      if (event.kind === 'resultSet') rows = event.rows;
    }
    return rows;
  };
}

interface Run {
  readonly events: readonly SqlEvent[];
  readonly elapsedMs: number;
}

/**
 * Runs the text with the statements around it, as the SQL editor does, and puts the settings back after it. A session
 * that refuses that is closed. An error of DuckDB is the error of the tool; so is the timeout and a cancel.
 */
async function runIn(
  env: ExecuteEnv,
  catalog: OpenCatalog,
  sql: string,
  options: { readonly around?: RunAround; readonly maxRows?: number; readonly signal: AbortSignal },
): Promise<Run> {
  const limit = env.timeoutMs();
  const timeout = limit === undefined ? undefined : AbortSignal.timeout(limit);
  const signal = timeout ? AbortSignal.any([options.signal, timeout]) : options.signal;
  // The time limit counts from the call: a call that waits for the one before it can run out while it waits.
  const stopped = (): ToolError | undefined =>
    timeout?.aborted
      ? new ToolError(
          `The statement ran longer than aantje.queryTimeoutSeconds (${Math.round((limit ?? 0) / 1000)} s) and was stopped.`,
        )
      : options.signal.aborted
        ? new ToolError('The call was cancelled; the statement was stopped.')
        : undefined;
  try {
    return await env.sessions.use(catalog.profile, signal, async (session) => {
      const events = await eventsOf(env, catalog, session, sql, { ...options, signal });
      const reason = stopped();
      if (reason) throw reason;
      const failure = events.events.find((event) => event.kind === 'error');
      if (failure) throw new ToolError(session.mask(failure.message));
      return events;
    });
  } catch (error) {
    throw stopped() ?? error;
  }
}

/** The events of the text and of the statements around it; the settings go back even after a failure or a cancel. */
async function eventsOf(
  env: ExecuteEnv,
  catalog: OpenCatalog,
  session: SqlSession,
  sql: string,
  options: { readonly around?: RunAround; readonly maxRows?: number; readonly signal: AbortSignal },
): Promise<Run> {
  const { around, signal } = options;
  const quiet = quietRun(session);
  const started = performance.now();
  const events: SqlEvent[] = [];
  try {
    await around?.before(quiet);
    for await (const event of session.run(sql, { signal, maxRows: options.maxRows ?? EXPLAIN_ROWS })) {
      events.push(around?.event?.(event) ?? event);
    }
    events.push(...((await around?.report()) ?? []));
  } finally {
    if (around) {
      const restored = await around.restore(quiet).catch(() => false);
      await around.dispose();
      if (!restored) void env.sessions.close(catalog.profile.id);
    }
  }
  return { events, elapsedMs: Math.round(performance.now() - started) };
}

/** The value of the first row of the result, which EXPLAIN gives as `explain_key`, `explain_value`. */
function explainValue(events: readonly SqlEvent[]): string {
  const result = events.find((event) => event.kind === 'resultSet');
  const values = result?.rows.map((row) => row[1]).filter((value) => typeof value === 'string') ?? [];
  if (values.length === 0) throw new ToolError('DuckDB returned no plan.');
  return values.join('\n');
}

const tipsIn = (events: readonly SqlEvent[]): Tip[] =>
  events.flatMap((event) =>
    event.kind === 'tips' || event.kind === 'profile' ? [...(event.tips ?? [])] : [],
  );

/** EXPLAIN of one statement that reads: the plan, or the error that shows it does not bind. Runs nothing. */
export async function explain(env: ExecuteEnv, catalog: OpenCatalog, text: string, signal: AbortSignal) {
  const statement = await oneStatement(env.tokenizer, text);
  await guardViews(env, catalog, statement);
  const { events, elapsedMs } = await runIn(env, catalog, `EXPLAIN (FORMAT JSON) ${statement.sql}`, {
    signal,
  });
  return {
    connection: catalog.profile.name,
    statement: statement.sql,
    elapsedMs,
    plan: documentOf(explainValue(events)),
  };
}

/** Analysis: EXPLAIN ANALYZE runs the statement to its end; the plan with time and rows per operator, and the tips. */
export async function explainAnalyze(
  env: ExecuteEnv,
  catalog: OpenCatalog,
  text: string,
  signal: AbortSignal,
) {
  const statement = await oneStatement(env.tokenizer, text);
  await guardViews(env, catalog, statement);
  const around = analysis({ tips: env.tips(catalog.profile.id) });
  const { events, elapsedMs } = await runIn(env, catalog, `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.sql}`, {
    around,
    signal,
  });
  return {
    connection: catalog.profile.name,
    statement: statement.sql,
    elapsedMs,
    plan: documentOf(explainValue(events)),
    tips: tipsIn(events),
  };
}

/** Statistics: the statement with DuckDB's profiler, its metrics and operators, and the tips. Returns no rows. */
export async function profile(env: ExecuteEnv, catalog: OpenCatalog, text: string, signal: AbortSignal) {
  const statement = await oneStatement(env.tokenizer, text);
  await guardViews(env, catalog, statement);
  const around = profiler({ tips: env.tips(catalog.profile.id) });
  const { events, elapsedMs } = await runIn(env, catalog, statement.sql, {
    around,
    maxRows: env.resultRows(),
    signal,
  });
  const result = events.find((event) => event.kind === 'resultSet');
  const written = events.find((event) => event.kind === 'profile');
  if (!written) throw new ToolError('DuckDB wrote no profile of the statement.');
  return {
    connection: catalog.profile.name,
    statement: statement.sql,
    elapsedMs,
    profile: documentOf(written.json),
    tips: tipsIn(events),
    rowsRead: result?.rows.length ?? 0,
    resultCut: result?.truncated ?? false,
  };
}

/** The first rows of a statement that reads, at most `aantje.mcp.maxRows`; refused while that is 0. */
export async function sampleRows(env: ExecuteEnv, catalog: OpenCatalog, text: string, signal: AbortSignal) {
  const limit = env.sampleRows();
  if (limit <= 0) {
    throw new ToolError('aantje returns no rows: the setting aantje.mcp.maxRows is 0.');
  }
  const statement = await oneStatement(env.tokenizer, text);
  await guardViews(env, catalog, statement);
  const { events, elapsedMs } = await runIn(env, catalog, statement.sql, { maxRows: limit, signal });
  const result = events.find((event) => event.kind === 'resultSet');
  const rows = [...(result?.rows ?? [])];
  let truncated = result?.truncated ?? false;
  // Rows beyond the size of a result are left out from the end.
  while (rows.length > 0 && JSON.stringify(rows).length > MAX_RESULT_CHARACTERS) {
    rows.splice(Math.floor(rows.length / 2));
    truncated = true;
  }
  return {
    connection: catalog.profile.name,
    statement: statement.sql,
    elapsedMs,
    columns: (result?.columns ?? []).map(({ name, type }) => ({ name, type })),
    rows,
    truncated,
  };
}
