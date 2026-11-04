import * as vscode from 'vscode';
import type { ConnectionProfile } from '../connections/profile';
import type { Logger } from '../log';
import { viewConfirmation } from './confirm';
import { ViewTrustStore } from './trust';

const KEY = 'aantje.trustedViews';

/**
 * The connections whose views the user allowed to run, kept in the extension's global state. A stored value that is
 * not a list of texts counts as no trust (logged once); the next confirmation writes a proper list.
 */
export function createTrustStore(state: vscode.Memento, log: Pick<Logger, 'warn'>): ViewTrustStore {
  let warned = false;
  return new ViewTrustStore({
    get: () => {
      const stored: unknown = state.get(KEY);
      if (stored === undefined) return [];
      if (Array.isArray(stored) && stored.every((key: unknown): key is string => typeof key === 'string')) {
        return stored;
      }
      if (!warned) {
        warned = true;
        log.warn(
          `The stored list of trusted views (${KEY}) is not a list of texts and is ignored: no connection is trusted until it is confirmed again.`,
        );
      }
      return [];
    },
    update: async (value) => {
      await state.update(KEY, [...value]);
    },
  });
}

/** The modal question before views are resolved. */
export function confirmViews(trust: ViewTrustStore): (profile: ConnectionProfile) => Promise<void> {
  return viewConfirmation({
    trust,
    ask: async ({ message, detail, accept }) =>
      (await vscode.window.showWarningMessage(message, { modal: true, detail }, accept)) === accept,
  });
}
