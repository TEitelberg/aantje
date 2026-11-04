import type * as vscode from 'vscode';
import { showConnectFirst } from '../command.vscode';
import { openReport } from '../shell/host.vscode';
import { reportPortOf } from '../shell/report-port.vscode';
import type { ReportCommandEnv } from '../shell/report-port.vscode';
import { planSchemaHistoryAction } from './actions';
import { performSchemaHistoryAction } from './execute';
import { schemaHistoryKind } from './kind';
import { tableLabel } from './model';
import { readSchemaHistory } from './read';

const COMMAND = 'aantje.showSchemaHistory';
const GOAL = 'show the schema history';

export function registerSchemaHistoryCommand(env: ReportCommandEnv): vscode.Disposable[] {
  const { store } = env;

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
    env.register(COMMAND, async (node) => {
      const ref = node?.ref;
      if (ref?.kind !== 'table' && !(ref?.kind === 'folder' && ref.folder === 'history')) {
        return;
      }
      const profile = store.get(ref.connectionId);
      if (!profile) {
        showConnectFirst(GOAL);
        return;
      }
      await report.show(profile, { tableId: ref.table.id, name: `${ref.schema.name}.${ref.table.name}` });
    }),
  ];
}
