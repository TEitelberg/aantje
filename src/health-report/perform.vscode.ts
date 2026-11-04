import * as vscode from 'vscode';
import { shownSnapshot } from '../actions';
import type { CatalogEntry, CatalogReader, SnapshotId } from '../catalog/model';
import { connectionClosed } from '../messages';
import { openTableScript, revealEntry, tableStatisticsTarget } from '../shell/table-actions.vscode';
import type { TableActionEnv } from '../shell/table-actions.vscode';
import { endpointQuestion } from './actions';
import type { HealthPlan, TableTarget } from './actions';
import type { HealthTarget } from './controller';

type ActionPlan = Exclude<HealthPlan, { readonly action: 'run' | 'cancel' }>;
type Outcome = 'rerun' | undefined;

const CLOSED_GOAL = 'check its health';

/** Carries out what a finding asks for besides the run. 'rerun' means the setup may have changed. */
export function healthPerformer(
  env: TableActionEnv,
): (plan: ActionPlan, target: HealthTarget) => Promise<Outcome> {
  const entries = entriesOnce(env);
  return (plan, target) => {
    switch (plan.action) {
      case 'maintenanceScript':
        return env.openSql(target.connectionId, plan.text).then(() => undefined);
      case 'inspect':
        return env.openSql(target.connectionId, plan.sql).then(() => undefined);
      case 'setting':
        return openSetting(plan.key);
      case 'setCredentials':
        return setCredentials();
      case 'useEndpoint':
        return useEndpoint(plan);
      case 'revealTable':
        return revealTable(env, entries, plan.table, target);
      case 'showStatistics':
        return showStatistics(env, plan.table, target);
      case 'script':
        return openMaintenanceScript(env, entries, plan, target);
    }
  };
}

type EntryOf = (target: HealthTarget, table: TableTarget) => Promise<CatalogEntry | undefined>;

// A finding names the table by id, schema and name; the tree needs its entry at the snapshot that it shows. The entries
// of a catalog are read once per reader and snapshot: a panel has many buttons, and a refresh brings a new reader.
function entriesOnce(env: TableActionEnv): EntryOf {
  const read = new WeakMap<CatalogReader, Map<SnapshotId, Promise<CatalogEntry[]>>>();
  return async (target, table) => {
    const reader = env.tree.reader(target.connectionId);
    const snapshot = shownSnapshot(env.tree.state(target.connectionId));
    if (!reader || snapshot === undefined) {
      throw connectionClosed(CLOSED_GOAL);
    }
    const bySnapshot = read.get(reader) ?? new Map<SnapshotId, Promise<CatalogEntry[]>>();
    read.set(reader, bySnapshot);
    const pending = bySnapshot.get(snapshot) ?? reader.entries(snapshot);
    bySnapshot.set(snapshot, pending);
    // A failed read is not kept: the next click reads again.
    pending.catch(() => bySnapshot.delete(snapshot));
    return (await pending).find((entry) => entry.kind === 'table' && entry.id === table.id);
  };
}

async function openSetting(key: string): Promise<Outcome> {
  await vscode.commands.executeCommand('workbench.action.openSettings', `aantje.${key}`);
  return undefined;
}

// The command asks in its own masked prompts; the panel never sees the keys.
async function setCredentials(): Promise<Outcome> {
  await vscode.commands.executeCommand('aantje.setS3Credentials');
  return 'rerun';
}

async function useEndpoint(plan: Extract<ActionPlan, { readonly action: 'useEndpoint' }>): Promise<Outcome> {
  const { message, detail, accept } = endpointQuestion(plan);
  if ((await vscode.window.showWarningMessage(message, { modal: true, detail }, accept)) !== accept) {
    return undefined;
  }
  const settings = vscode.workspace.getConfiguration('aantje');
  await settings.update('s3.endpoint', plan.endpoint, vscode.ConfigurationTarget.Global);
  if (plan.urlStyle) {
    await settings.update('s3.urlStyle', plan.urlStyle, vscode.ConfigurationTarget.Global);
  }
  return 'rerun';
}

async function revealTable(
  env: TableActionEnv,
  entryOf: EntryOf,
  table: TableTarget,
  target: HealthTarget,
): Promise<Outcome> {
  const entry = await entryOf(target, table);
  await revealEntry(env, target.connectionId, entry, `${table.schema}.${table.name}`);
  return undefined;
}

async function showStatistics(
  env: TableActionEnv,
  table: TableTarget,
  target: HealthTarget,
): Promise<Outcome> {
  const snapshot = shownSnapshot(env.tree.state(target.connectionId));
  if (snapshot === undefined) {
    throw connectionClosed(CLOSED_GOAL);
  }
  await env.showStatistics(tableStatisticsTarget(target.connectionId, table), snapshot);
  return undefined;
}

async function openMaintenanceScript(
  env: TableActionEnv,
  entryOf: EntryOf,
  plan: Extract<ActionPlan, { readonly action: 'script' }>,
  target: HealthTarget,
): Promise<Outcome> {
  const entry = plan.table && (await entryOf(target, plan.table));
  if (plan.table && !entry) {
    void vscode.window.showInformationMessage(
      `"${plan.table.schema}.${plan.table.name}" does not exist at the snapshot that the tree shows, so the script cannot be written for it.`,
    );
    return undefined;
  }
  await openTableScript(env, target.connectionId, {
    kind: plan.kind,
    ...(entry
      ? { table: { id: entry.id, schemaId: entry.schemaId, schema: entry.schemaName, name: entry.name } }
      : {}),
  });
  return undefined;
}
