// What aantje's MCP server tells the assistant at the start of a session, the prompts that clients offer as slash
// commands, and the resource with notes on DuckDB and DuckLake SQL that assistants often get wrong. Free of the VS Code
// API.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import { DUCKLAKE_FUNCTIONS } from '../sql/ducklake-vocabulary';

export const NOTES_URI = 'aantje://notes/duckdb-ducklake-sql';

/**
 * The instructions that come with the answer to `initialize`; clients put them into the context of the assistant.
 * Short, since they cost context in every session.
 */
export const SERVER_INSTRUCTIONS = [
  "aantje's tools read the DuckLake catalogs that the user has connected in aantje's explorer in VS Code, as they are now.",
  'For questions about these lakes (schemas, tables, views, macros, columns, dependencies, statistics, plans, speed, maintenance, syncs to Iceberg) use these tools rather than files of the workspace such as notebooks or scripts, which can be out of date.',
  'Start with list_connections: a connection must be connected in the explorer; the tools never connect.',
  `Read ${NOTES_URI} before you write SQL for a lake.`,
  "None of aantje's tools changes data, objects or settings by itself: open SQL that changes something with open_sql, for the user to check and run; request_iceberg_sync asks the user in VS Code to confirm a sync to Iceberg.",
].join(' ');

const connection = z.string().describe('The name of an aantje connection, as list_connections returns it.');

const user = (text: string) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
});

const READ_FIRST = `Read ${NOTES_URI} before you write SQL. The tools of aantje only read: never ask them to change data or objects; open SQL that changes something with open_sql, so that the user checks and runs it.`;

/** The prompts: why something is slow, how to make a query faster, how to extend a view. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'why_is_this_slow',
    {
      title: 'Why is this slow?',
      description:
        'Finds out why a view, a table scan or a statement of a DuckLake is slow, and what would help.',
      argsSchema: {
        connection,
        target: z.string().describe('A view or table as schema.name, or one SQL statement.'),
      },
    },
    ({ connection: name, target }) =>
      user(
        [
          `Find out why this is slow on the aantje connection "${name}":`,
          '',
          target,
          '',
          'If it is a view or table, read it with describe_object first and use SELECT * FROM it as the statement. Then run explain_analyze on the statement and, where the plan leaves it open, profile. Read table_statistics of the tables with the slowest scans (file sizes, small files, partitioning, the ranges of the filter columns) and maintenance_advice of the lake.',
          'Answer with the concrete causes and changes: a filter that lets DuckDB skip files or partitions, a sort order, another join, a merge of small files, and so on. Name the numbers you base them on.',
          READ_FIRST,
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'optimize_query',
    {
      title: 'Optimize this query',
      description: 'Makes one SELECT statement on a DuckLake faster, checked with Analysis and Statistics.',
      argsSchema: { connection, sql: z.string().describe('One SQL statement that reads.') },
    },
    ({ connection: name, sql }) =>
      user(
        [
          `Make this statement faster on the aantje connection "${name}":`,
          '',
          sql,
          '',
          'Run explain_analyze and profile on it and read the performance tips they return. Read describe_object and table_statistics of the tables it scans. Propose a faster statement that returns the same rows, check that it binds with explain, compare it with explain_analyze, and open it with open_sql.',
          READ_FIRST,
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'extend_view',
    {
      title: 'Extend this view',
      description: 'Changes the definition of a view as asked, checked with explain, and opens the script.',
      argsSchema: {
        connection,
        view: z.string().describe('The view as schema.name.'),
        wish: z.string().describe('What the view should do as well, e.g. "add the column payment_fee".'),
      },
    },
    ({ connection: name, view, wish }) =>
      user(
        [
          `Change the view ${view} of the aantje connection "${name}": ${wish}`,
          '',
          'Read the view with describe_object (its SQL and the views that use it), and the columns of the tables and views it reads. Write CREATE OR REPLACE VIEW with the change; check with explain that its SELECT binds, and say which views that use it would change too. Open the script with open_sql; do not run it.',
          READ_FIRST,
        ].join('\n'),
      ),
  );
}

/** The functions of the DuckLake extension with their parameters, one line each. */
function ducklakeFunctions(): string[] {
  return DUCKLAKE_FUNCTIONS.map(({ name, overloads }) => {
    const first = overloads[0];
    const parameters = first ? [...first.parameters.map(({ name: parameter }) => parameter)] : [];
    const named = first?.named.map(({ name: parameter }) => `${parameter} => …`) ?? [];
    return `- \`${name}(${[...parameters, ...named].join(', ')})\``;
  });
}

/** The notes as Markdown. */
export function notesText(): string {
  return [
    '# DuckDB and DuckLake SQL in aantje',
    '',
    'The SQL of aantje is DuckDB SQL (DuckDB 2.0) on a DuckLake catalog.',
    '',
    '## Names',
    '',
    '- The lake is attached as the catalog `lake`; a schema and a table are named `schema.table` (or `lake.schema.table`). The default schema is `main` where the lake has one.',
    '- Identifiers ignore the case of A to Z; quote them with double quotes ("Order Date"), strings with single quotes.',
    '',
    '## Queries',
    '',
    '- `LIMIT n` (and `OFFSET`), never `TOP n`. `FROM t` alone is a query; `SELECT * EXCLUDE (a, b)`, `SELECT * REPLACE (x * 2 AS x)`, `COLUMNS(...)`, `GROUP BY ALL`, `ORDER BY ALL` and `QUALIFY` for window functions are DuckDB SQL.',
    '- Integer division: `/` divides as a real number, `//` as an integer.',
    '- Casts: `CAST(x AS INTEGER)` or `x::INTEGER`; `TRY_CAST` gives NULL instead of an error.',
    "- Dates and times: `DATE '2026-01-31'`, `date_trunc('month', ts)`, `strftime(ts, '%Y-%m')`, `now()`.",
    '',
    '## Time travel',
    '',
    "- A table at a snapshot: `FROM sales.orders AT (VERSION => 42)` or `AT (TIMESTAMP => TIMESTAMP '2026-05-01 12:00')`.",
    '- An alias comes before `AT`: `FROM sales.orders AS o AT (VERSION => 42)`; `AT (...) AS o` does not parse.',
    "- The snapshots: `SELECT * FROM ducklake_snapshots('lake')`; the rows a range of snapshots changed: `FROM lake.sales.table_changes('orders', 40, 42)`.",
    '',
    '## Views and macros',
    '',
    '- A view is stored SQL: change it with `CREATE OR REPLACE VIEW`, which the user runs. A macro is `CREATE MACRO name(a, b) AS expression` or `AS TABLE SELECT ...`.',
    '- Views and macros that use a view change with it; describe_object lists them.',
    '',
    '## Speed',
    '',
    '- DuckDB skips data files by the min/max statistics of the filter columns and skips partitions by their values: filter on the partition columns and on columns the table is sorted by (`ALTER TABLE ... SET SORTED BY (...)`) rather than on an expression of them.',
    "- Many small files slow scans down: `CALL ducklake_merge_adjacent_files('lake')` merges them (a maintenance script of aantje). Deleted rows stay in their files until `ducklake_rewrite_data_files`.",
    '',
    '## Functions of the DuckLake extension',
    '',
    "The first argument is the catalog, `'lake'`. Those that change the lake are for the user to run.",
    '',
    ...ducklakeFunctions(),
  ].join('\n');
}

/** The resource with the notes. */
export function registerNotes(server: McpServer): void {
  server.registerResource(
    'duckdb-ducklake-sql',
    NOTES_URI,
    {
      title: 'DuckDB and DuckLake SQL in aantje',
      description:
        'What assistants often get wrong in DuckDB and DuckLake SQL: LIMIT instead of TOP, time travel with AT (VERSION => n), the ducklake_* functions, quoting.',
      mimeType: 'text/markdown',
    },
    () => ({ contents: [{ uri: NOTES_URI, mimeType: 'text/markdown', text: notesText() }] }),
  );
}
