import * as vscode from 'vscode';
import type { SnapshotId } from '../catalog/model';
import { writingFile } from '../export/file';
import { chooseExportTarget, confirmMarkdownRows } from '../export/save.vscode';
import { groupedPlural } from '../shell/numbers';
import type { DataActions } from './commands.vscode';
import { countRelation, exportRelation } from './export';
import type { DataTarget } from './resolve';

/**
 * Export...: the whole table or view at the snapshot that the tree shows, written to a CSV, Parquet, JSON or Markdown
 * file that the user chooses, in the read-only engine of the data preview. A Markdown table of many rows is asked about
 * first. A failed or cancelled export leaves no partial file.
 */
export async function exportToFile(
  actions: Pick<DataActions, 'read'>,
  target: DataTarget,
  snapshot: SnapshotId | undefined,
): Promise<void> {
  const { table } = target.relation;
  const name = `${table.schema}.${table.table}`;
  const file = await chooseExportTarget(`Export ${name}`, name);
  if (!file) return;
  if (file.format === 'markdown') {
    const rows = await actions.read(target, snapshot, `Counting the rows of ${name}...`, (access, signal) =>
      countRelation(access, table, signal),
    );
    if (!(await confirmMarkdownRows(rows))) return;
  }
  const rows = await writingFile(file.path, () =>
    actions.read(target, snapshot, `Exporting ${name}...`, (access, signal) =>
      exportRelation(access, table, file, signal),
    ),
  );
  void vscode.window.showInformationMessage(
    `Exported ${groupedPlural(rows, 'row')} of "${name}" to ${file.path}.`,
  );
}
