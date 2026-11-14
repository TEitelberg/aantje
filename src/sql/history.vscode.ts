import * as vscode from 'vscode';
import type { Register } from '../command.vscode';
import type { Logger, SecretRegistry } from '../log';
import type { CatalogTree } from '../tree/model';
import type { QueryEditors } from './editor';
import { openForConnection } from './editor.vscode';
import { historySizeOf, QueryHistory } from './history';

const historySize = (): number =>
  historySizeOf(vscode.workspace.getConfiguration('aantje').get<unknown>('queryHistory.size'));

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

/** The commands of the Query History, and the setting `aantje.queryHistory.size`. */
export function registerQueryHistory(env: QueryHistoryEnv): vscode.Disposable[] {
  const { history, tree, editors, register } = env;
  let shown = history.shown();
  return [
    // A click opens the statement in a new SQL document of the connection; nothing runs.
    register('aantje.openQueryHistoryEntry', async (node) => {
      if (node?.ref.kind === 'query') {
        await openForConnection(editors, node.ref.entry.sql, node.ref.connectionId);
      }
    }),
    register('aantje.copyQueryHistorySql', async (node) => {
      if (node?.ref.kind === 'query') {
        await vscode.env.clipboard.writeText(node.ref.entry.sql);
        vscode.window.setStatusBarMessage('Copied the SQL', 3000);
      }
    }),
    register('aantje.clearQueryHistory', async (node) => {
      if (node) await history.clear(node.ref.connectionId);
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
