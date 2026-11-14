import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { messageOf } from '../errors';
import { createPanel } from '../shell/host.vscode';
import { requestLimit } from '../shell/panels';
import { safeCsvFileName } from './model';
import { isOversizedTransfer, isWebviewMessage, MAX_TRANSFER_CHARS } from './protocol';
import { GRID_CSS } from './style';
import type { ExtensionMessage, WebviewMessage } from './protocol';
import type { GridData } from '../data/types';
import type { Logger } from '../log';

export interface GridDeps {
  /** Where a refused message of a page and a failed copy or save are noted. */
  readonly log?: Pick<Logger, 'warn' | 'error'>;
  readonly clipboard: { writeText(text: string): Thenable<void> };
  /** Asks the user where to save and writes the file; resolves when the user cancelled or the file is written. */
  readonly saveFile: (suggestedName: string, content: string) => Promise<void>;
}

export function createGridDeps(log?: Pick<Logger, 'warn' | 'error'>): GridDeps {
  return {
    ...(log ? { log } : {}),
    clipboard: vscode.env.clipboard,
    saveFile: async (suggestedName, content) => {
      // The name comes from the webview: whatever it holds, the dialog only gets a plain file name.
      const name = safeCsvFileName(suggestedName);
      const folder = vscode.workspace.workspaceFolders?.[0];
      const defaultUri = folder
        ? vscode.Uri.joinPath(folder.uri, name)
        : vscode.Uri.file(join(homedir(), name));
      const uri = await vscode.window.showSaveDialog({ defaultUri, filters: { CSV: ['csv'] } });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
        void vscode.window.showInformationMessage(`Saved ${uri.fsPath}`);
      }
    },
  };
}

interface Entry {
  readonly panel: vscode.WebviewPanel;
  data: GridData;
  ready: boolean;
}

/** One webview panel per key; showing the same key again updates and reveals the panel. */
export class GridPanels {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: GridDeps,
  ) {}

  show(key: string, title: string, data: GridData): void {
    const existing = this.entries.get(key);
    if (existing) {
      existing.panel.title = title;
      existing.panel.reveal();
      existing.data = data;
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
    const entry: Entry = { panel, data, ready: false };
    this.entries.set(key, entry);
    receiveFrom(panel, this.deps, (message) => void this.handle(entry, message));
    panel.onDidDispose(() => this.entries.delete(key));
  }

  dispose(): void {
    for (const { panel } of [...this.entries.values()]) {
      panel.dispose();
    }
  }

  private async handle(entry: Entry, message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        entry.ready = true;
        post(entry);
        break;
      case 'copy':
      case 'export':
        await transfer(this.deps, message);
        break;
      case 'reveal':
      case 'openQuery':
        // Only the results panel has statements to go to or to open.
        break;
    }
  }
}

/** Passes the valid messages of a page on; a copy or export over the size limit is refused and noted once per panel. */
export function receiveFrom(
  panel: vscode.WebviewPanel,
  deps: GridDeps,
  handle: (message: WebviewMessage) => void,
): void {
  let noted = false;
  let flooded = false;
  // Each copy or export opens the clipboard or a save dialog: as for the report pages, a few per second.
  const overLimit = requestLimit();
  panel.webview.onDidReceiveMessage((message: unknown) => {
    if (isWebviewMessage(message)) {
      if ((message.type === 'copy' || message.type === 'export') && overLimit()) {
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

/** The clipboard and the CSV file of a grid, for the data grid and the results panel alike. */
export async function transfer(
  deps: GridDeps,
  message: Extract<WebviewMessage, { type: 'copy' | 'export' }>,
): Promise<void> {
  if (message.type === 'copy') {
    try {
      await deps.clipboard.writeText(message.text);
      const what = { all: 'all rows', text: 'the output', cell: 'cell', row: 'row' }[message.what];
      vscode.window.setStatusBarMessage(`Copied ${what}`, 2000);
    } catch (error) {
      deps.log?.error('Copying to the clipboard failed.', error);
      void vscode.window.showErrorMessage(`Could not copy to the clipboard: ${messageOf(error)}`);
    }
  } else {
    try {
      await deps.saveFile(message.suggestedName, message.csv);
    } catch (error) {
      deps.log?.error('Saving the CSV file failed.', error);
      void vscode.window.showErrorMessage(`Could not save the file: ${messageOf(error)}`);
    }
  }
}

function post(entry: Entry): void {
  if (entry.ready) {
    const message: ExtensionMessage = { type: 'data', data: entry.data };
    void entry.panel.webview.postMessage(message);
  }
}
