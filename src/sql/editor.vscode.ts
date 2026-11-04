import * as vscode from 'vscode';
import type { Register } from '../command.vscode';
import type { ConnectionProfile } from '../connections/profile';
import type { ConnectionStore } from '../connections/store';
import { userMessageOf } from '../errors';
import type { Logger } from '../log';
import { maintenanceScript } from '../maintenance';
import type { MaintenanceKind } from '../maintenance';
import { withCancel } from '../progress.vscode';
import { scriptOf } from '../script-templates';
import type { ScriptVerb } from '../script-templates';
import { openScript } from '../script.vscode';
import type { CatalogTree } from '../tree/model';
import type { NodeRef } from '../tree/refs';
import { holdsFileExclusively, queryMenuItems, queryStatusContent, scriptToRun, statementAt } from './editor';
import type { EditorRef, QueryEditors, QueryUi } from './editor';
import type { LanguageService } from './language';

interface QueryEnv {
  readonly editors: QueryEditors;
  readonly tree: CatalogTree;
  readonly store: ConnectionStore;
  readonly service: LanguageService;
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

const maintenance: readonly (readonly [string, MaintenanceKind])[] = [
  ['aantje.maintenanceCheckpoint', 'checkpoint'],
  ['aantje.maintenanceMerge', 'merge'],
  ['aantje.maintenanceRewrite', 'rewrite'],
  ['aantje.maintenanceFlush', 'flush'],
  ['aantje.maintenanceExpire', 'expire'],
  ['aantje.maintenanceCleanup', 'cleanup'],
  ['aantje.maintenanceOrphans', 'orphans'],
  ['aantje.maintenanceOption', 'option'],
];

// Script as and Maintenance commands; the generator gives undefined for a node without such a script.
const scripts: readonly (readonly [
  string,
  (tree: CatalogTree, ref: NodeRef) => Promise<string | undefined> | string | undefined,
])[] = [
  ...(
    [
      ['aantje.scriptCreate', 'create'],
      ['aantje.scriptSelect', 'select'],
      ['aantje.scriptInsert', 'insert'],
      ['aantje.scriptAlter', 'alter'],
      ['aantje.scriptDrop', 'drop'],
    ] as const satisfies readonly (readonly [string, ScriptVerb])[]
  ).map(([id, verb]) => [id, (tree: CatalogTree, ref: NodeRef) => scriptOf(verb, tree, ref)] as const),
  ...maintenance.map(
    ([id, kind]) => [id, (tree: CatalogTree, ref: NodeRef) => maintenanceScript(tree, kind, ref)] as const,
  ),
];

export const documentKey = (document: vscode.TextDocument): string => document.uri.toString();

const editorOf = (document: vscode.TextDocument): EditorRef => ({
  key: documentKey(document),
  name: document.uri.path.split('/').pop() ?? document.uri.path,
});

const documentOfKey = (key: string): vscode.TextDocument | undefined =>
  vscode.workspace.textDocuments.find((document) => documentKey(document) === key);

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
  const { editors, tree, store, service, logger, register, setContext, results } = env;
  const ui = createQueryUi();

  const activeSql = (): vscode.TextEditor | undefined => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId === 'sql') return editor;
    ui.info('Open a SQL editor first.');
    return undefined;
  };

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
    const document = activeSql()?.document;
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

    // A script is bound to its node's connection, so F5 runs it there; opening never runs it.
    ...scripts.map(([id, scriptFor]) =>
      register(id, async (node) => {
        const text = node && (await scriptFor(tree, node.ref));
        if (node && text !== undefined) {
          await openForConnection(editors, text, node.ref.connectionId);
        }
      }),
    ),

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
      const editor = activeSql();
      if (!editor) return;
      const { document, selection } = editor;
      const script = scriptToRun(document.getText(), {
        start: document.offsetAt(selection.start),
        end: document.offsetAt(selection.end),
      });
      await editors.run(editorOf(document), script);
    }),

    register('aantje.runStatement', async () => {
      const editor = activeSql();
      if (!editor) return;
      const { document, selection } = editor;
      const text = document.getText();
      const statement = statementAt(text, await service.tokenize(text), document.offsetAt(selection.active));
      if (!statement) {
        ui.info('There is no statement at the cursor.');
        return;
      }
      await editors.run(editorOf(document), statement);
    }),

    register('aantje.cancelQuery', () => {
      const document = vscode.window.activeTextEditor?.document;
      if (document) editors.cancel(documentKey(document));
    }),

    register('aantje.toggleResults', showResults(results)),
    register('aantje.hideResults', showResults(results, false)),
    register('aantje.showResults', showResults(results, true)),

    register('aantje.toggleReadOnly', async () => {
      const document = activeSql()?.document;
      if (!document) return;
      if (!editors.connectionOf(documentKey(document))) {
        ui.info('This editor has no connection yet. Select one first.');
        return;
      }
      await editors.toggleMode(documentKey(document));
      connectExplorer(documentKey(document));
    }),

    register('aantje.queryMenu', async () => {
      const document = activeSql()?.document;
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
