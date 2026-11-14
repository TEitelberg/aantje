import * as vscode from 'vscode';
import type { Register } from '../command.vscode';
import type { ConnectionProfile } from '../connections/profile';
import type { ConnectionStore } from '../connections/store';
import { userMessageOf } from '../errors';
import type { Logger } from '../log';
import { withCancel } from '../progress.vscode';
import { scriptOf } from '../script-templates';
import { openScript } from '../script.vscode';
import type { CatalogTree } from '../tree/model';
import { holdsFileExclusively } from './editor';
import type { QueryEditors, QueryUi } from './editor';
import { queryMenuItems, queryStatusContent } from './editor-status';
import { activeSqlEditor, documentKey, documentOfKey, editorOf } from './glue.vscode';
import { scriptToRun } from './script';

interface QueryEnv {
  readonly editors: QueryEditors;
  readonly tree: CatalogTree;
  readonly store: ConnectionStore;
  readonly logger: Logger;
  readonly register: Register;
  /** Sets a window context key for `when` clauses. */
  readonly setContext: (key: string, value: boolean) => void;
  /** The results of the editors, which can be closed and shown again. */
  readonly results: {
    isCollapsed(key: string): boolean;
    collapse(key: string, collapsed: boolean): void;
  };
}

/** Opens the text in an untitled SQL document bound to the connection, so that F5 runs it there; never runs it. */
export async function openForConnection(
  editors: QueryEditors,
  text: string,
  connectionId: string,
): Promise<void> {
  await openScript(text, (document) => editors.associate(editorOf(document), connectionId));
}

export function createQueryUi(): QueryUi {
  return {
    info: (message) => void vscode.window.showInformationMessage(message),
    async pickConnection(profiles) {
      const picked = await vscode.window.showQuickPick(
        profiles.map((profile) => ({
          label: profile.name,
          description: `${profile.kind}${profile.readOnly ? ' · read-only' : ''}`,
          id: profile.id,
        })),
        {
          title: 'Select Connection for Query',
          placeHolder: 'Connection to run the SQL on',
          ignoreFocusOut: true,
        },
      );
      return picked?.id;
    },
    withProgress: withCancel,
  };
}

/** Selects a statement's range in its document; the results panel calls it on an error click. */
export function revealStatement(
  editors: QueryEditors,
  key: string,
  offset: number,
  length: number,
  logger: Logger,
): void {
  const range = editors.scriptRange(key, offset, length);
  const document = documentOfKey(key);
  if (!range || !document) return;
  vscode.window
    .showTextDocument(document, {
      viewColumn: vscode.window.visibleTextEditors.find((editor) => editor.document === document)?.viewColumn,
      selection: new vscode.Range(
        document.positionAt(range.offset),
        document.positionAt(range.offset + range.length),
      ),
    })
    .then(undefined, (error: unknown) => {
      logger.error('Showing the statement in its editor failed.', error);
    });
}

/** Shows or closes the results of the active SQL editor; without `shown` they toggle, and collapsed ones come back with the last run. */
const showResults = (results: QueryEnv['results'], shown?: boolean) => (): void => {
  const document = vscode.window.activeTextEditor?.document;
  if (document?.languageId !== 'sql') return;
  const key = documentKey(document);
  results.collapse(key, !(shown ?? results.isCollapsed(key)));
};

/** Registers the SQL editor commands, status bar item and context keys; decisions live in `editor.ts`. */
export function registerQueryEditor(env: QueryEnv): vscode.Disposable[] {
  const { editors, tree, store, logger, register, setContext, results } = env;
  const ui = createQueryUi();

  // Completion needs the explorer's catalog; skip it while a writable session holds the file.
  const connectExplorer = (key: string): void => {
    const state = editors.state(key);
    const profile: ConnectionProfile | undefined = state && store.get(state.connectionId);
    if (state && profile && !holdsFileExclusively(profile, state.mode)) {
      if (tree.state(profile.id).status === 'disconnected') void tree.connect(profile.id);
    }
  };

  const statusItem = vscode.window.createStatusBarItem(
    'aantje.queryStatus',
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusItem.name = 'aantje SQL Session';
  statusItem.command = 'aantje.queryMenu';

  const update = (): void => {
    const document = vscode.window.activeTextEditor?.document;
    const state = document?.languageId === 'sql' ? editors.state(documentKey(document)) : undefined;
    setContext('aantje.queryEditor', state !== undefined);
    setContext('aantje.queryRunning', state?.running === true);
    if (!state) {
      statusItem.hide();
      return;
    }
    const content = queryStatusContent(state);
    statusItem.text = content.text;
    statusItem.tooltip = content.tooltip;
    statusItem.show();
  };

  const associate = (document: vscode.TextDocument, connectionId: string): Promise<void> =>
    editors.associate(editorOf(document), connectionId);

  const selectConnection = async (): Promise<void> => {
    const document = activeSqlEditor()?.document;
    const id = document && (await editors.pickConnection(true));
    if (document && id) await associate(document, id);
  };

  return [
    statusItem,
    vscode.Disposable.from(
      editors.onDidChange(({ key, association }) => {
        if (association) connectExplorer(key);
        update();
      }),
    ),
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.workspace.onDidOpenTextDocument(update),
    vscode.workspace.onDidCloseTextDocument((document) => {
      editors.documentClosed(documentKey(document)).catch((error: unknown) => {
        logger.error('Closing the SQL session of a closed editor failed.', error);
        void vscode.window.showErrorMessage(userMessageOf(error));
      });
    }),

    register('aantje.newQuery', async (node) => {
      const connectionId = node?.ref.connectionId ?? (await editors.pickConnection());
      if (!connectionId) return;
      // A table or view opens with its SELECT; a connection or schema opens empty.
      const starts = node?.ref.kind === 'table' || node?.ref.kind === 'view';
      await openForConnection(
        editors,
        (starts ? await scriptOf('select', tree, node.ref) : undefined) ?? '',
        connectionId,
      );
    }),

    register('aantje.selectQueryConnection', selectConnection),

    register('aantje.runQuery', async () => {
      const editor = activeSqlEditor();
      if (!editor) return;
      const { document, selection } = editor;
      const script = scriptToRun(document.getText(), {
        start: document.offsetAt(selection.start),
        end: document.offsetAt(selection.end),
      });
      await editors.run(editorOf(document), { ...script, record: true });
    }),

    // aantje.runStatement is in lens.vscode.ts: the lens calls it with a statement.

    register('aantje.cancelQuery', () => {
      const document = vscode.window.activeTextEditor?.document;
      if (document) editors.cancel(documentKey(document));
    }),

    register('aantje.toggleResults', showResults(results)),
    register('aantje.hideResults', showResults(results, false)),
    register('aantje.showResults', showResults(results, true)),

    register('aantje.toggleReadOnly', async () => {
      const document = activeSqlEditor()?.document;
      if (!document) return;
      if (!editors.connectionOf(documentKey(document))) {
        ui.info('This editor has no connection yet. Select one first.');
        return;
      }
      await editors.toggleMode(documentKey(document));
      connectExplorer(documentKey(document));
    }),

    register('aantje.queryMenu', async () => {
      const document = activeSqlEditor()?.document;
      const state = document && editors.state(documentKey(document));
      if (!document || !state) {
        await selectConnection();
        return;
      }
      const choice = await vscode.window.showQuickPick(
        queryMenuItems(state).map((item) => ({ ...item })),
        { title: `SQL session of ${state.connectionName}`, ignoreFocusOut: true },
      );
      const key = documentKey(document);
      if (choice?.action === 'select') await selectConnection();
      else if (choice?.action === 'toggle') await vscode.commands.executeCommand('aantje.toggleReadOnly');
      else if (choice?.action === 'cancel') editors.cancel(key);
      else if (choice?.action === 'close') await editors.closeSessionOf(key);
    }),
  ];
}
