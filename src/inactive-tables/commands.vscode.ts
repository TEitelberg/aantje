import * as vscode from 'vscode';
import { findEntryNode } from '../actions';
import type { SqlParser } from '../dependencies/parser';
import { openReport } from '../shell/host.vscode';
import type { ReportCommandEnv } from '../shell/report-port.vscode';
import { scopeKey, scopeOfNode } from '../shell/scope';
import type { ReportScope } from '../shell/scope';
import { performTableAction } from '../shell/table-actions.vscode';
import type { TableActionEnv } from '../shell/table-actions.vscode';
import type { QueryHistory } from '../sql/history';
import { planInactiveAction } from './actions';
import { inactiveKind } from './kind';
import { daysText, inactiveHeading, rememberedDays } from './model';
import type { InactiveTable } from './model';
import { readInactive } from './read';

const COMMAND = 'aantje.showInactiveTables';
/** The key in the global state of the extension that keeps the days chosen last. */
const DAYS_KEY = 'aantje.inactiveTablesDays';

/** The global state of the extension, as the report keeps the days chosen last in it. */
export interface ChoiceStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

interface InactiveEnv extends ReportCommandEnv, TableActionEnv {
  /** The statements of this user, for the hint of the last read; nothing of it leaves the machine. */
  readonly history: Pick<QueryHistory, 'entries'>;
  readonly parser: Pick<SqlParser, 'serialize'>;
  readonly choices: ChoiceStore;
}

type Params = { readonly scope: ReportScope; readonly days: number };

/** Runs the command of the table's node, at the snapshot that the tree shows. */
async function onTableNode(
  env: Pick<TableActionEnv, 'tree'>,
  connectionId: string,
  command: string,
  table: InactiveTable,
): Promise<void> {
  const node = await findEntryNode(env.tree, connectionId, {
    kind: 'table',
    id: table.id,
    name: table.name,
    schemaId: table.schemaId,
    schemaName: table.schema,
  });
  if (node) {
    await vscode.commands.executeCommand(command, node);
  } else {
    void vscode.window.showInformationMessage(
      `The tree does not show "${table.schema}.${table.name}". It may not exist at the snapshot that the tree shows.`,
    );
  }
}

/** Inactive Tables: the tables without a change for some days, of a connection or a schema; one panel per scope. */
export function registerInactiveTables(env: InactiveEnv): vscode.Disposable[] {
  const report = openReport(env, {
    command: COMMAND,
    kind: inactiveKind,
    noun: 'inactive tables report',
    goal: 'show its inactive tables',
    keyOf: (profile, { scope }: Params) => scopeKey(profile.id, scope),
    open: (reader, profile, { scope, days }) => ({
      progress: `Reading the tables of "${profile.name}" without a change for ${daysText(days)}...`,
      read: (signal) =>
        readInactive(
          {
            reader,
            history: env.history.entries(profile.id),
            serialize: (sql) => env.parser.serialize(sql),
          },
          profile.name,
          { scope, days },
          signal,
        ),
      title: () => `${inactiveHeading(scope)} · ${profile.name}`,
    }),
    planAction: planInactiveAction,
    perform: async (plan, profile, data) => {
      switch (plan.action) {
        case 'days':
          // The next report opens with these days too.
          await env.choices.update(DAYS_KEY, plan.days);
          await report.show(profile, { scope: data.scope, days: plan.days });
          return;
        case 'revealTable':
        case 'showStatistics':
          await performTableAction(
            env,
            profile.id,
            { action: plan.action, table: plan.table },
            plan.snapshot,
          );
          return;
        case 'showDependencies':
          await onTableNode(env, profile.id, 'aantje.showDependencies', plan.table);
      }
    },
  });

  return [
    { dispose: () => report.dispose() },
    report.command(env.register, (ref) => {
      const scope = scopeOfNode(ref);
      return scope && { scope, days: rememberedDays(env.choices.get(DAYS_KEY)) };
    }),
  ];
}
