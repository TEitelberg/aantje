import * as vscode from 'vscode';
import type { Register } from './command.vscode';
import { commentInput, commentOfInput, commentScript, commentTargetOf } from './comments';
import type { CatalogTree } from './tree/model';

interface CommentEnv {
  readonly tree: CatalogTree;
  readonly register: Register;
  /** Opens the text in a new SQL editor bound to the connection; it never runs it. */
  readonly openSql: (connectionId: string, text: string) => Promise<void>;
}

const NESTED =
  'DuckLake keeps comments on the top-level columns of a table only, not on the fields inside a column.';
const LINE_BREAKS = 'Write a line break as \\n and a backslash as \\\\. Empty removes the comment.';

// The comment as the user typed it; undefined when the input was cancelled.
async function askComment(title: string, current: string | null): Promise<string | null | undefined> {
  const input = await vscode.window.showInputBox({
    title,
    prompt: LINE_BREAKS,
    value: commentInput(current),
    ignoreFocusOut: true,
  });
  return input === undefined ? undefined : commentOfInput(input);
}

/** Edit Comment on a table, a view or a column of a table. */
export function registerCommentCommands({ tree, register, openSql }: CommentEnv): vscode.Disposable[] {
  return [
    register('aantje.editComment', async (node) => {
      const target = node && commentTargetOf(node.ref);
      if (!node || target === undefined) return;
      if (target === 'nested') {
        void vscode.window.showInformationMessage(NESTED);
        return;
      }
      const comment = await askComment(`Comment of ${node.label}`, target.current);
      if (comment !== undefined) {
        await openSql(
          node.ref.connectionId,
          commentScript(tree, node.ref.connectionId, [{ target, comment }]),
        );
      }
    }),
  ];
}
