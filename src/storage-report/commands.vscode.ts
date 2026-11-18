import * as vscode from 'vscode';
import { findEntryNode, shownSnapshot } from '../actions';
import type { ConnectionProfile } from '../connections/profile';
import { openReport } from '../shell/host.vscode';
import { reportHeading } from '../shell/report-heading';
import { LAKE_SCOPE, scopeKey, scopeSchema } from '../shell/scope';
import type { ReportScope } from '../shell/scope';
import type { ReportHostEnv } from '../shell/host.vscode';
import { performTableAction } from '../shell/table-actions.vscode';
import type { TableActionEnv } from '../shell/table-actions.vscode';
import { planStorageAction } from './actions';
import { storageKind } from './kind';
import type { StorageReport, StorageTable } from './model';
import { readStorage } from './read';

const COMMAND = 'aantje.showStorage';

interface StorageReportEnv extends ReportHostEnv, TableActionEnv {
  readonly showProperties: (profile: ConnectionProfile) => Promise<void>;
}

/** Inspect Data Files of a table: the command of the table's node, at the snapshot that the tree shows. */
async function inspectFiles(
  env: Pick<TableActionEnv, 'tree'>,
  connectionId: string,
  table: StorageTable,
): Promise<void> {
  const node = await findEntryNode(env.tree, connectionId, {
    kind: 'table',
    id: table.id,
    name: table.name,
    schemaId: table.schemaId,
    schemaName: table.schema,
  });
  if (node) {
    await vscode.commands.executeCommand('aantje.inspectDataFiles', node);
  } else {
    void vscode.window.showInformationMessage(
      `The tree does not show "${table.schema}.${table.name}". It may not exist at the snapshot that the tree shows.`,
    );
  }
}

/** The Storage report: one panel per connection and scope (the lake or one schema). */
export function createStorageReport(env: StorageReportEnv): StorageReport {
  const { tree } = env;

  const report = openReport(env, {
    command: COMMAND,
    kind: storageKind,
    noun: 'storage report',
    goal: 'show its storage',
    keyOf: (profile, { scope }: { readonly scope: ReportScope }) => scopeKey(profile.id, scope),
    open: (reader, profile, { scope }) => {
      const snapshot = shownSnapshot(tree.state(profile.id));
      return snapshot !== undefined
        ? {
            progress: `Reading the storage of "${profile.name}"...`,
            read: (signal) => readStorage(reader, profile.name, snapshot, new Date(), signal, scope),
            title: () => `${reportHeading('Storage Report', scopeSchema(scope))} · ${profile.name}`,
          }
        : undefined;
    },
    planAction: planStorageAction,
    perform: async (plan, profile, data) => {
      if (plan.action === 'showProperties') {
        await env.showProperties(profile);
        return;
      }
      if (plan.action === 'inspectFiles') {
        await inspectFiles(env, profile.id, plan.table);
        return;
      }
      await performTableAction(env, profile.id, plan, data.snapshot);
    },
  });

  return {
    show: (profile, scope = LAKE_SCOPE) => report.show(profile, { scope }),
    dispose: () => report.dispose(),
  };
}
