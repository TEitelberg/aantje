import * as vscode from 'vscode';
import type { ActiveConnection } from './active-connection.vscode';
import { ddlOf, findEntryNode, qualifiedNameOf, shownSnapshot } from './actions';
import { showConnectFirst } from './command.vscode';
import type { Register } from './command.vscode';
import type { ConnectionStore } from './connections/store';
import { withoutIcons } from './messages';
import { pickOne } from './pick.vscode';
import type { PropertiesReport } from './properties-report/model';
import { searchPickItems } from './search';
import { LAKE_SCOPE, scopeOfNode } from './shell/scope';
import type { StorageReport } from './storage-report/model';
import type { CatalogTree } from './tree/model';
import type { TreeNode } from './tree/refs';

interface CommandEnv {
  readonly tree: CatalogTree;
  readonly store: ConnectionStore;
  readonly view: vscode.TreeView<TreeNode>;
  readonly properties: PropertiesReport;
  readonly storage: StorageReport;
  readonly active: ActiveConnection;
  readonly register: Register;
}

/**
 * The connected connection a command acts on: the one of the node, or without a node the active one. Undefined, after a
 * hint to connect first, when it is not connected.
 */
export function connectedTarget(
  env: Pick<CommandEnv, 'tree' | 'store' | 'active'>,
  node: TreeNode | undefined,
  goal: string,
) {
  const { tree, store, active } = env;
  const profile = node ? store.get(node.ref.connectionId) : active.current();
  const reader = profile && tree.reader(profile.id);
  const state = profile && tree.state(profile.id);
  const snapshot = state && shownSnapshot(state);
  if (!profile || !reader || !state || snapshot === undefined) {
    showConnectFirst(goal);
    return undefined;
  }
  return { profile, reader, state, snapshot };
}

/** Copy a name or DDL, the Properties and Storage reports, and the search of the explorer. */
export function registerCommands(env: CommandEnv): vscode.Disposable[] {
  const { tree, view, register } = env;

  const copy = async (text: string, what: string): Promise<void> => {
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`Copied ${withoutIcons(what)}`, 3000);
  };

  const connected = (node: TreeNode | undefined, goal: string) => connectedTarget(env, node, goal);

  return [
    register('aantje.copyName', async (node) => {
      const name = node && qualifiedNameOf(node.ref);
      if (name !== undefined) {
        await copy(name, name);
      }
    }),

    register('aantje.copyDdl', async (node) => {
      const ddl = node ? await ddlOf(tree, node.ref) : undefined;
      if (node && ddl !== undefined) {
        await copy(ddl, `the DDL of ${node.label}`);
      }
    }),

    register('aantje.showProperties', async (node) => {
      const target = connected(node, 'show its properties');
      if (target) {
        await env.properties.show(target.profile);
      }
    }),

    register('aantje.showStorage', async (node) => {
      const target = connected(node, 'show its storage');
      if (target) {
        await env.storage.show(target.profile, (node && scopeOfNode(node.ref)) ?? LAKE_SCOPE);
      }
    }),

    register('aantje.search', async () => {
      const target = connected(undefined, 'search it');
      if (!target) {
        return;
      }
      const { reader, snapshot } = target;
      const [entries, columns] = await Promise.all([
        reader.entries(snapshot),
        reader.columnEntries(snapshot),
      ]);
      const choice = await pickOne(searchPickItems(entries, columns), {
        title: `Search "${target.profile.name}"`,
        placeholder: 'Type the name of a table, view or column',
      });
      const node = choice && (await findEntryNode(tree, target.profile.id, choice.value));
      if (node) {
        await view.reveal(node, { select: true, focus: true });
      }
    }),
  ];
}
