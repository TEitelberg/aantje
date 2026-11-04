import * as vscode from 'vscode';
import { isAborted } from './data/aborted';
import { userMessageOf } from './errors';
import { showError } from './health-report/error-action.vscode';
import type { Logger } from './log';
import { connectFirstText } from './messages';
import type { TreeNode } from './tree/refs';

/** Registers a command; the handler gets the tree node it was invoked on, if any. */
export type Register = (id: string, handler: (node?: TreeNode) => Promise<void> | void) => vscode.Disposable;

/** Registers a command whose failure is logged and shown; declining or cancelling gets an info message instead. */
export function commandRegistrar(logger: Logger): Register {
  return (id, handler) =>
    vscode.commands.registerCommand(id, (node?: TreeNode) => guarded(logger, id, () => handler(node)));
}

/** Runs `run` for the command `id` and reports failure or a stop like `commandRegistrar`; report actions use it too. */
export async function guarded(logger: Logger, id: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (isAborted(error)) {
      logger.info(`The command ${id} was stopped: ${userMessageOf(error)}`);
      void vscode.window.showInformationMessage(userMessageOf(error));
      return;
    }
    logger.error(`The command ${id} failed.`, error);
    showError(error);
  }
}

/** Tells the user to connect first; `goal` completes "Connect to a catalog first to ...". */
export function showConnectFirst(goal: string): void {
  void vscode.window.showInformationMessage(connectFirstText(goal));
}
