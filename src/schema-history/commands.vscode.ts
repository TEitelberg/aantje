import type * as vscode from 'vscode';
import { openReport } from '../shell/host.vscode';
import { tableLabel } from '../shell/model';
import { reportPortOf } from '../shell/report-port.vscode';
import type { ReportCommandEnv } from '../shell/report-port.vscode';
import { planSchemaHistoryAction } from './actions';
import { performSchemaHistoryAction } from './execute';
import { schemaHistoryKind } from './kind';
import { readSchemaHistory } from './read';

const COMMAND = 'aantje.showSchemaHistory';
const GOAL = 'show the schema history';

export function registerSchemaHistoryCommand(env: ReportCommandEnv): vscode.Disposable[] {
  const report = openReport(env, {
    command: COMMAND,
    kind: schemaHistoryKind,
    noun: 'schema history',
    goal: GOAL,
    keyOf: (profile, { tableId }: { readonly tableId: number; readonly name: string }) =>
      JSON.stringify([profile.id, tableId]),
    open: (reader, profile, { tableId, name }) => ({
      progress: `Reading the schema history of ${name}...`,
      read: (signal) => readSchemaHistory(reader, profile.name, tableId, signal),
      title: (data) => `Schema History of ${tableLabel(data)} · ${profile.name}`,
    }),
    planAction: planSchemaHistoryAction,
    perform: (plan, profile) => performSchemaHistoryAction(plan, reportPortOf(env, profile)),
  });

  return [
    { dispose: () => report.dispose() },
    report.command(env.register, (ref) =>
      ref.kind === 'table' || (ref.kind === 'folder' && ref.folder === 'history')
        ? { tableId: ref.table.id, name: `${ref.schema.name}.${ref.table.name}` }
        : undefined,
    ),
  ];
}
