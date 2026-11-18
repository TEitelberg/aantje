import type * as vscode from 'vscode';
import type { DataAccessFactory } from '../data/resolve';
import type { SqlParser } from '../dependencies/parser';
import { openReport } from '../shell/host.vscode';
import type { ReportCommandEnv } from '../shell/report-port.vscode';
import { tableStatisticsTarget } from '../shell/table-actions.vscode';
import type { TableActionEnv } from '../shell/table-actions.vscode';
import type { QueryHistory } from '../sql/history';
import { planPartitionAction } from './actions';
import { partitionKind } from './kind';
import { partitionHeading } from './model';
import type { PartitionTable } from './model';
import { readPartitioning } from './read';

const COMMAND = 'aantje.suggestPartitioning';

interface PartitionEnv extends ReportCommandEnv, TableActionEnv {
  readonly dataAccess: DataAccessFactory;
  /** The statements of this user, whose filters are read; nothing of it leaves the machine. */
  readonly history: Pick<QueryHistory, 'entries'>;
  readonly parser: Pick<SqlParser, 'serialize'>;
}

type Params = { readonly table: Omit<PartitionTable, 'rows' | 'sizeBytes' | 'files' | 'snapshot'> };

/** Suggest Partitioning... on a table: candidates from the filters of the Query History and the measured data. */
export function registerPartitioning(env: PartitionEnv): vscode.Disposable[] {
  const report = openReport(env, {
    command: COMMAND,
    kind: partitionKind,
    noun: 'partitioning suggestions',
    goal: 'suggest a partitioning',
    keyOf: (profile, { table }: Params) => JSON.stringify([profile.id, table.id]),
    open: (reader, profile, { table }) => {
      const snapshot = env.tree.state(profile.id).latestSnapshot;
      return snapshot === undefined
        ? undefined
        : {
            progress: `Measuring ${table.schema}.${table.name} for a partitioning...`,
            read: async (signal) =>
              readPartitioning(
                {
                  reader,
                  access: await env.dataAccess(profile, undefined),
                  history: env.history.entries(profile.id),
                  serialize: (sql) => env.parser.serialize(sql),
                },
                profile.name,
                { ...table, snapshot },
                signal,
              ),
            title: () => `${partitionHeading(table)} · ${profile.name}`,
            absent: `"${table.schema}.${table.name}" does not exist at the newest snapshot.`,
          };
    },
    planAction: planPartitionAction,
    perform: async (plan, profile, data) => {
      if (plan.action === 'script') {
        await env.actions.openSql(profile.id, plan.text);
        return;
      }
      await env.showStatistics(tableStatisticsTarget(profile.id, data.table), data.table.snapshot);
    },
  });
  return [
    { dispose: () => report.dispose() },
    report.command(env.register, (ref) =>
      ref.kind === 'table'
        ? {
            table: {
              id: ref.table.id,
              schemaId: ref.schema.id,
              schema: ref.schema.name,
              name: ref.table.name,
            },
          }
        : undefined,
    ),
  ];
}
