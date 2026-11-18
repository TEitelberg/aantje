import * as vscode from 'vscode';
import type { Register } from '../command.vscode';
import type { Logger, SecretRegistry } from '../log';
import { plural } from '../shell/model';
import { DoubleClicks } from '../tree/double-click';
import type { CatalogTree } from '../tree/model';
import { CLICK_QUERY } from '../tree/nodes';
import type { TreeNode } from '../tree/refs';
import type { QueryEditors } from './editor';
import { openForConnection } from './editor.vscode';
import { historySizeOf, QueryHistory } from './history';

const historySize = (): number =>
  historySizeOf(vscode.workspace.getConfiguration('aantje').get<unknown>('queryHistory.size'));

// With the user's `workbench.list.openMode` set to `doubleClick`, VS Code itself runs the command of a row only on a
// double-click (and on Enter). aantje reads the setting and never changes it.
const opensOnDoubleClick = (): boolean =>
  vscode.workspace.getConfiguration('workbench.list').get<unknown>('openMode') === 'doubleClick';

const NAME_TAKEN = 'Another favorite of this connection already has this name.';

/** The Query History in the global state of VS Code on this machine: not synchronised, not in the workspace. */
export function createQueryHistory(
  state: vscode.Memento,
  logger: Logger,
  secrets: SecretRegistry,
): QueryHistory {
  return new QueryHistory(
    state,
    historySize,
    (message, error) => logger.error(message, error),
    (text) => secrets.redact(text),
  );
}

interface QueryHistoryEnv {
  readonly history: QueryHistory;
  readonly tree: CatalogTree;
  readonly editors: QueryEditors;
  readonly register: Register;
}

/** The commands of the Query History and its favourites, and the setting `aantje.queryHistory.size`. */
export function registerQueryHistory(env: QueryHistoryEnv): vscode.Disposable[] {
  const { history, tree, editors, register } = env;
  let shown = history.shown();
  const clicks = new DoubleClicks(() => performance.now());
  // Opens the statement in a new SQL document of the connection; nothing runs.
  const open = async (node?: TreeNode): Promise<void> => {
    if (node?.ref.kind === 'query') {
      await openForConnection(editors, node.ref.entry.sql, node.ref.connectionId);
    }
  };
  return [
    register('aantje.openQueryHistoryEntry', open),
    // The command of the row of a statement or favourite: a click selects it, a double-click opens it.
    register(CLICK_QUERY, async (node) => {
      if (node?.ref.kind === 'query' && (opensOnDoubleClick() || clicks.click(node.id))) await open(node);
    }),
    register('aantje.copyQueryHistorySql', async (node) => {
      if (node?.ref.kind === 'query') {
        await vscode.env.clipboard.writeText(node.ref.entry.sql);
        vscode.window.setStatusBarMessage('Copied the SQL', 3000);
      }
    }),
    register('aantje.clearQueryHistory', async (node) => {
      if (!node) return;
      const { connectionId } = node.ref;
      await history.clearEntries(connectionId);
      const kept = history.favorites(connectionId).length;
      if (kept > 0) {
        void vscode.window.showInformationMessage(
          `Cleared the Query History. The ${plural(kept, 'favorite is', 'favorites are')} kept.`,
        );
      }
    }),
    register('aantje.addQueryFavorite', async (node) => {
      if (node?.ref.kind !== 'query' || node.ref.favorite) return;
      const added = await history.addFavorite(node.ref.connectionId, node.ref.entry);
      if (!added) {
        void vscode.window.showInformationMessage('This statement is already a favorite.');
      }
    }),
    register('aantje.removeQueryFavorite', async (node) => {
      const favorite = node?.ref.kind === 'query' ? node.ref.favorite : undefined;
      if (node && favorite) await history.removeFavorite(node.ref.connectionId, favorite.id);
    }),
    register('aantje.renameQueryFavorite', async (node) => {
      const favorite = node?.ref.kind === 'query' ? node.ref.favorite : undefined;
      if (!node || !favorite) return;
      const { connectionId } = node.ref;
      // The names of the favourites of a connection are unique, as the tree shows them; empty shows the statement.
      const label = await vscode.window.showInputBox({
        title: 'Rename Favorite',
        prompt:
          'A name of your own for the favorite; empty shows the statement again. The tooltip keeps the SQL.',
        value: favorite.label ?? '',
        validateInput: (text) =>
          history.favoriteNameTaken(connectionId, favorite.id, text) ? NAME_TAKEN : undefined,
      });
      if (label === undefined) return;
      // Another favourite may have taken the name while the box was open.
      if (!(await history.renameFavorite(connectionId, favorite.id, label))) {
        void vscode.window.showInformationMessage(NAME_TAKEN);
      }
    }),
    // A smaller size drops the oldest entries, 0 all of them; switching it on or off adds or removes the folder.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('aantje.queryHistory.size')) return;
      void history.trim();
      if (history.shown() !== shown) {
        shown = history.shown();
        tree.reread();
      }
    }),
  ];
}
