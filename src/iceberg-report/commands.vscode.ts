import type * as vscode from 'vscode';
import type { Register } from '../command.vscode';
import type { IcebergCopies } from '../iceberg/records';
import type { IcebergStatuses } from '../iceberg/service';
import type { IcebergTargetStore } from '../iceberg/store';
import { openReport } from '../shell/host.vscode';
import { reportHeading } from '../shell/report-heading';
import type { ReportHostEnv } from '../shell/host.vscode';
import { icebergKind } from './kind';
import { buildIcebergData, ICEBERG_ACTIONS } from './model';
import type { IcebergActionId, IcebergData, IcebergReport } from './model';

const COMMAND = 'aantje.showIcebergReport';

interface IcebergReportEnv extends ReportHostEnv {
  readonly targets: Pick<IcebergTargetStore, 'get'>;
  readonly copies: Pick<IcebergCopies, 'list' | 'failures'>;
  readonly statuses: Pick<IcebergStatuses, 'checkOne'>;
  /** What the buttons of the page do; the page shows only the buttons that have an entry. */
  readonly actions: Readonly<
    Record<IcebergActionId, (connectionId: string, targetId: string, data: IcebergData) => Promise<void>>
  >;
  readonly register: Register;
}

/** The Iceberg report: one panel per connection and copy target, opened from the row of the copy in the tree. */
export function registerIcebergReport(env: IcebergReportEnv): {
  report: IcebergReport;
  disposables: vscode.Disposable[];
} {
  const report = openReport(env, {
    command: COMMAND,
    kind: icebergKind,
    noun: 'Iceberg report',
    goal: 'show its Iceberg sync',
    keyOf: (profile, { targetId }: { readonly targetId: string }) => JSON.stringify([profile.id, targetId]),
    open: (_reader, profile, { targetId }) => {
      const target = env.targets.get(targetId);
      return (
        target && {
          progress: `Checking the Iceberg sync of "${profile.name}" in ${target.name}...`,
          read: async () => {
            const records = env.copies.list(profile.id).filter((record) => record.targetId === targetId);
            const check =
              records.length === 0 ? undefined : await env.statuses.checkOne(profile.id, targetId);
            return check === undefined
              ? null
              : buildIcebergData({
                  connection: profile.name,
                  target,
                  records,
                  check,
                  actions: ICEBERG_ACTIONS,
                  failures: env.copies.failures(profile.id, targetId),
                });
          },
          title: () => `${reportHeading('Iceberg Report', target.name)} · ${profile.name}`,
          absent: `"${profile.name}" has no copy in ${target.name}.`,
        }
      );
    },
    planAction: (data, { action }) =>
      data.actions.includes(action) ? { action, targetId: data.target.id } : undefined,
    perform: ({ action, targetId }, profile, data) => env.actions[action](profile.id, targetId, data),
  });
  return {
    report: {
      show: async (connectionId, targetId) => {
        const profile = env.store.get(connectionId);
        if (profile) await report.show(profile, { targetId });
      },
      refresh: (connectionId, targetId) => {
        const profile = env.store.get(connectionId);
        if (profile) report.refreshOpen(profile, { targetId });
      },
      dispose: () => report.dispose(),
    },
    disposables: [
      { dispose: () => report.dispose() },
      report.command(env.register, (ref) =>
        ref.kind === 'folder' && ref.folder === 'iceberg' ? { targetId: ref.targetId } : undefined,
      ),
    ],
  };
}
