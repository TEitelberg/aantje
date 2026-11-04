import * as vscode from 'vscode';
import type { ConnectionProfile } from './connections/profile';
import type { ConnectionStore } from './connections/store';
import { activeProfile, statusBarContent } from './status';
import type { CatalogTree } from './tree/model';
import type { TreeNode } from './tree/refs';

/** The connection that commands without a node (title bar, status bar, palette) act on. */
export interface ActiveConnection {
  current(): ConnectionProfile | undefined;
  select(id: string): void;
}

interface ActiveConnectionEnv {
  readonly store: Pick<ConnectionStore, 'list'>;
  readonly tree: Pick<CatalogTree, 'state' | 'onDidChange'>;
  readonly view: vscode.TreeView<TreeNode>;
}

/** Tracks the connection in use and shows it in the status bar while the explorer is open or a connection is in use. */
export function createActiveConnection(env: ActiveConnectionEnv): {
  readonly active: ActiveConnection;
  /** Shows the item again; call it after a dependency changed that the tree does not report. */
  readonly updateStatus: () => void;
  readonly disposable: vscode.Disposable;
} {
  const { store, tree, view } = env;
  const statusItem = vscode.window.createStatusBarItem('aantje.status', vscode.StatusBarAlignment.Left, 0);
  statusItem.name = 'aantje';
  let inUse: string | undefined;

  const active: ActiveConnection = {
    current: () => activeProfile(store.list(), inUse, (profile) => tree.state(profile.id).status),
    select: (id) => {
      inUse = id;
      updateStatus();
    },
  };

  function updateStatus(): void {
    const profile = active.current();
    const state = profile && tree.state(profile.id);
    const content =
      profile && state && (view.visible || state.status !== 'disconnected')
        ? statusBarContent({
            connectionName: profile.name,
            status: state.status,
            specVersion: state.specVersion,
            snapshot: state.snapshot,
            latestSnapshot: state.latestSnapshot,
          })
        : undefined;
    if (!content) {
      statusItem.hide();
      return;
    }
    statusItem.text = content.text;
    statusItem.tooltip = content.tooltip;
    statusItem.command = state?.status === 'connected' ? 'aantje.selectSnapshot' : undefined;
    statusItem.show();
  }

  return {
    active,
    updateStatus,
    disposable: vscode.Disposable.from(
      statusItem,
      tree.onDidChange(updateStatus),
      view.onDidChangeVisibility(updateStatus),
      view.onDidChangeSelection(({ selection }) => {
        const [node] = selection;
        if (node) {
          active.select(node.ref.connectionId);
        }
      }),
    ),
  };
}
