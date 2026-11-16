import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { safeFileName } from '../grid/model';
import { formatOfPath } from './copy';
import type { CsvText, ExportTarget } from './copy';

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
 * The file of Run to File and Export: the save dialog with the filters CSV and Parquet (the extension decides the
 * format), then for CSV how it holds text. Undefined when the user cancelled either question.
 */
export async function chooseExportTarget(title: string, stem: string): Promise<ExportTarget | undefined> {
  const path = await askSavePath({
    title,
    stem,
    extension: 'csv',
    filters: { CSV: ['csv'], Parquet: ['parquet'] },
  });
  if (path === undefined) return undefined;
  const format = formatOfPath(path);
  if (format === undefined) {
    info('Choose a file name that ends in .csv or .parquet: the extension decides the format.');
    return undefined;
  }
  if (format === 'parquet') return { path, format };
  const text = await pickCsvText();
  return text && { path, format, text };
}

async function pickCsvText(): Promise<CsvText | undefined> {
  const items: (vscode.QuickPickItem & { readonly text: CsvText })[] = [
    {
      label: 'For Excel (formulas neutralised)',
      detail:
        "Text that starts with =, +, -, @, a tab or a carriage return gets a leading ', as in Export CSV of the grid.",
      text: 'excel',
    },
    {
      label: 'Unchanged (for loading elsewhere)',
      detail: 'Every value exactly as it is.',
      text: 'exact',
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Values of the CSV file',
    placeHolder: 'How the file holds text',
    ignoreFocusOut: true,
  });
  return picked?.text;
}
