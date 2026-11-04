import * as vscode from 'vscode';
import type { SchemaDocuments } from '../compare.vscode';
import type { Register } from '../command.vscode';
import type { ConnectionProfile } from '../connections/profile';
import type { DataActions } from '../data/commands.vscode';
import type { TableRef } from '../data/types';
import { timeTravelUi } from '../pick.vscode';
import type { ReportPort } from './report-port';
import { openMarkdown } from './host.vscode';
import type { ReportHostEnv } from './host.vscode';

/** What the commands of all reports need. */
export interface ReportCommandEnv extends ReportHostEnv {
  readonly actions: DataActions;
  /** The schema diff documents, which the snapshot report shows too. */
  readonly schemaDocuments: SchemaDocuments;
  readonly register: Register;
}

/** What report actions do in VS Code for a connection: tree, grid, diff editor and report document. */
export function reportPortOf(
  env: Pick<ReportCommandEnv, 'tree' | 'actions' | 'schemaDocuments' | 'active'>,
  profile: ConnectionProfile,
): ReportPort {
  const { tree, active } = env;
  const connectionId = profile.id;
  const target = (table: TableRef) => ({
    relation: { connectionId, kind: 'table' as const, table },
    profile,
    state: tree.state(connectionId),
  });
  return {
    connectionId,
    connectionName: profile.name,
    ui: timeTravelUi,
    reader: () => tree.reader(connectionId),
    showCatalog: (snapshot) => {
      tree.selectSnapshot(connectionId, snapshot);
      active.select(connectionId);
    },
    showsLatest: () => tree.state(connectionId).snapshot === 'latest',
    showChanges: (choice) => env.actions.showChanges(target(choice.table), choice),
    showSchema: async (comparison) => {
      await env.schemaDocuments.show(comparison);
      void vscode.window.showInformationMessage(comparison.summary);
    },
    showReport: openMarkdown,
    showRows: (table, snapshot) => env.actions.showRows(target(table), snapshot),
    createNotebook: (table, snapshot) => env.actions.createNotebook(target(table), snapshot, snapshot),
    openSql: (text) => env.actions.openSql(connectionId, text),
  };
}
