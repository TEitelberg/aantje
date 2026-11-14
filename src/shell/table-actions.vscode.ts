import * as vscode from 'vscode';
import { findEntryNode } from '../actions';
import type { CatalogEntry } from '../catalog/model';
import { maintenanceScript } from '../maintenance/scripts';
import type { MaintenanceKind } from '../maintenance/scripts';
import type { DeletedRead } from '../maintenance/deletes';
import { scriptTarget } from '../script-target';
import type { ReportTable } from '../script-target';
import type { StatisticsTarget } from '../stats/target';
import type { CatalogTree } from '../tree/model';
import type { TreeNode } from '../tree/refs';

/** What table actions in a report need from the extension. */
export interface TableActionEnv {
  readonly tree: CatalogTree;
  readonly view: Pick<vscode.TreeView<TreeNode>, 'reveal'>;
  /** Opens the text in an untitled SQL document; nothing runs. */
  readonly openSql: (connectionId: string, text: string) => Promise<void>;
  readonly showStatistics: (target: StatisticsTarget, snapshot: number) => Promise<void>;
}

/** The script of a table or the lake; `deleted` are the small files with deleted rows that the report counted. */
interface ScriptPlan {
  readonly kind: MaintenanceKind;
  readonly table?: ReportTable;
  readonly deleted?: DeletedRead;
}

type TableActionPlan =
  | { readonly action: 'showStatistics' | 'revealTable'; readonly table: ReportTable }
  | ({ readonly action: 'script' } & ScriptPlan);

/** Carries out a table action; `snapshot` is the one the report was read at. */
export async function performTableAction(
  env: TableActionEnv,
  connectionId: string,
  plan: TableActionPlan,
  snapshot: number,
): Promise<void> {
  switch (plan.action) {
    case 'showStatistics':
      await env.showStatistics(tableStatisticsTarget(connectionId, plan.table), snapshot);
      return;
    case 'revealTable':
      await revealEntry(env, connectionId, entryOf(plan.table), `${plan.table.schema}.${plan.table.name}`);
      return;
    case 'script':
      await openTableScript(env, connectionId, plan);
  }
}

export function tableStatisticsTarget(
  connectionId: string,
  table: Pick<ReportTable, 'id' | 'schema' | 'name'>,
): StatisticsTarget {
  return { connectionId, tableId: table.id, schema: table.schema, table: table.name };
}

/** Selects the entry's tree node, or says the tree does not show it at its snapshot. */
export async function revealEntry(
  env: Pick<TableActionEnv, 'tree' | 'view'>,
  connectionId: string,
  entry: CatalogEntry | undefined,
  name: string,
): Promise<void> {
  const node = entry && (await findEntryNode(env.tree, connectionId, entry));
  if (node) {
    await env.view.reveal(node, { select: true, focus: true });
  } else {
    void vscode.window.showInformationMessage(
      `The tree does not show "${name}". It may not exist at the snapshot that the tree shows.`,
    );
  }
}

/** Opens the plan's maintenance script in an SQL document; without counts of the report a merge reads them. */
export async function openTableScript(
  env: Pick<TableActionEnv, 'tree' | 'openSql'>,
  connectionId: string,
  plan: ScriptPlan,
): Promise<void> {
  const { kind, ref } = scriptTarget(connectionId, plan);
  const text = await maintenanceScript(env.tree, kind, ref, plan.deleted);
  if (text !== undefined) {
    await env.openSql(connectionId, text);
  }
}

function entryOf(table: ReportTable): CatalogEntry {
  return {
    kind: 'table',
    id: table.id,
    name: table.name,
    schemaId: table.schemaId,
    schemaName: table.schema,
  };
}
