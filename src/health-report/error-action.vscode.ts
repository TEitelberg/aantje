import * as vscode from 'vscode';
import { userMessageOf } from '../errors';
import { offerFor } from './offer';
import type { HealthOffer } from './offer';

type Starter = (offer: HealthOffer) => Promise<void>;

let start: Starter | undefined;

/** Sets what the button in an error message does; the health check registers it when the extension starts. */
export function onHealthRequested(starter: Starter): vscode.Disposable {
  start = starter;
  return new vscode.Disposable(() => {
    if (start === starter) start = undefined;
  });
}

/** Shows an error; a failed lake read that the health check can look at gets a button that opens the check. */
export function showError(error: unknown): void {
  const message = userMessageOf(error);
  const offer = start && offerFor(error);
  if (!offer || !start) {
    void vscode.window.showErrorMessage(message);
    return;
  }
  const starter = start;
  void Promise.resolve(vscode.window.showErrorMessage(message, offer.label))
    .then(async (choice) => {
      if (choice === offer.label) {
        await starter(offer);
      }
    })
    // The starter reports its own failures; a message that cannot be shown has nowhere to be reported.
    .catch(() => undefined);
}
