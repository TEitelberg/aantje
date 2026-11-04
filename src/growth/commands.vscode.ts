import type * as vscode from 'vscode';
import { showConnectFirst } from '../command.vscode';
import { openReport } from '../shell/host.vscode';
import { LAKE_SCOPE, scopeKey, scopeOfNode, scopeSuffix } from '../shell/scope';
import type { ReportScope } from '../shell/scope';
import { reportPortOf } from '../shell/report-port.vscode';
import type { ReportCommandEnv } from '../shell/report-port.vscode';
import { performSnapshotReportAction } from '../snapshot-report/execute';
import { planGrowthAction } from './actions';
import { growthKind } from './kind';
import { readGrowth } from './read';

const COMMAND = 'aantje.showGrowth';

interface GrowthParams {
  readonly focus: number | null;
  readonly name: string | undefined;
  readonly scope: ReportScope;
}
const GOAL = 'show its growth';

export function registerGrowthCommand(env: ReportCommandEnv): vscode.Disposable[] {
  const { store } = env;

  const report = openReport(env, {
    command: COMMAND,
    kind: growthKind,
    noun: 'growth report',
    goal: GOAL,
    keyOf: (profile, { focus, scope }: GrowthParams) =>
      focus === null ? scopeKey(profile.id, scope) : JSON.stringify([profile.id, focus]),
    open: (reader, profile, { focus, name, scope }) => ({
      progress: `Reading the growth of ${name ?? `"${profile.name}"`}...`,
      read: (signal) => readGrowth(reader, profile.name, focus, signal, undefined, scope),
      title: () =>
        `Growth${name === undefined ? '' : ` of ${name}`} · ${profile.name}${name === undefined ? scopeSuffix(scope) : ''}`,
    }),
    planAction: planGrowthAction,
    perform: (plan, profile) => performSnapshotReportAction(plan, reportPortOf(env, profile)),
  });

  return [
    { dispose: () => report.dispose() },
    env.register(COMMAND, async (node) => {
      const ref = node?.ref;
      if (ref?.kind !== 'connection' && ref?.kind !== 'schema' && ref?.kind !== 'table') {
        return;
      }
      const profile = store.get(ref.connectionId);
      if (!profile) {
        showConnectFirst(GOAL);
        return;
      }
      if (ref.kind === 'table') {
        await report.show(profile, {
          focus: ref.table.id,
          name: `${ref.schema.name}.${ref.table.name}`,
          scope: LAKE_SCOPE,
        });
      } else {
        await report.show(profile, { focus: null, name: undefined, scope: scopeOfNode(ref) ?? LAKE_SCOPE });
      }
    }),
  ];
}
