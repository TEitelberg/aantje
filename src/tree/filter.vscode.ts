import * as vscode from 'vscode';
import type { Register } from '../command.vscode';
import type { Logger } from '../log';
import { appliedFilter, filterKeyOf, MAX_FILTER_LENGTH, ownFilter, TreeFilters } from './filter';
import type { CatalogTree } from './model';
import type { TreeNode } from './refs';

/** The filters of the tree in the workspace state of VS Code: per workspace, not synchronised. */
export function createTreeFilters(state: vscode.Memento, logger: Logger): TreeFilters {
  return new TreeFilters(state, (message, error) => logger.error(message, error));
}

interface FilterEnv {
  readonly tree: CatalogTree;
  readonly filters: TreeFilters;
  readonly register: Register;
}

// The levels of the connection are read again without reopening it; stable ids keep what was expanded.
async function applied(env: FilterEnv, node: TreeNode, key: string, text: string): Promise<void> {
  await env.filters.set(node.ref.connectionId, key, text);
  env.tree.reread(node.ref.connectionId);
}

/** Filter... and Clear Filter on a connection, a schema and its folders Tables, Views and Macros. */
export function registerFilterCommands(env: FilterEnv): vscode.Disposable[] {
  const { tree, register } = env;
  return [
    register('aantje.filterTree', async (node) => {
      const key = node && filterKeyOf(node.ref);
      if (!node || key === undefined) return;
      const text = await vscode.window.showInputBox({
        title: `Filter ${node.label}`,
        prompt:
          'A part of the name, or a pattern with * (any characters) and ? (one character); case is ignored. Empty clears the filter.',
        placeHolder: 'sales*',
        value: ownFilter(tree.filtersOf(node.ref.connectionId), node.ref) ?? '',
        validateInput: (value) =>
          value.length > MAX_FILTER_LENGTH ? `At most ${MAX_FILTER_LENGTH} characters.` : undefined,
      });
      if (text !== undefined) await applied(env, node, key, text);
    }),
    // On the message that a filter matches nothing, the filter of its folder is meant.
    register('aantje.clearTreeFilter', async (node) => {
      const target = node?.ref.kind === 'message' ? tree.parent(node) : node;
      if (!target) return;
      const filter = appliedFilter(tree.filtersOf(target.ref.connectionId), target.ref);
      if (filter) {
        await applied(env, target, filter.key, '');
      } else {
        void vscode.window.showInformationMessage(`No filter applies to "${target.label}".`);
      }
    }),
  ];
}
