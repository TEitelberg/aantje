import type * as vscode from 'vscode';
import { openReport } from '../shell/host.vscode';
import { reportPortOf } from '../shell/report-port.vscode';
import type { ReportCommandEnv } from '../shell/report-port.vscode';
import { planSnapshotAction } from '../snapshot-changes/actions';
import { performSnapshotAction } from '../snapshot-changes/execute';
import { readNewest } from '../snapshot-changes/window';
import { snapshotReportKind } from './kind';

const COMMAND = 'aantje.showSnapshotReport';
const GOAL = 'show its snapshot report';

export function registerSnapshotReportCommand(env: ReportCommandEnv): vscode.Disposable[] {
  const report = openReport(env, {
    command: COMMAND,
    kind: snapshotReportKind,
    noun: 'snapshot report',
    goal: GOAL,
    keyOf: (profile) => profile.id,
    open: (reader, profile) => ({
      progress: `Reading the snapshots of "${profile.name}"...`,
      read: async (signal) => ({ connection: profile.name, ...(await readNewest(reader, signal)) }),
      title: () => `Snapshot Report · ${profile.name}`,
    }),
    planAction: planSnapshotAction,
    perform: (plan, profile) =>
      performSnapshotAction(plan, reportPortOf(env, profile), 'use the snapshot report'),
  });

  return [
    { dispose: () => report.dispose() },
    report.command(env.register, (ref) => (ref.kind === 'connection' ? {} : undefined)),
  ];
}
