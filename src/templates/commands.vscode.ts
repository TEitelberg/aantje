import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { guarded } from '../command.vscode';
import type { Register } from '../command.vscode';
import type { Logger } from '../log';
import { visibleLine } from '../markdown';
import { createPanel } from '../shell/host.vscode';
import { ReportPanels } from '../shell/panels';
import type { PanelFactory } from '../shell/panels';
import type { QueryEditors } from '../sql/editor';
import { openForConnection } from '../sql/editor.vscode';
import { activeSqlEditor, documentKey, documentOfKey } from '../sql/glue.vscode';
import { initialValues, ParameterMemory } from '../sql/parameters';
import { askParameterValues } from '../sql/parameters.vscode';
import type { SqlToken } from '../sql/tokens';
import { BUILTIN_TEMPLATES, EXAMPLE_TEMPLATE } from './builtin';
import { TEMPLATE_SCHEME, TemplateDocuments } from './documents.vscode';
import { exportedText, fileNameOf, IMPORT_EXTENSIONS, importedTexts, tooLarge } from './files';
import { duplicatedTemplate, filledTemplate, selectionTemplate, useParameters } from './fill';
import { templatesKind } from './kind';
import type { TemplatesPageData } from './kind';
import { checkTemplate, problemText, tagsOf } from './model';
import type { Template, TemplateFields } from './model';
import type { TemplateAction } from './protocol';
import { isEditable } from './search';
import type { TemplateCard, TemplateSource } from './search';
import { readFolderTemplates, TemplateStore } from './store';
import type { TemplateUse } from './store';

const OPEN = 'aantje.openTemplates';
const SAVE_SELECTION = 'aantje.saveSelectionAsTemplate';
const FOLDERS = 'aantje.templates.folders';
const KEY = 'templates';
const TITLE = 'Templates';

type Tokenize = (text: string) => Promise<readonly SqlToken[]>;

interface TemplatesEnv {
  readonly context: Pick<vscode.ExtensionContext, 'globalState' | 'extensionUri'>;
  readonly editors: QueryEditors;
  readonly service: { tokenize: Tokenize };
  readonly logger: Logger;
  readonly register: Register;
}

/** What the actions share. */
interface Parts {
  readonly store: TemplateStore;
  readonly documents: TemplateDocuments;
  /** The last values of the dialog per template, while the window is open. */
  readonly memory: ParameterMemory;
  readonly editors: QueryEditors;
  readonly tokenize: Tokenize;
  readonly logger: Logger;
  /** The document of the text editor that had the focus last; the page takes the focus from it. */
  lastEditor(): string | undefined;
}

const encoder = new TextEncoder();

/** The folders of `aantje.templates.folders`, as far as they are text. */
function templateFolders(): string[] {
  const value = vscode.workspace.getConfiguration('aantje').get<unknown>('templates.folders');
  return Array.isArray(value)
    ? value.filter((folder): folder is string => typeof folder === 'string' && folder.trim() !== '')
    : [];
}

/** A time for the page: whole milliseconds since 1970, or null for none or one that the page does not take. */
const pageTime = (time: number | undefined): number | null =>
  time !== undefined && Number.isSafeInteger(time) && time >= 0 ? time : null;

const cardOf = (template: Template, use: TemplateUse | undefined): TemplateCard => ({
  id: template.id,
  name: template.name,
  description: template.description,
  tags: template.tags,
  source: template.source,
  text: template.text,
  uses: use?.count ?? 0,
  lastUsed: pageTime(use?.last),
  created: pageTime(template.created),
  ...(template.file === undefined ? {} : { file: template.file }),
});

/** Why aantje refuses a text as a template, or undefined when it keeps it. */
async function problemOf(text: string, tokenize: Tokenize): Promise<string | undefined> {
  const { problems } = checkTemplate(text, await tokenize(text));
  return problems.length === 0 ? undefined : problemText(problems);
}

/** Where a save dialog starts: the first folder of the workspace, else the home folder. */
function startUri(name: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
  return vscode.Uri.joinPath(folder, name);
}

/**
 * Use: asks for a connection when the editor that had the focus last has none, then for the values of the `{{name}}`
 * placeholders, and opens the filled-in text in a new SQL document of the connection. Nothing runs.
 */
async function useTemplate(parts: Parts, template: Template): Promise<void> {
  const { editors, memory, tokenize, store } = parts;
  const last = parts.lastEditor();
  const bound = last !== undefined && documentOfKey(last) ? editors.connectionOf(last) : undefined;
  const connectionId = bound ?? (await editors.pickConnection());
  if (connectionId === undefined) return;
  const tokens = await tokenize(template.text);
  const parameters = useParameters(template.text, tokens);
  const answers = await askParameterValues(
    parameters,
    initialValues(parameters, memory.get(template.id)),
    `Template: ${template.name}`,
  );
  if (!answers) return;
  memory.remember(template.id, answers);
  const filled = filledTemplate(template, tokens, answers);
  if ('problem' in filled) {
    void vscode.window.showInformationMessage(filled.problem);
    return;
  }
  await openForConnection(editors, filled.text, connectionId);
  await store.used(template.id);
}

/** Duplicate: keeps a copy of the template as one of the user's own, with the day of the copy as `created`, and opens it. */
async function duplicateTemplate({ store, documents }: Parts, template: Template): Promise<void> {
  const added = await store.add('mine', duplicatedTemplate(template.text, Date.now()));
  if ('problem' in added) void vscode.window.showInformationMessage(added.problem);
  else await documents.open(added.id, template.name);
}

async function exportTemplate(template: Template): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    title: `Export Template "${template.name}"`,
    defaultUri: startUri(fileNameOf(template.name)),
    filters: { 'SQL template': ['sql'] },
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, encoder.encode(exportedText(template.text)));
  void vscode.window.showInformationMessage(`Exported the template "${template.name}" to ${target.fsPath}.`);
}

async function deleteTemplate({ store, documents, memory }: Parts, template: Template): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `Delete the template "${template.name}"?`,
    { modal: true, detail: 'This cannot be undone. Export it first to keep a copy.' },
    'Delete',
  );
  if (choice !== 'Delete') return;
  await store.remove(template.id);
  documents.forget(template.id);
  memory.forget(template.id);
}

/** Import...: reads the chosen `.sql` files and `.json` bundles as text and keeps the templates that aantje accepts. */
async function importFiles({ store, tokenize, logger }: Parts): Promise<void> {
  const files = await vscode.window.showOpenDialog({
    title: 'Import Templates',
    openLabel: 'Import',
    canSelectMany: true,
    filters: { 'Templates (.sql, or a .json bundle)': [...IMPORT_EXTENSIONS] },
  });
  const imported: string[] = [];
  const refused: string[] = [];
  for (const file of files ?? []) {
    const name = file.path.split('/').pop() ?? file.path;
    if (tooLarge(name, (await vscode.workspace.fs.stat(file)).size)) {
      refused.push(`${name} is too large for a template file.`);
      continue;
    }
    const read = importedTexts(name, new TextDecoder().decode(await vscode.workspace.fs.readFile(file)));
    if ('problem' in read) {
      refused.push(read.problem);
      continue;
    }
    for (const { from, text } of read.texts) {
      const check = checkTemplate(text, await tokenize(text));
      const added =
        check.problems.length > 0
          ? { problem: problemText(check.problems) }
          : await store.addImported(text, check.fields.name);
      if ('problem' in added) refused.push(`${from}: ${added.problem}`);
      else imported.push(check.fields.name);
    }
  }
  if (imported.length > 0) {
    const names = imported.slice(0, 5).map((name) => `"${name}"`);
    const more = imported.length > names.length ? ` and ${imported.length - names.length} more` : '';
    void vscode.window.showInformationMessage(
      `Imported ${imported.length === 1 ? 'the template' : `${imported.length} templates:`} ${names.join(', ')}${more}. Search for them on the page.`,
    );
  }
  if (refused.length > 0) {
    for (const reason of refused) logger.warn(`A template was not imported: ${reason}`);
    void vscode.window.showWarningMessage(
      `${refused.length === 1 ? 'A template was' : `${refused.length} templates were`} not imported: ${refused[0]}${
        refused.length > 1 ? ' The others are in the output channel aantje.' : ''
      }`,
    );
  }
}

/** Download example: saves the example template where the user chooses and opens it. */
async function saveExample(): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    title: 'Download Example Template',
    defaultUri: startUri('aantje-template-example.sql'),
    filters: { 'SQL template': ['sql'] },
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, encoder.encode(EXAMPLE_TEMPLATE));
  await vscode.window.showTextDocument(target);
}

/** The name, description and tags of Save Selection as Template, in three steps; undefined when one is cancelled. */
async function askFields(): Promise<TemplateFields | undefined> {
  const title = 'Save Selection as Template';
  const name = await vscode.window.showInputBox({
    title: `${title} (1/3)`,
    prompt: 'The name of the template',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() === '' ? 'Give the template a name.' : undefined),
  });
  if (name === undefined) return undefined;
  const description = await vscode.window.showInputBox({
    title: `${title} (2/3)`,
    prompt: 'What the template does, in one line (optional)',
    ignoreFocusOut: true,
  });
  if (description === undefined) return undefined;
  const tags = await vscode.window.showInputBox({
    title: `${title} (3/3)`,
    prompt: 'Words to find the template by, separated by commas (optional)',
    ignoreFocusOut: true,
  });
  if (tags === undefined) return undefined;
  return { name: visibleLine(name).trim(), description: visibleLine(description).trim(), tags: tagsOf(tags) };
}

/**
 * Save Selection as Template...: the selection (the whole document without one) with the parameter lines of the
 * document that it uses and the day of the save as `created`, kept as one of the user's own templates after the checks
 * of a save.
 */
async function saveSelection(parts: Parts, openPage: () => Promise<void>): Promise<void> {
  const { store, documents, tokenize, logger } = parts;
  const editor = activeSqlEditor();
  if (!editor) return;
  const { document, selection } = editor;
  const selected = selection.isEmpty ? document.getText() : document.getText(selection);
  if (selected.trim() === '') {
    void vscode.window.showInformationMessage('There is no SQL to save as a template.');
    return;
  }
  const fields = await askFields();
  if (!fields) return;
  const text = selectionTemplate(
    { ...fields, created: Date.now() },
    selected,
    document.getText(),
    await tokenize(selected),
  );
  const problem = await problemOf(text, tokenize);
  const added = problem === undefined ? await store.add('mine', text) : { problem };
  if ('problem' in added) {
    void vscode.window.showWarningMessage(`The template was not saved: ${added.problem}`);
    return;
  }
  void vscode.window
    .showInformationMessage(`Saved the template "${fields.name}".`, 'Open Templates', 'Edit')
    .then((choice) =>
      choice === 'Open Templates'
        ? openPage()
        : choice === 'Edit'
          ? documents.open(added.id, fields.name)
          : undefined,
    )
    .then(undefined, (error: unknown) => logger.error('Showing the saved template failed.', error));
}

/** The panel of the page, whose page loads the logo of aantje from `media`. */
function templatesPanels(
  extensionUri: vscode.Uri,
  onAction: (action: TemplateAction, data: TemplatesPageData) => void,
  onClose: () => void,
) {
  let logo = '';
  const factory: PanelFactory = (kind, title) => {
    const panel = createPanel(extensionUri, {
      viewType: kind.viewType,
      title,
      script: 'report-client.js',
      column: vscode.ViewColumn.Active,
      css: kind.css,
      media: true,
    });
    logo = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'logo.png')).toString();
    return {
      setTitle: (next) => void (panel.title = next),
      reveal: () => panel.reveal(),
      post: (message) => void panel.webview.postMessage(message),
      dispose: () => void panel.dispose(),
      onMessage: (listener) => void panel.webview.onDidReceiveMessage(listener),
      onDispose: (listener) => void panel.onDidDispose(listener),
    };
  };
  const kind = templatesKind(() => logo);
  const panels = new ReportPanels(factory, kind, { onAction, onClose, openMarkdown: () => undefined });
  return { kind, panels };
}

/**
 * The Templates page (one panel; a second call brings it forward), its actions, the editors of own templates and Save
 * Selection as Template.
 */
export function registerTemplates(env: TemplatesEnv): vscode.Disposable[] {
  const { context, editors, service, logger, register } = env;
  const tokenize: Tokenize = (text) => service.tokenize(text);
  const store = new TemplateStore(context.globalState);
  const documents = new TemplateDocuments(store, (text) => problemOf(text, tokenize));
  const active = vscode.window.activeTextEditor;
  let lastEditor = active && documentKey(active.document);
  const parts: Parts = {
    store,
    documents,
    memory: new ParameterMemory(),
    editors,
    tokenize,
    logger,
    lastEditor: () => lastEditor,
  };

  async function templateOf(id: string, source: TemplateSource): Promise<Template | undefined> {
    const candidates =
      source === 'builtin'
        ? BUILTIN_TEMPLATES
        : source === 'folder'
          ? (await readFolderTemplates(templateFolders(), tokenize)).templates
          : store.templates();
    return candidates.find((template) => template.id === id);
  }

  async function pageData(): Promise<TemplatesPageData> {
    const folders = await readFolderTemplates(templateFolders(), tokenize);
    const uses = store.uses();
    const templates = [...BUILTIN_TEMPLATES, ...store.templates(), ...folders.templates];
    return {
      templates: templates.map((template) => cardOf(template, uses.get(template.id))),
      notes: folders.notes,
    };
  }

  // The page names only templates it was sent, and only actions their source has: an own or imported template is
  // edited, exported and deleted, the others duplicated.
  async function perform(action: TemplateAction, data: TemplatesPageData): Promise<void> {
    if (action.action === 'import') return importFiles(parts);
    if (action.action === 'example') return saveExample();
    const sent = data.templates.find((card) => card.id === action.id);
    const onlyOwn = action.action === 'edit' || action.action === 'export' || action.action === 'delete';
    if (!sent || (onlyOwn && !isEditable(sent.source))) {
      logger.warn('The Templates page asked for an action that its data does not offer; it was ignored.');
      return undefined;
    }
    const template = await templateOf(sent.id, sent.source);
    if (!template) {
      void vscode.window.showInformationMessage(`The template "${sent.name}" is gone.`);
      return refresh(false);
    }
    if (action.action === 'use') return useTemplate(parts, template);
    if (action.action === 'copy') return duplicateTemplate(parts, template);
    if (action.action === 'edit') return documents.open(template.id, template.name);
    if (action.action === 'export') return exportTemplate(template);
    return deleteTemplate(parts, template);
  }

  let open = false;
  const { kind, panels } = templatesPanels(
    context.extensionUri,
    (action, data) => void guarded(logger, OPEN, () => perform(action, data)),
    () => {
      open = false;
    },
  );

  // Reads the templates again for the page; `reveal` opens it or brings it forward, else only an open page changes.
  // The newest read wins; an open that a newer read overtook is done by that read.
  let reading = 0;
  let revealing = false;
  async function refresh(reveal: boolean): Promise<void> {
    if (!reveal && !open) return;
    revealing ||= reveal;
    const mine = ++reading;
    const data = await pageData().catch((error: unknown) => {
      if (mine === reading) revealing = false;
      throw error;
    });
    if (mine !== reading) return;
    if (revealing) {
      revealing = false;
      panels.show(KEY, TITLE, data);
      open = true;
    } else if (open) {
      panels.update(KEY, data, kind.message(data));
    }
  }
  const refreshQuietly = (): void =>
    void refresh(false).catch((error: unknown) => logger.error('Reading the templates again failed.', error));

  const changed = store.onDidChange(refreshQuietly);
  return [
    { dispose: () => changed.dispose() },
    { dispose: () => panels.dispose() },
    documents,
    vscode.workspace.registerFileSystemProvider(TEMPLATE_SCHEME, documents, { isCaseSensitive: true }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) lastEditor = documentKey(editor.document);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(FOLDERS)) refreshQuietly();
    }),
    register(OPEN, () => refresh(true)),
    register(SAVE_SELECTION, () => saveSelection(parts, () => refresh(true))),
  ];
}
