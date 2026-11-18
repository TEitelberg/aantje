import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { safeFileName } from '../grid/model';
import { count } from '../shell/numbers';
import { extensionOf, formatOfPath } from './copy';
import type { ExportTarget, JsonLayout } from './copy';
import { MARKDOWN_ASK_ROWS } from './markdown';
import type { MarkdownNull } from './markdown';

/** What the save dialog proposes and offers. */
export interface SaveRequest {
  readonly title: string;
  /** The proposed name without its extension, e.g. `sales.orders`; catalog text, made safe for a file name here. */
  readonly stem: string;
  /** The extension of the proposed name, e.g. `csv`. */
  readonly extension: string;
  /** The filters of the dialog by label, e.g. `{ CSV: ['csv'] }`. */
  readonly filters: Readonly<Record<string, readonly string[]>>;
}

const info = (message: string): void => void vscode.window.showInformationMessage(message);

/**
 * Asks where to save, proposing the name in the first workspace folder, else in the home folder. The local path, or
 * undefined when the user cancelled; aantje writes local files only.
 */
export async function askSavePath(request: SaveRequest): Promise<string | undefined> {
  const name = safeFileName(request.stem, request.extension);
  const folder = vscode.workspace.workspaceFolders?.find(({ uri }) => uri.scheme === 'file');
  const defaultUri = folder ? vscode.Uri.joinPath(folder.uri, name) : vscode.Uri.file(join(homedir(), name));
  const filters = Object.fromEntries(
    Object.entries(request.filters).map(([label, list]) => [label, [...list]]),
  );
  const uri = await vscode.window.showSaveDialog({ defaultUri, filters, title: request.title });
  if (!uri) return undefined;
  if (uri.scheme !== 'file') {
    info('aantje writes local files only. Choose a file on this machine.');
    return undefined;
  }
  return uri.fsPath;
}

/**
 * The file of Run to File and Export: the save dialog with the filters CSV, Parquet, JSON and Markdown (the extension
 * decides the format), then for `.json` its layout; `.ndjson` and `.jsonl` are one object per line. A CSV file holds
 * every value as it is. Undefined when the user cancelled a question.
 */
export async function chooseExportTarget(title: string, stem: string): Promise<ExportTarget | undefined> {
  const path = await askSavePath({
    title,
    stem,
    extension: 'csv',
    filters: { CSV: ['csv'], Parquet: ['parquet'], JSON: ['json', 'ndjson', 'jsonl'], Markdown: ['md'] },
  });
  if (path === undefined) return undefined;
  const format = formatOfPath(path);
  switch (format) {
    case undefined:
      info(
        'Choose a file name that ends in .csv, .parquet, .json, .ndjson or .md: the extension decides the format.',
      );
      return undefined;
    case 'parquet':
    case 'csv':
      return { path, format };
    case 'markdown':
      return { path, format, nulls: markdownNull() };
    case 'json': {
      const layout = extensionOf(path) === 'json' ? await pickJsonLayout() : 'lines';
      return layout && { path, format, layout };
    }
  }
}

/** The setting `aantje.export.markdownNull`: how a NULL shows in a Markdown table. */
export function markdownNull(): MarkdownNull {
  return vscode.workspace.getConfiguration('aantje').get<string>('export.markdownNull') === 'NULL'
    ? 'null'
    : 'empty';
}

/**
 * Asks before a Markdown table of more than `MARKDOWN_ASK_ROWS` rows is written, since nobody reads one that long;
 * true to write it.
 */
export async function confirmMarkdownRows(rows: number): Promise<boolean> {
  if (rows <= MARKDOWN_ASK_ROWS) return true;
  const write = 'Write Markdown';
  const choice = await vscode.window.showWarningMessage(
    `The result has ${count(rows)} rows. A Markdown table that long is hard to read; CSV, Parquet or JSON suit it better. Write the Markdown file anyway?`,
    { modal: true },
    write,
  );
  return choice === write;
}

async function pickJsonLayout(): Promise<JsonLayout | undefined> {
  const items: (vscode.QuickPickItem & { readonly layout: JsonLayout })[] = [
    {
      label: 'One object per line (newline-delimited JSON)',
      detail: 'Streams well and suits large results; most tools read it, DuckDB with read_json.',
      layout: 'lines',
    },
    {
      label: 'One JSON array',
      detail: 'A single document: [ {...}, {...} ]. Suits small results that an app reads at once.',
      layout: 'array',
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Layout of the JSON file',
    placeHolder: 'How the file holds the rows',
    ignoreFocusOut: true,
  });
  return picked?.layout;
}
