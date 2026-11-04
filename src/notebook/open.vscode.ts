import * as vscode from 'vscode';
import { AantjeError } from '../errors';
import type { NotebookCell } from './build';

const JUPYTER_EXTENSION = 'ms-toolsai.jupyter';

/** Opens the cells as a new untitled Jupyter notebook. */
export async function openNotebook(cells: readonly NotebookCell[]): Promise<void> {
  if (!vscode.extensions.getExtension(JUPYTER_EXTENSION)) {
    throw new AantjeError(
      'CONNECTION_FAILED',
      `Creating a notebook needs the Jupyter extension (${JUPYTER_EXTENSION}). Install it and try again.`,
    );
  }
  const data = new vscode.NotebookData(
    cells.map(
      (cell) =>
        new vscode.NotebookCellData(
          cell.kind === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
          cell.source,
          cell.language,
        ),
    ),
  );
  await vscode.window.showNotebookDocument(
    await vscode.workspace.openNotebookDocument('jupyter-notebook', data),
  );
}
