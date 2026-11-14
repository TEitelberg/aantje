import * as vscode from 'vscode';
import { rootOf } from '../actions';
import { openReport } from '../shell/host.vscode';
import { scopeKey, scopeOfNode, scopeSuffix } from '../shell/scope';
import type { ReportScope } from '../shell/scope';
import { reportPortOf } from '../shell/report-port.vscode';
import type { ReportCommandEnv } from '../shell/report-port.vscode';
import { planActivityAction } from './actions';
import { performActivityAction } from './execute';
import { activityKind } from './kind';
import { readActivity } from './read';

const COMMAND = 'aantje.showActivity';
const GOAL = 'show its activity';

/** Activity: who committed what and when, for the newest snapshots of a connection or a schema; one panel per scope. */
export function registerActivityCommand(env: ReportCommandEnv): vscode.Disposable[] {
  const { tree } = env;

  const report = openReport(env, {
    command: COMMAND,
    kind: activityKind,
    noun: 'activity report',
    goal: GOAL,
    keyOf: (profile, { scope }: { readonly scope: ReportScope }) => scopeKey(profile.id, scope),
    open: (reader, profile, { scope }) => ({
      progress: `Reading the activity of "${profile.name}"...`,
      read: (signal) => readActivity(reader, profile.name, signal, scope),
      title: () => `Activity · ${profile.name}${scopeSuffix(scope)}`,
    }),
    planAction: planActivityAction,
    perform: (plan, profile) =>
      performActivityAction(plan, reportPortOf(env, profile), async () => {
        const node = rootOf(tree, profile.id);
        await vscode.commands.executeCommand('aantje.showSnapshotReport', node);
      }),
  });

  return [
    { dispose: () => report.dispose() },
    report.command(env.register, (ref) => {
      const scope = scopeOfNode(ref);
      return scope && { scope };
    }),
  ];
}
