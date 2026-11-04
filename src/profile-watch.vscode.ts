import * as vscode from 'vscode';
import type { ConnectionStore } from './connections/store';
import type { Logger } from './log';
import { invalidEntriesText, reopenedIds, signaturesOf } from './profile-changes';
import type { QueryEditors } from './sql/editor';
import type { CatalogTree } from './tree/model';

interface ProfileWatchEnv {
  readonly store: ConnectionStore;
  readonly tree: CatalogTree;
  readonly editors: Pick<QueryEditors, 'profilesChanged'>;
  readonly logger: Logger;
  /** Runs after each setting change, once the tree and sessions know about it. */
  readonly onChanged: () => void;
}

interface ProfileWatch {
  /** Ids Edit Connection is saving; the setting change must not reopen them. */
  readonly editing: Set<string>;
  /** Logs skipped setting entries and warns once per new set. */
  readonly reportProblems: () => void;
  readonly disposable: vscode.Disposable;
}

// An edited path or host reopens that connection. A connection being edited is left to the edit command, which
// reopens it after the new password is stored; the setting change comes too early.
export function watchProfiles(env: ProfileWatchEnv): ProfileWatch {
  const { store, tree, logger } = env;
  const editing = new Set<string>();
  let known = signaturesOf(store.list());
  let reported = '';

  function reopenChanged(): void {
    const profiles = store.list();
    const changed = reopenedIds(known, profiles);
    known = signaturesOf(profiles);
    for (const node of tree.roots()) {
      if (changed.has(node.ref.connectionId) && !editing.has(node.ref.connectionId)) {
        tree.refresh(node);
      }
    }
  }

  function reportProblems(): void {
    const problems = store.problems();
    const text = problems.join('\n');
    if (text === reported) {
      return;
    }
    reported = text;
    for (const problem of problems) {
      logger.warn(`Ignored an entry of "aantje.connections": ${problem}`);
    }
    const warning = invalidEntriesText(problems.length);
    if (warning) {
      void vscode.window.showWarningMessage(warning);
    }
  }

  return {
    editing,
    reportProblems,
    disposable: vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('aantje.connections')) {
        return;
      }
      tree.profilesChanged();
      reopenChanged();
      env.editors.profilesChanged().catch((error: unknown) => {
        logger.error('Updating the SQL sessions after a change of the connections failed.', error);
      });
      reportProblems();
      env.onChanged();
    }),
  };
}
