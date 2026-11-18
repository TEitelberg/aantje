// The reports that look into the lake beyond its catalog tables: the Catalog Dashboard, the Parquet inspector, Suggest
// Partitioning and Inactive Tables. One registration, so that the composition root names them once.
import type * as vscode from 'vscode';
import { registerCatalogDashboard } from './catalog-dashboard/commands.vscode';
import type { DataAccessFactory } from './data/resolve';
import type { SqlParser } from './dependencies/parser';
import { registerInactiveTables } from './inactive-tables/commands.vscode';
import type { ChoiceStore } from './inactive-tables/commands.vscode';
import { registerParquetInspector } from './parquet/commands.vscode';
import { registerPartitioning } from './partitioning/commands.vscode';
import type { ReportCommandEnv } from './shell/report-port.vscode';
import type { TableActionEnv } from './shell/table-actions.vscode';
import type { QueryHistory } from './sql/history';

/**
 * What the reports need: the report and table actions, the storage sign-in, the local Query History with a parser, and
 * the global state that keeps the choices of a report.
 */
export interface InsightEnv extends ReportCommandEnv, TableActionEnv {
  readonly dataAccess: DataAccessFactory;
  readonly history: Pick<QueryHistory, 'entries'>;
  readonly parser: Pick<SqlParser, 'serialize'>;
  readonly choices: ChoiceStore;
}

export function registerInsights(env: InsightEnv): vscode.Disposable[] {
  return [
    ...registerCatalogDashboard(env),
    ...registerParquetInspector(env),
    ...registerPartitioning(env),
    ...registerInactiveTables(env),
  ];
}
