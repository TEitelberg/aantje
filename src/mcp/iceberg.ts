// The Iceberg tools of aantje's MCP server: the state of the syncs of a lake to Iceberg, and the request of a sync that
// opens aantje's question in VS Code. Nothing is written unless the user says yes there. Free of the VS Code API.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod';
import type { CopySource } from '../iceberg/flow';
import type { IcebergCheck } from '../iceberg/read';
import type { IcebergCopyRecord } from '../iceberg/records';
import type { TableProblem } from '../iceberg/status';
import type { RequestedSync, SyncRequestArgs } from '../iceberg/sync-request';
import type { IcebergTarget } from '../iceberg/target';
import { answer, CONNECTION, SCHEMA } from './answer';
import type { AnswerEnv } from './answer';
import { named, openCatalog, ToolError } from './catalog';
import type { CatalogSource } from './catalog';

export interface IcebergToolsEnv {
  readonly targets: () => readonly IcebergTarget[];
  /** What aantje remembers of the syncs of a connection. */
  readonly records: (connectionId: string) => readonly IcebergCopyRecord[];
  /** Checks the sync of a connection to a target now, as the tree does; undefined when there is nothing to check. */
  readonly check: (connectionId: string, targetId: string) => Promise<IcebergCheck | undefined>;
  /** Opens the question of a sync in VS Code and waits for the answer; undefined when the request was not taken. */
  readonly requestSync: (request: SyncRequestArgs) => Promise<RequestedSync | undefined>;
}

type Env = IcebergToolsEnv & CatalogSource & AnswerEnv;

const PROBLEMS = [
  'lake-dropped',
  'iceberg-missing',
  'iceberg-replaced',
  'iceberg-ahead',
  'lake-newer',
  'not-checked',
] as const satisfies readonly TableProblem[];

const TABLE = z.object({
  schema: z.string(),
  table: z.string(),
  iceberg: z
    .string()
    .optional()
    .describe('namespace.table in Iceberg, when not the schema and table of the lake.'),
  scope: z.enum(['lake', 'schema', 'table']).describe('What the sync that wrote the table covered.'),
  inSync: z.boolean(),
  problems: z.array(z.enum(PROBLEMS)),
  syncedSnapshot: z.number().describe('The snapshot of the lake that the last sync wrote.'),
  snapshotsBehind: z.number().describe('Snapshots after the sync that changed the table in the lake.'),
  lakeChangedAt: z.string().optional(),
  checkError: z.string().optional(),
});

const STATUS = z.object({
  connection: z.string(),
  targets: z.array(
    z.object({
      name: z.string(),
      endpoint: z.string(),
      warehouse: z.string(),
      inSync: z
        .boolean()
        .describe('True only when every synced table is in sync and the lake has no table more.'),
      newestSnapshot: z.number().describe('The newest snapshot of the lake when it was checked.'),
      checkedAt: z.string(),
      icebergError: z
        .string()
        .optional()
        .describe('Set when the Iceberg catalog could not be asked; the tables are then not checked.'),
      tables: z.array(TABLE),
      added: z
        .array(z.object({ schema: z.string(), table: z.string() }))
        .describe('Tables of the lake that a synced lake or schema covers and that no sync wrote yet.'),
    }),
  ),
});

const REQUESTED = z.object({
  outcome: z.enum(['synced', 'nothing', 'declined', 'cancelled', 'failed', 'uncovered']),
  message: z.string(),
  snapshot: z.number().optional().describe('The snapshot of the lake that Iceberg has now.'),
  synced: z.number().optional().describe('Tables written.'),
  failed: z.array(z.string()).optional().describe('`schema.table: reason` of the tables that failed.'),
});

/** The targets that the connection was synced to, or the one of that name; throws when there is no such target. */
function targetsOf(env: Env, connectionId: string, name: string | undefined): IcebergTarget[] {
  const records = env.records(connectionId);
  const synced = env.targets().filter((target) => records.some((record) => record.targetId === target.id));
  if (name === undefined) return synced;
  const found = named(synced, name);
  if (found.length !== 1) {
    const names = synced.map((target) => `"${target.name}"`).join(', ');
    throw new ToolError(
      found.length === 0
        ? `The connection was not synced to an Iceberg target named "${name}"${names === '' ? '; it was not synced to Iceberg at all' : `; it was synced to ${names}`}.`
        : `Several Iceberg targets are named "${name}" apart from upper and lower case. Use the exact spelling.`,
    );
  }
  return found;
}

/** The spelling of a schema or table that the records have, when they have it; else the name as it was given. */
const spelled = (names: readonly string[], name: string): string =>
  named(
    [...new Set(names)].map((item) => ({ name: item })),
    name,
  )[0]?.name ?? name;

function sourceOf(
  records: readonly IcebergCopyRecord[],
  schema: string | undefined,
  table: string | undefined,
): CopySource {
  if (schema === undefined) {
    if (table !== undefined) throw new ToolError('Pass the schema of the table too.');
    return { kind: 'lake' };
  }
  const exact = spelled(
    records.map((record) => record.schema),
    schema,
  );
  if (table === undefined) return { kind: 'schema', schema: exact };
  return {
    kind: 'table',
    schema: exact,
    table: spelled(
      records.filter((record) => record.schema === exact).map((record) => record.table),
      table,
    ),
  };
}

const MESSAGES: Readonly<Record<Exclude<RequestedSync['kind'], 'synced' | 'failed'>, string>> = {
  nothing: 'The Iceberg tables already have the state of the lake; nothing was written.',
  declined: 'The user declined the sync in VS Code; nothing was written.',
  cancelled: 'The user cancelled the sync while it ran; tables written until then stay written.',
  uncovered:
    'Nothing of this was synced to the target before. A first sync starts in the aantje explorer with Sync to Iceberg; this tool only brings a sync up to date.',
};

function requested(outcome: RequestedSync): z.infer<typeof REQUESTED> {
  switch (outcome.kind) {
    case 'synced':
      return {
        outcome: 'synced',
        message: `The user confirmed the sync; ${outcome.synced} ${outcome.synced === 1 ? 'table was' : 'tables were'} written at snapshot ${outcome.snapshot}${outcome.failed.length === 0 ? '' : `, ${outcome.failed.length} failed`}.`,
        snapshot: outcome.snapshot,
        synced: outcome.synced,
        failed: [...outcome.failed],
      };
    case 'nothing':
      return { outcome: 'nothing', message: MESSAGES.nothing, snapshot: outcome.snapshot };
    case 'failed':
      return { outcome: 'failed', message: outcome.message };
    default:
      return { outcome: outcome.kind, message: MESSAGES[outcome.kind] };
  }
}

export function registerIcebergTools(server: McpServer, env: Env): void {
  server.registerTool(
    'iceberg_status',
    {
      title: 'Iceberg sync status',
      description:
        "The state of the syncs of a connected lake to Iceberg (aantje's Sync to Iceberg), checked now against the newest snapshot of the lake and the Iceberg catalog, as the explorer shows it. Per target and table: in sync or the problems: lake-newer (the lake changed the table after the sync), iceberg-ahead (Iceberg has snapshots after the sync's, written by someone else), iceberg-replaced (the Iceberg table was written new), iceberg-missing, lake-dropped, not-checked. An empty list of targets: the lake was never synced to Iceberg. It changes nothing.",
      inputSchema: z.object({
        connection: CONNECTION,
        target: z.string().optional().describe('The name of one Iceberg target; all targets when not given.'),
      }),
      outputSchema: STATUS,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      answer(env, { tool: 'iceberg_status', connection: args.connection }, async () => {
        const { profile } = await openCatalog(env, args.connection);
        const records = env.records(profile.id);
        const checked = await Promise.all(
          targetsOf(env, profile.id, args.target).map(async (target) => ({
            target,
            check: await env.check(profile.id, target.id),
          })),
        );
        return {
          connection: profile.name,
          targets: checked.flatMap(({ target, check }) =>
            check === undefined
              ? []
              : [
                  {
                    name: target.name,
                    endpoint: env.redact(target.endpoint),
                    warehouse: target.warehouse,
                    inSync: check.status.inSync,
                    newestSnapshot: check.newest,
                    checkedAt: check.checkedAt,
                    ...(check.icebergError === undefined
                      ? {}
                      : { icebergError: env.redact(check.icebergError) }),
                    tables: check.status.tables.map((table) => {
                      const record = records.find(
                        (item) =>
                          item.targetId === target.id &&
                          item.schema === table.schema &&
                          item.table === table.table,
                      );
                      return {
                        schema: table.schema,
                        table: table.table,
                        ...(table.iceberg === undefined ? {} : { iceberg: table.iceberg }),
                        scope: record?.scope ?? 'lake',
                        inSync: table.problems.length === 0,
                        problems: [...table.problems],
                        syncedSnapshot: table.copiedSnapshot,
                        snapshotsBehind: table.snapshotsBehind,
                        ...(table.lakeChangedAt === undefined ? {} : { lakeChangedAt: table.lakeChangedAt }),
                        ...(table.checkError === undefined
                          ? {}
                          : { checkError: env.redact(table.checkError) }),
                      };
                    }),
                    added: check.status.added.map(({ schema, table }) => ({ schema, table })),
                  },
                ],
          ),
        };
      }),
  );

  server.registerTool(
    'request_iceberg_sync',
    {
      title: 'Request a sync to Iceberg',
      description:
        "Asks the user in VS Code to bring a sync to Iceberg up to date: aantje's question opens there, says which tables are appended, replaced or written new, and nothing is written unless the user confirms it. The call waits for the answer and the sync. It covers what was synced to the target before: the whole lake, a schema, or one table (pass schema, and table); a first sync starts in the aantje explorer. The sync reads the snapshot that the explorer shows. Check iceberg_status first.",
      inputSchema: z.object({
        connection: CONNECTION,
        target: z.string().describe('The name of the Iceberg target, as iceberg_status returns it.'),
        schema: SCHEMA.optional().describe('Only the tables of this schema.'),
        table: z.string().optional().describe('Only this table of the schema.'),
      }),
      outputSchema: REQUESTED,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      answer(env, { tool: 'request_iceberg_sync', connection: args.connection }, async () => {
        const { profile } = await openCatalog(env, args.connection);
        const [target] = targetsOf(env, profile.id, args.target);
        if (!target) throw new ToolError(`The connection was not synced to "${args.target}".`);
        const records = env.records(profile.id).filter((record) => record.targetId === target.id);
        const outcome = await env.requestSync({
          connectionId: profile.id,
          targetId: target.id,
          source: sourceOf(records, args.schema, args.table),
        });
        if (!outcome)
          throw new ToolError('aantje could not ask for the sync. The connection or the target is gone.');
        return requested(outcome);
      }),
  );
}
