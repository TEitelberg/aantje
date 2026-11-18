import * as vscode from 'vscode';
import { openReport } from '../shell/host.vscode';
import type { ReportCommandEnv } from '../shell/report-port.vscode';
import { planDashboardAction } from './actions';
import { dashboardKind } from './kind';
import { DASHBOARD_HEADING } from './model';
import { readDashboard } from './read';

const COMMAND = 'aantje.showCatalogDashboard';

/**
 * A script for another client: VACUUM runs in PostgreSQL, which the SQL editor of aantje (DuckDB) cannot reach, so the
 * document belongs to no connection. Opening it runs nothing.
 */
async function openClientScript(text: string): Promise<void> {
  await vscode.window.showTextDocument(
    await vscode.workspace.openTextDocument({ language: 'sql', content: text }),
  );
}

/** Catalog Dashboard: size, growth and vacuum state of the database that holds the catalog; one panel per connection. */
export function registerCatalogDashboard(env: ReportCommandEnv): vscode.Disposable[] {
  const report = openReport(env, {
    command: COMMAND,
    kind: dashboardKind,
    noun: 'catalog dashboard',
    goal: 'show its catalog dashboard',
    keyOf: (profile) => profile.id,
    open: (reader, profile) => ({
      progress: `Reading the catalog database of "${profile.name}"...`,
      read: (signal) => readDashboard(reader, profile, signal),
      title: () => `${DASHBOARD_HEADING} · ${profile.name}`,
    }),
    planAction: planDashboardAction,
    perform: (script) => openClientScript(script),
  });
  return [
    { dispose: () => report.dispose() },
    report.command(env.register, (ref) => (ref.kind === 'connection' ? {} : undefined)),
  ];
}
