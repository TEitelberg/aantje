// The tools that hand one statement to DuckDB (explain, explain_analyze, profile, sample_rows) and open_sql, which
// opens SQL for the user and runs nothing. Free of the VS Code API.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { answer, CONNECTION } from './answer';
import type { AnswerEnv } from './answer';
import { openCatalog, profileNamed } from './catalog';
import type { CatalogSource } from './catalog';
import {
  ANALYZED,
  EXPLAINED,
  explain,
  explainAnalyze,
  profile,
  PROFILED,
  SAMPLED,
  sampleRows,
} from './execute';
import type { ExecuteEnv } from './execute';

export interface ExecuteToolsEnv extends ExecuteEnv {
  /** Opens SQL as a new, unsaved SQL document bound to the connection; runs nothing. */
  readonly openSql: (connectionId: string, text: string) => Promise<void>;
}

type Env = ExecuteToolsEnv & CatalogSource & AnswerEnv;

const SQL = z.string().describe('Exactly one SQL statement.');
const READS = { readOnlyHint: true, openWorldHint: true } as const;

const RUNS =
  'It runs the statement in a read-only session of aantje, not in a SQL editor, so on S3 or Azure it reads the data, and it takes as long as the statement does (aantje.queryTimeoutSeconds stops it). Only a statement that reads runs; a text with more than one statement is refused.';

export function registerExecuteTools(server: McpServer, env: Env): void {
  server.registerTool(
    'explain',
    {
      title: 'Explain a statement',
      description:
        "DuckDB's EXPLAIN of one statement that reads, as JSON: the plan, or the error that shows the statement does not bind. EXPLAIN runs nothing, so this is also the check that a proposed query binds; for a view, explain SELECT * FROM schema.view, and for a change of a view, explain its new SELECT. A text with more than one statement is refused.",
      inputSchema: z.object({ connection: CONNECTION, sql: SQL }),
      outputSchema: EXPLAINED,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args, { signal }) =>
      answer(env, { tool: 'explain', connection: args.connection, statement: args.sql }, async () =>
        explain(env, await openCatalog(env, args.connection), args.sql, signal),
      ),
  );

  server.registerTool(
    'explain_analyze',
    {
      title: 'Analyze a statement',
      description: `Analysis of the SQL editor: EXPLAIN ANALYZE runs one statement to its end and returns the plan with time and rows per operator as JSON, and aantje's performance tips (sort order, file pruning, cache, spilling, maintenance of the scanned tables). ${RUNS}`,
      inputSchema: z.object({ connection: CONNECTION, sql: SQL }),
      outputSchema: ANALYZED,
      annotations: READS,
    },
    (args, { signal }) =>
      answer(env, { tool: 'explain_analyze', connection: args.connection, statement: args.sql }, async () =>
        explainAnalyze(env, await openCatalog(env, args.connection), args.sql, signal),
      ),
  );

  server.registerTool(
    'profile',
    {
      title: 'Profile a statement',
      description: `Statistics of the SQL editor: one statement with DuckDB's profiler. Returns the profile as JSON (latency, rows scanned, bytes read, peak memory, time and rows per operator) and aantje's performance tips, no rows. Like the SQL editor it reads at most aantje.sql.maxRows rows of the result; explain_analyze runs a statement to its end. ${RUNS}`,
      inputSchema: z.object({ connection: CONNECTION, sql: SQL }),
      outputSchema: PROFILED,
      annotations: READS,
    },
    (args, { signal }) =>
      answer(env, { tool: 'profile', connection: args.connection, statement: args.sql }, async () =>
        profile(env, await openCatalog(env, args.connection), args.sql, signal),
      ),
  );

  // Rows leave the machine only when the user allowed them; while the setting is 0 the tool does not exist.
  if (env.sampleRows() > 0) {
    server.registerTool(
      'sample_rows',
      {
        title: 'Sample rows',
        description: `The first rows of one statement that reads, at most aantje.mcp.maxRows (${env.sampleRows()} now), with the names and DuckDB types of the columns. ${RUNS}`,
        inputSchema: z.object({ connection: CONNECTION, sql: SQL }),
        outputSchema: SAMPLED,
        annotations: READS,
      },
      (args, { signal }) =>
        answer(env, { tool: 'sample_rows', connection: args.connection, statement: args.sql }, async () =>
          sampleRows(env, await openCatalog(env, args.connection), args.sql, signal),
        ),
    );
  }

  server.registerTool(
    'open_sql',
    {
      title: 'Open SQL for the user',
      description:
        'Opens SQL as a new, unsaved SQL document of aantje bound to the connection, for the user to check and run. Runs nothing. Use it for every statement that changes data or objects (CREATE OR REPLACE VIEW, ALTER, maintenance), and for a query the user should keep.',
      inputSchema: z.object({ connection: CONNECTION, sql: z.string().describe('The SQL to open.') }),
      outputSchema: z.object({ connection: z.string(), opened: z.boolean() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) =>
      answer(env, { tool: 'open_sql', connection: args.connection, statement: args.sql }, async () => {
        const target = profileNamed(env, args.connection);
        await env.openSql(target.id, args.sql);
        return { connection: target.name, opened: true };
      }),
  );
}
