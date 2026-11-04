import type * as vscode from 'vscode';
import { showConnectFirst } from '../command.vscode';
import { openReport } from '../shell/host.vscode';
import { reportPortOf } from '../shell/report-port.vscode';
import type { ReportCommandEnv } from '../shell/report-port.vscode';
import { planSnapshotReportAction } from './actions';
import { performSnapshotReportAction } from './execute';
import { readSnapshotReport } from './read';
import { snapshotReportKind } from './kind';

const SNAPSHOT_REPORT_LIMIT = 500;

const COMMAND = 'aantje.showSnapshotReport';
const GOAL = 'show its snapshot report';

export function registerSnapshotReportCommand(env: ReportCommandEnv): vscode.Disposable[] {
  const { store } = env;

  const report = openReport(env, {
    command: COMMAND,
    kind: snapshotReportKind,
    noun: 'snapshot report',
    goal: GOAL,
    keyOf: (profile) => profile.id,
    open: (reader, profile) => ({
      progress: `Reading the snapshots of "${profile.name}"...`,
      read: async (signal) => ({
        connection: profile.name,
        ...(await readSnapshotReport(reader, SNAPSHOT_REPORT_LIMIT, signal)),
      }),
      title: () => `Snapshot Report · ${profile.name}`,
    }),
    planAction: planSnapshotReportAction,
    perform: (plan, profile) => performSnapshotReportAction(plan, reportPortOf(env, profile)),
  });

  return [
    { dispose: () => report.dispose() },
    env.register(COMMAND, async (node) => {
      const ref = node?.ref;
      if (ref?.kind !== 'connection') {
        return;
      }
      const profile = store.get(ref.connectionId);
      if (!profile) {
        showConnectFirst(GOAL);
        return;
      }
      await report.show(profile, {});
    }),
  ];
}
