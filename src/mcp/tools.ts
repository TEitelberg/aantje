// The tools of aantje's MCP server. Those that read the catalog never connect a connection and never write; a
// connection that is not connected in the explorer says so. Free of the VS Code API.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { ConnectionProfile } from '../connections/profile';
import type { DataAccess } from '../data/types';
import type { SqlParser } from '../dependencies/parser';
import { answer, CONNECTION, SCHEMA } from './answer';
import type { AnswerEnv } from './answer';
import { openCatalog } from './catalog';
import type { CatalogSource } from './catalog';
import { registerExecuteTools } from './execute-tools';
import type { ExecuteToolsEnv } from './execute-tools';
import { registerIcebergTools } from './iceberg';
import type { IcebergToolsEnv } from './iceberg';
import { describeObject, DESCRIPTION, listObjects, OBJECT_KINDS, OBJECTS } from './objects';
import { registerNotes, registerPrompts } from './prompts';
import { ADVICE, maintenanceAdvice, STATISTICS, tableStatistics } from './reports';

export interface McpCatalogEnv extends CatalogSource, AnswerEnv {
  /** The parser of view and macro SQL, for the dependencies. */
  readonly parser: SqlParser;
  /** The access of the dry runs of the Maintenance Advisor; it never asks for a sign-in. */
  readonly dataAccess: (profile: ConnectionProfile) => Promise<DataAccess>;
  readonly now?: () => Date;
  /** The tools that hand a statement to DuckDB, and open_sql; without it the server only reads the catalog. */
  readonly execute?: ExecuteToolsEnv;
  /** The state of the syncs to Iceberg, and the request of a sync that the user confirms in VS Code. */
  readonly iceberg?: IcebergToolsEnv;
}

const CONNECTIONS = z.object({
  connections: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(['postgres', 'sqlite', 'duckdb', 'quack']),
      connected: z.boolean(),
    }),
  ),
});

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

/** The tools, the prompts and the resource of a session of the server. */
export function registerCatalogTools(server: McpServer, env: McpCatalogEnv): void {
  server.registerTool(
    'list_connections',
    {
      title: 'List connections',
      description:
        'The DuckLake connections of aantje: name, kind of catalog, and whether the explorer has it connected. The other tools work only on connected connections. Never returns a password, token or key.',
      inputSchema: z.object({}),
      outputSchema: CONNECTIONS,
      annotations: READ_ONLY,
    },
    () =>
      answer(env, { tool: 'list_connections' }, () => ({
        connections: env.profiles().map((profile) => ({
          name: profile.name,
          kind: profile.kind,
          connected: env.catalog(profile.id) !== undefined,
        })),
      })),
  );

  server.registerTool(
    'list_objects',
    {
      title: 'List objects',
      description:
        'The schemas of a connected lake with their tables (rows, files, size), views and macros, at the snapshot that the explorer shows. Pass schema to list one schema only.',
      inputSchema: z.object({ connection: CONNECTION, schema: SCHEMA.optional() }),
      outputSchema: OBJECTS,
      annotations: READ_ONLY,
    },
    (args, { signal }) =>
      answer(env, { tool: 'list_objects', connection: args.connection }, async () =>
        listObjects(await openCatalog(env, args.connection), args.schema, signal),
      ),
  );

  server.registerTool(
    'describe_object',
    {
      title: 'Describe a table, view or macro',
      description:
        'One table, view or macro of a connected lake at the snapshot that the explorer shows: columns with SQL types, comments, partitioning, sort order and tags of a table; the SQL of a view or macro; and its dependencies (what it reads or calls, what reads or calls it, at any depth, and names its SQL does not resolve).',
      inputSchema: z.object({
        connection: CONNECTION,
        schema: SCHEMA,
        name: z.string().describe('The name of the table, view or macro.'),
        kind: z
          .enum(OBJECT_KINDS)
          .optional()
          .describe('Needed only when a table or view and a macro share the name.'),
      }),
      outputSchema: DESCRIPTION,
      annotations: READ_ONLY,
    },
    (args, { signal }) =>
      answer(env, { tool: 'describe_object', connection: args.connection }, async () =>
        describeObject(await openCatalog(env, args.connection), env.parser, args, signal),
      ),
  );

  server.registerTool(
    'table_statistics',
    {
      title: 'Table statistics',
      description:
        "The Statistics report of a table at the snapshot that the explorer shows, read from the catalog: rows, data and delete files, file sizes, partitions and how evenly they are filled, each column's null ratio, minimum and maximum, and the growth over the snapshots.",
      inputSchema: z.object({
        connection: CONNECTION,
        schema: SCHEMA,
        table: z.string().describe('The name of the table.'),
      }),
      outputSchema: STATISTICS,
      annotations: READ_ONLY,
    },
    (args, { signal }) =>
      answer(env, { tool: 'table_statistics', connection: args.connection }, async () =>
        tableStatistics(await openCatalog(env, args.connection), args, signal),
      ),
  );

  server.registerTool(
    'maintenance_advice',
    {
      title: 'Maintenance advice',
      description:
        "The Maintenance Advisor of a connected lake, or of one schema: the dry runs of Expire Snapshots, Clean Up Old Files and Delete Orphaned Files, and recommendations which of aantje's maintenance scripts to run (merge, rewrite, flush per table) with impact, effort and risk. It reads the newest snapshot, changes nothing, and can take a while on a large store.",
      inputSchema: z.object({
        connection: CONNECTION,
        schema: SCHEMA.optional().describe('Limits the table recommendations to one schema.'),
      }),
      outputSchema: ADVICE,
      annotations: READ_ONLY,
    },
    (args, { signal }) =>
      answer(env, { tool: 'maintenance_advice', connection: args.connection }, async () => {
        const catalog = await openCatalog(env, args.connection);
        const access = await env.dataAccess(catalog.profile);
        return maintenanceAdvice(catalog, access, args.schema, env.now?.() ?? new Date(), signal);
      }),
  );

  if (env.execute) registerExecuteTools(server, { ...env, ...env.execute });
  if (env.iceberg) registerIcebergTools(server, { ...env, ...env.iceberg });
  registerPrompts(server);
  registerNotes(server);
}
