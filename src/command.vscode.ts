import * as vscode from 'vscode';
import { isAborted, userMessageOf } from './errors';
import type { Logger } from './log';
import { connectFirstText } from './messages';
import type { TreeNode } from './tree/refs';

/** Registers a command; the handler gets the tree node it was invoked on, if any. */
export type Register = (id: string, handler: (node?: TreeNode) => Promise<void> | void) => vscode.Disposable;

/** Registers a command whose failure is logged and shown; declining or cancelling gets an info message instead. */
export function commandRegistrar(logger: Logger): Register {
  return (id, handler) => registerGuarded(logger, id, (node) => handler(node as TreeNode | undefined));
}

/** Registers a command as `commandRegistrar` does, for an argument that is no tree node: the handler checks it. */
export function registerGuarded(
  logger: Logger,
  id: string,
  handler: (arg: unknown) => Promise<void> | void,
): vscode.Disposable {
  return vscode.commands.registerCommand(id, (arg: unknown) => guarded(logger, id, () => handler(arg)));
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

/** A button next to an error message, and what it does. */
interface ErrorOffer {
  readonly label: string;
  run(): Promise<void>;
}

/** The button for an error that a feature can look into; undefined for any other error. */
type ErrorOfferProvider = (error: unknown) => ErrorOffer | undefined;

// The features that put a button next to the errors they can explain, as long as their registration lives.
const offers = new Set<ErrorOfferProvider>();

/** Lets a feature put a button next to the errors it can explain; disposing the registration takes it away. */
export function offerOnErrors(provider: ErrorOfferProvider): vscode.Disposable {
  offers.add(provider);
  return new vscode.Disposable(() => offers.delete(provider));
}

/** Shows an error; the first registered feature that can look into it adds its button. */
export function showError(error: unknown): void {
  const message = userMessageOf(error);
  const offer = [...offers].map((provider) => provider(error)).find((found) => found !== undefined);
  if (!offer) {
    void vscode.window.showErrorMessage(message);
    return;
  }
  void Promise.resolve(vscode.window.showErrorMessage(message, offer.label))
    .then(async (choice) => {
      if (choice === offer.label) {
        await offer.run();
      }
    })
    // The feature reports its own failures; a message that cannot be shown has nowhere to be reported.
    .catch(() => undefined);
}

/** Tells the user to connect first; `goal` completes "Connect to a catalog first to ...". */
export function showConnectFirst(goal: string): void {
  void vscode.window.showInformationMessage(connectFirstText(goal));
}
