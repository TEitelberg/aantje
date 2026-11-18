import * as vscode from 'vscode';
import { groupedPlural, plural } from '../shell/numbers';
import type { GuardUi, UnfilteredQuestion } from './run-guards';

/** The questions of `run-guards.ts` in VS Code. */
export function guardUi(): GuardUi {
  return {
    async confirmUnfilteredWrite(question) {
      const once = 'Run Anyway';
      const always = 'Run Anyway for This Session';
      const choice = await vscode.window.showWarningMessage(
        unfilteredMessage(question),
        { modal: true, detail: unfilteredDetail(question) },
        once,
        always,
      );
      return choice === once ? 'run' : choice === always ? 'session' : 'cancel';
    },
    askCommitMessage,
  };
}

interface MessageItem extends vscode.QuickPickItem {
  /** The item of the typed text; the others are last messages. */
  readonly typed?: boolean;
}

/**
 * The commit message in a quick pick: the field starts empty and Enter on it runs without a message; a typed text is
 * the first item, the last messages of the connection follow. Escape cancels the run.
 */
function askCommitMessage(recent: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const pick = vscode.window.createQuickPick<MessageItem>();
    pick.title = 'Commit message (optional)';
    pick.placeholder =
      'The message of the snapshots of this run. Empty runs without one; Escape cancels the run.';
    pick.ignoreFocusOut = true;
    const itemsFor = (typed: string): MessageItem[] => [
      typed === ''
        ? { label: 'Run without a commit message', typed: true, alwaysShow: true }
        : { label: typed, description: 'commit message', typed: true, alwaysShow: true },
      ...recent
        .filter((message) => message !== typed)
        .map((message): MessageItem => ({ label: message, description: 'recent' })),
    ];
    pick.items = itemsFor('');
    pick.onDidChangeValue((value) => (pick.items = itemsFor(value.trim())));
    let answer: string | undefined;
    pick.onDidAccept(() => {
      const [item] = pick.selectedItems;
      answer = !item || item.typed ? pick.value.trim() : item.label;
      pick.hide();
    });
    pick.onDidHide(() => {
      pick.dispose();
      resolve(answer);
    });
    pick.show();
  });
}

function unfilteredMessage({ keyword, target, rows }: UnfilteredQuestion): string {
  const hit = rows === undefined ? 'all rows' : `all ${groupedPlural(rows, 'row')}`;
  return `${keyword} without WHERE ${keyword === 'DELETE' ? 'removes' : 'changes'} ${hit} of ${target}.`;
}

function unfilteredDetail({ ran }: UnfilteredQuestion): string {
  return [
    ran > 0 ? `${plural(ran, 'statement')} of this run ran before it.` : undefined,
    'DuckLake keeps the old snapshot: Restore Table to Snapshot... brings the rows back until the snapshot is expired.',
  ]
    .filter((line) => line !== undefined)
    .join('\n\n');
}
