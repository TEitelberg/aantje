import * as vscode from 'vscode';
import { findEntryNode, shownSnapshot } from '../actions';
import { showConnectFirst } from '../command.vscode';
import type { Register } from '../command.vscode';
import { DEFAULT_SNAPSHOT_LIMIT, findLastGood } from '../health/last-good';
import type { FindingScope, HealthScope } from '../health/model';
import type { HealthDeps } from '../health/run';
import { pickOne } from '../pick.vscode';
import { openReport } from '../shell/host.vscode';
import type { ReportHostEnv } from '../shell/host.vscode';
import { scopeOfNode } from '../shell/scope';
import { snapshotChoices } from '../snapshot';
import type { TreeNode } from '../tree/refs';
import type { HealthTarget } from './controller';
import { lastGoodKind, planLastGoodAction } from './last-good';
import type { ChangedTable, LastGoodData } from './last-good';
import { healthKey, healthScopeLabel, lastGoodHeading } from './model';

const AT_COMMAND = 'aantje.checkHealthAtSnapshot';
const LAST_GOOD_COMMAND = 'aantje.findLastGoodSnapshot';
const GOAL = 'check its health';

interface SnapshotHealthEnv extends ReportHostEnv {
  readonly register: Register;
  /** The reader, the data access and the facts of the check, as Check Health uses them. */
  readonly healthDeps: (connectionId: string) => Promise<HealthDeps>;
  /** The target of a connection that is open, or undefined after telling the user to connect. */
  readonly targetOf: (connectionId: string, scope: FindingScope) => HealthTarget | undefined;
  readonly openAndRun: (target: HealthTarget) => void;
}

/** The scope of a node for these commands: the lake (also of a snapshot node), a schema or a table. */
function findingScopeOf(node: TreeNode): FindingScope | undefined {
  const { ref } = node;
  if (ref.kind === 'snapshot') return { kind: 'lake' };
  if (ref.kind === 'table')
    return { kind: 'table', id: ref.table.id, schema: ref.schema.name, name: ref.table.name };
  return scopeOfNode(ref);
}

function requestScope(scope: FindingScope): HealthScope {
  switch (scope.kind) {
    case 'lake':
      return { kind: 'lake' };
    case 'schema':
      return { kind: 'schema', schemaId: scope.id };
    case 'table':
      return { kind: 'table', tableId: scope.id };
  }
}

type LastGoodParams = { readonly scope: FindingScope; readonly limit: number };

/** The tables of the newest snapshot that changed after the good one: what a restore to it brings back. */
async function changedTables(deps: HealthDeps, data: Omit<LastGoodData, 'tables'>): Promise<ChangedTable[]> {
  const { good, newest } = data.result;
  if (!good || good.id === newest) return [];
  const [changes, entries] = await Promise.all([
    deps.reader.lastTableChanges(newest),
    deps.reader.entries(newest),
  ]);
  const tables = new Map(entries.filter((entry) => entry.kind === 'table').map((entry) => [entry.id, entry]));
  return changes.flatMap((change): ChangedTable[] => {
    const table = tables.get(change.tableId);
    const inScope = data.scope.kind !== 'table' || data.scope.id === change.tableId;
    return table && inScope && change.snapshot > good.id
      ? [
          {
            id: table.id,
            schemaId: table.schemaId,
            schema: table.schemaName,
            name: table.name,
            lastChange: change.snapshot,
          },
        ]
      : [];
  });
}

/** Check Health at Snapshot... and Find Last Good Snapshot...: the health check for the state of an older snapshot. */
export function registerSnapshotHealth(env: SnapshotHealthEnv): vscode.Disposable[] {
  const { tree, store } = env;

  const lastGood = openReport(env, {
    command: LAST_GOOD_COMMAND,
    kind: lastGoodKind,
    noun: 'last good snapshot',
    goal: GOAL,
    keyOf: (profile, { scope }: LastGoodParams) => healthKey(profile.id, scope),
    open: (_reader, profile, { scope, limit }) => ({
      progress: `Looking for the last good snapshot of ${healthScopeLabel(scope)} of "${profile.name}"...`,
      read: async (signal, report) => {
        const deps = await env.healthDeps(profile.id);
        const result = await findLastGood(deps, requestScope(scope), limit, {
          signal,
          onProgress: (done, total) => report(`${done} of ${total} snapshots`),
        });
        const data = { connection: profile.name, scope, result };
        return { ...data, tables: await changedTables(deps, data) };
      },
      title: () => `${lastGoodHeading(scope)} · ${profile.name}`,
    }),
    planAction: planLastGoodAction,
    perform: async (plan, profile, data) => {
      if (plan.action === 'showCatalog') {
        tree.selectSnapshot(profile.id, plan.snapshot);
        env.active.select(profile.id);
        return;
      }
      if (plan.action === 'lookFurther') {
        await lastGood.show(profile, { scope: data.scope, limit: plan.limit });
        return;
      }
      const { table } = plan;
      const node = await findEntryNode(tree, profile.id, {
        kind: 'table',
        id: table.id,
        name: table.name,
        schemaId: table.schemaId,
        schemaName: table.schema,
      });
      if (!node) {
        void vscode.window.showInformationMessage(
          `The tree does not show "${table.schema}.${table.name}". It may not exist at the snapshot that the tree shows.`,
        );
        return;
      }
      await vscode.commands.executeCommand(
        plan.action === 'queryAtSnapshot' ? 'aantje.queryAtSnapshot' : 'aantje.restoreTableToSnapshot',
        node,
      );
    },
    // A Refresh looks as far as the panel was opened with.
    refreshParams: (params) => params,
  });

  async function checkAt(node: TreeNode | undefined): Promise<void> {
    const scope = node && findingScopeOf(node);
    if (!node || !scope) return;
    const { connectionId } = node.ref;
    const target = env.targetOf(connectionId, scope);
    const reader = tree.reader(connectionId);
    if (!target || !reader) return;
    let at = node.ref.kind === 'snapshot' ? node.ref.snapshot.id : undefined;
    if (at === undefined) {
      const items = snapshotChoices(await reader.snapshots(), shownSnapshot(tree.state(connectionId)));
      const chosen = await pickOne(items, {
        title: `Check Health at Snapshot · ${healthScopeLabel(scope)}`,
        placeholder: 'The snapshot whose files and catalog rows to check',
        active: items.filter((item) => item.picked),
      });
      at = chosen?.value;
    }
    if (at !== undefined) env.openAndRun({ ...target, at });
  }

  return [
    { dispose: () => lastGood.dispose() },
    env.register(AT_COMMAND, checkAt),
    env.register(LAST_GOOD_COMMAND, async (node) => {
      const scope = node && findingScopeOf(node);
      if (!node || !scope || node.ref.kind === 'snapshot') return;
      const profile = store.get(node.ref.connectionId);
      if (!profile || !tree.reader(profile.id)) {
        showConnectFirst(GOAL);
        return;
      }
      await lastGood.show(profile, { scope, limit: DEFAULT_SNAPSHOT_LIMIT });
    }),
  ];
}
