import * as vscode from 'vscode';
import type { ConnectionStore } from './connections/store';
import type { Logger } from './log';
import { invalidEntriesText, reopenedIds, signaturesOf } from './profile-changes';
import type { QueryEditors } from './sql/editor';
import type { CatalogTree } from './tree/model';
import { whenShown } from './tree/shown';
import type { ShownView } from './tree/shown';

interface ProfileWatchEnv {
  readonly store: ConnectionStore;
  readonly tree: CatalogTree;
  readonly editors: Pick<QueryEditors, 'profilesChanged'>;
  readonly logger: Logger;
  /** The view of aantje: the warning about the setting waits until the user has seen it, the log does not. */
  readonly view: ShownView;
  /** Runs after each setting change, once the tree and sessions know about it. */
  readonly onChanged: () => void;
}

interface ProfileWatch {
  /** Ids Edit Connection is saving; the setting change must not reopen them. */
  readonly editing: Set<string>;
  readonly disposable: vscode.Disposable;
}

// An edited path or host reopens that connection. A connection being edited is left to the edit command, which
// reopens it after the new password is stored; the setting change comes too early.
export function watchProfiles(env: ProfileWatchEnv): ProfileWatch {
  const { store, tree, logger } = env;
  const editing = new Set<string>();
  let known = signaturesOf(store.list());
  // The set of problems last logged, and the one last warned about.
  let logged = '';
  let warned = '';
  // The user has seen the view of aantje in this window; only then does it warn.
  let shown = false;

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

  /** Logs skipped setting entries once per new set, and warns once per new set when the user has seen the view. */
  function reportProblems(): void {
    const problems = store.problems();
    const text = problems.join('\n');
    if (text !== logged) {
      logged = text;
      for (const problem of problems) {
        logger.warn(`Ignored an entry of "aantje.connections": ${problem}`);
      }
    }
    if (!shown || text === warned) {
      return;
    }
    warned = text;
    const warning = invalidEntriesText(problems.length);
    if (warning) {
      void vscode.window.showWarningMessage(warning);
    }
  }

  // The log at once, also in a window that uses aantje only through its commands or its MCP server.
  reportProblems();
  return {
    editing,
    disposable: vscode.Disposable.from(
      whenShown(env.view, () => {
        shown = true;
        reportProblems();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
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
    ),
  };
}
