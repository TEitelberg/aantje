import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { registerGuarded } from '../command.vscode';
import { messageOf, userMessageOf } from '../errors';
import { isCount, isObject, own } from '../guards';
import type { ColumnSummary, SummaryState } from './column-summary';
import { createPanel } from '../shell/host.vscode';
import { requestLimit } from '../shell/panels';
import { markdownNull } from '../export/save.vscode';
import { safeFileName } from './model';
import { isOversizedTransfer, isWebviewMessage, MAX_TRANSFER_CHARS } from './protocol';
import { GRID_CSS } from './style';
import type {
  CopyScope,
  ExtensionMessage,
  MenuCopy,
  PageSettings,
  RowsFormat,
  SaveFormat,
  WebviewMessage,
} from './protocol';
import type { GridData } from '../data/types';
import type { Logger } from '../log';

/**
 * The pages of the grids that the commands of the context menu of a grid reach: each panel by an id that its page
 * names in the context of the menu (`data-vscode-context`), so that a command comes back to the page it was chosen in.
 */
export class GridPages {
  private readonly pages = new Map<string, (message: ExtensionMessage) => void>();

  /** Notes the page of a panel; its id goes to the page with the settings. */
  add(send: (message: ExtensionMessage) => void): string {
    const id = randomUUID();
    this.pages.set(id, send);
    return id;
  }

  remove(id: string): void {
    this.pages.delete(id);
  }

  /**
   * Asks the page of the context menu to copy: the page knows the selected cell, the sort and the filters, and posts
   * the copy as from its own controls. `context` is what VS Code gives the command; false when it names no open page.
   */
  copy(context: unknown, what: MenuCopy): boolean {
    if (!isObject(context)) return false;
    const panel = own(context, 'aantjePanel');
    const set = own(context, 'aantjeSet');
    const send = typeof panel === 'string' ? this.pages.get(panel) : undefined;
    if (!send || !(set === undefined || isCount(set))) return false;
    send({ type: 'menuCopy', what, ...(set === undefined ? {} : { set: set as number }) });
    return true;
  }
}

/** The commands of the context menu of a grid and what they copy. */
const MENU_COMMANDS: readonly (readonly [string, MenuCopy])[] = [
  ['aantje.copyCell', 'cell'],
  ['aantje.copyRow', 'row'],
  ['aantje.copyAll', 'all'],
  ['aantje.copyAsMarkdown', 'markdown'],
  ['aantje.copyColumnStatistics', 'statistics'],
];

/** The commands of the context menu of the grids (`webview/context` in package.json). */
export function registerGridCommands(logger: Logger, pages: GridPages): vscode.Disposable[] {
  return MENU_COMMANDS.map(([id, what]) =>
    registerGuarded(logger, id, (context) => void pages.copy(context, what)),
  );
}

export interface GridDeps {
  /** Where a refused message of a page and a failed copy or save are noted. */
  readonly log?: Pick<Logger, 'warn' | 'error'>;
  readonly clipboard: { writeText(text: string): Thenable<void> };
  /**
   * Asks the user where to save and writes the file: text in UTF-8, a picture as its bytes. Resolves when the user
   * cancelled or the file is written.
   */
  readonly saveFile: (
    suggestedName: string,
    content: string | Uint8Array,
    format: SaveFormat,
  ) => Promise<void>;
  /** The settings that the pages read when they load. */
  readonly settings?: () => PageSettings;
  /** Remembers whether the statistics of the columns are shown, for the grids that open later. */
  readonly rememberStatistics?: (shown: boolean) => void;
  /** The pages that the context menu of a grid reaches. */
  readonly pages?: GridPages;
}

/** Where the state of the statistics of the columns is kept: the global state of VS Code. */
const STATISTICS_KEY = 'aantje.grid.columnStatistics';

const SAVE_FILTERS: Readonly<Record<SaveFormat, readonly [string, string]>> = {
  csv: ['CSV', 'csv'],
  json: ['JSON', 'json'],
  markdown: ['Markdown', 'md'],
  png: ['PNG', 'png'],
};

export function createGridDeps(
  log?: Pick<Logger, 'warn' | 'error'>,
  state?: Pick<vscode.Memento, 'get' | 'update'>,
): GridDeps & { readonly pages: GridPages } {
  return {
    ...(log ? { log } : {}),
    clipboard: vscode.env.clipboard,
    saveFile: async (suggestedName, content, format) => {
      // The name comes from the webview: whatever it holds, the dialog only gets a plain file name.
      const [label, extension] = SAVE_FILTERS[format];
      const name = safeFileName(suggestedName, extension);
      const folder = vscode.workspace.workspaceFolders?.[0];
      const defaultUri = folder
        ? vscode.Uri.joinPath(folder.uri, name)
        : vscode.Uri.file(join(homedir(), name));
      const uri = await vscode.window.showSaveDialog({ defaultUri, filters: { [label]: [extension] } });
      if (uri) {
        const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
        await vscode.workspace.fs.writeFile(uri, bytes);
        void vscode.window.showInformationMessage(`Saved ${uri.fsPath}`);
      }
    },
    settings: () => ({
      markdownNull: markdownNull(),
      statistics: state?.get<boolean>(STATISTICS_KEY) === true,
    }),
    rememberStatistics: (shown) => void state?.update(STATISTICS_KEY, shown),
    pages: new GridPages(),
  };
}

/** The formats of Export as File, as the pick offers them. */
const EXPORT_PICKS: readonly (vscode.QuickPickItem & { readonly format: RowsFormat })[] = [
  { label: 'CSV', description: '.csv', detail: 'Comma-separated values with a header row', format: 'csv' },
  { label: 'JSON', description: '.json', detail: 'An array of objects, one for each row', format: 'json' },
  { label: 'Markdown', description: '.md', detail: 'A table with a header row', format: 'markdown' },
];

/**
 * Export as File of a grid: the formats in a pick, as the Command Palette shows commands; the page then sends the rows
 * shown in the format chosen, which the save dialog writes (`transfer`). `send` reaches the page; `set` names the grid.
 */
export async function chooseExport(
  send: (message: ExtensionMessage) => void,
  set: number | undefined,
): Promise<void> {
  const picked = await vscode.window.showQuickPick(EXPORT_PICKS, {
    title: 'Export as File',
    placeHolder: 'The format of the file with the rows shown',
  });
  if (picked) send({ type: 'exportAs', format: picked.format, ...(set === undefined ? {} : { set }) });
}

interface Entry {
  readonly panel: vscode.WebviewPanel;
  /** The id that the context menu of the page names. */
  readonly id: string | undefined;
  data: GridData;
  ready: boolean;
  /** Computes the statistics of the columns of a table preview; other grids have none. */
  summarize?: (signal: AbortSignal) => Promise<ColumnSummary>;
  computing?: AbortController;
}

/** One webview panel per key; showing the same key again updates and reveals the panel. */
export class GridPanels {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: GridDeps,
  ) {}

  /** `summarize`: the statistics of the columns of a table preview, which its header asks for. */
  show(
    key: string,
    title: string,
    data: GridData,
    summarize?: (signal: AbortSignal) => Promise<ColumnSummary>,
  ): void {
    const existing = this.entries.get(key);
    if (existing) {
      existing.panel.title = title;
      existing.panel.reveal();
      existing.data = data;
      existing.summarize = summarize;
      existing.computing?.abort();
      post(existing);
      return;
    }
    const panel = createPanel(this.extensionUri, {
      viewType: 'aantje.grid',
      title,
      script: 'grid-client.js',
      column: vscode.ViewColumn.Active,
      css: GRID_CSS,
    });
    const id = this.deps.pages?.add((message) => void panel.webview.postMessage(message));
    const entry: Entry = { panel, id, data, ready: false, ...(summarize ? { summarize } : {}) };
    this.entries.set(key, entry);
    receiveFrom(panel, this.deps, (message) => void this.handle(entry, message));
    panel.onDidDispose(() => {
      this.entries.delete(key);
      if (id !== undefined) this.deps.pages?.remove(id);
    });
  }

  dispose(): void {
    for (const { panel } of [...this.entries.values()]) {
      panel.dispose();
    }
  }

  /** The statistics of the columns of the table of a preview, with their own Cancel; one at a time. */
  private async summarize(entry: Entry): Promise<void> {
    const { summarize } = entry;
    const answer = (state: SummaryState): void => {
      const message: ExtensionMessage = { type: 'summary', state };
      void entry.panel.webview.postMessage(message);
    };
    if (!summarize) {
      answer({ status: 'failed', message: 'This grid has no statistics of its columns.' });
      return;
    }
    entry.computing?.abort();
    const control = new AbortController();
    entry.computing = control;
    answer({ status: 'running' });
    try {
      const summary = await summarize(control.signal);
      if (entry.computing === control) answer({ status: 'done', summary });
    } catch (error) {
      if (entry.computing === control) answer({ status: 'failed', message: userMessageOf(error) });
    } finally {
      if (entry.computing === control) entry.computing = undefined;
    }
  }

  private async handle(entry: Entry, message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        entry.ready = true;
        postSettings(entry.panel, this.deps, entry.id === undefined ? {} : { panel: entry.id });
        post(entry);
        break;
      case 'copy':
      case 'export':
        await transfer(this.deps, message);
        break;
      case 'chooseExport':
        await chooseExport((answer) => void entry.panel.webview.postMessage(answer), message.set);
        break;
      case 'summarize':
        await this.summarize(entry);
        break;
      case 'cancelCompute':
        entry.computing?.abort();
        break;
      case 'statistics':
        this.deps.rememberStatistics?.(message.shown);
        break;
      case 'reveal':
      case 'openQuery':
      case 'openTipScript':
      case 'chart':
      case 'aggregate':
        // Only the results panel has statements to go to, to open or to run again.
        break;
    }
  }
}

/**
 * Passes the valid messages of a page on; a copy or export over the size limit is refused and noted once per panel.
 * Each copy, export or Export as File opens the clipboard, a save dialog or a pick: a few per second at most.
 */
export function receiveFrom(
  panel: vscode.WebviewPanel,
  deps: GridDeps,
  handle: (message: WebviewMessage) => void,
): void {
  let noted = false;
  let flooded = false;
  // As for the report pages, a few per second.
  const overLimit = requestLimit();
  panel.webview.onDidReceiveMessage((message: unknown) => {
    if (isWebviewMessage(message)) {
      const limited = message.type === 'copy' || message.type === 'export' || message.type === 'chooseExport';
      if (limited && overLimit()) {
        if (!flooded) {
          flooded = true;
          deps.log?.warn(
            'A panel sent more copy or export requests than a person can; the extra ones are ignored.',
          );
        }
        return;
      }
      handle(message);
    } else if (!noted && isOversizedTransfer(message)) {
      noted = true;
      deps.log?.warn(
        `A panel asked to copy or save more than ${MAX_TRANSFER_CHARS.toLocaleString('en-US')} characters, which is refused.`,
      );
    }
  });
}

/** The settings a page reads, before anything else it is sent; `extra` adds what the panel keeps for its page. */
export function postSettings(
  panel: vscode.WebviewPanel,
  deps: GridDeps,
  extra: Partial<PageSettings> = {},
): void {
  const settings = deps.settings?.();
  if (settings) {
    const message: ExtensionMessage = { type: 'settings', settings: { ...settings, ...extra } };
    void panel.webview.postMessage(message);
  }
}

const COPIED: Readonly<Record<CopyScope, string>> = {
  all: 'all rows',
  markdown: 'the rows as Markdown',
  statistics: 'the statistics of the columns',
  text: 'the output',
  cell: 'cell',
  row: 'row',
};

/** The clipboard and the files of a grid and a chart, for the data grid and the results panel alike. */
export async function transfer(
  deps: GridDeps,
  message: Extract<WebviewMessage, { type: 'copy' | 'export' }>,
): Promise<void> {
  if (message.type === 'copy') {
    try {
      await deps.clipboard.writeText(message.text);
      vscode.window.setStatusBarMessage(`Copied ${COPIED[message.what]}`, 2000);
    } catch (error) {
      deps.log?.error('Copying to the clipboard failed.', error);
      void vscode.window.showErrorMessage(`Could not copy to the clipboard: ${messageOf(error)}`);
    }
  } else {
    try {
      const content = message.format === 'png' ? Buffer.from(message.text, 'base64') : message.text;
      await deps.saveFile(message.suggestedName, content, message.format);
    } catch (error) {
      deps.log?.error('Saving the file failed.', error);
      void vscode.window.showErrorMessage(`Could not save the file: ${messageOf(error)}`);
    }
  }
}

function post(entry: Entry): void {
  if (entry.ready) {
    const message: ExtensionMessage = {
      type: 'data',
      data: entry.data,
      ...(entry.summarize ? { summary: true } : {}),
    };
    void entry.panel.webview.postMessage(message);
  }
}
