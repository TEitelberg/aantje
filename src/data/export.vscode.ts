import * as vscode from 'vscode';
import type { SnapshotId } from '../catalog/model';
import { writingFile } from '../export/file';
import { chooseExportTarget } from '../export/save.vscode';
import { groupedPlural } from '../shell/numbers';
import type { DataActions } from './commands.vscode';
import { exportRelation } from './export';
import type { DataTarget } from './resolve';

/**
 * Export...: the whole table or view at the snapshot that the tree shows, written to a CSV or Parquet file that the user
 * chooses, in the read-only engine of the data preview. A failed or cancelled export leaves no partial file.
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
  const rows = await writingFile(file.path, () =>
    actions.read(target, snapshot, `Exporting ${name}...`, (access, signal) =>
      exportRelation(access, table, file, signal),
    ),
  );
  void vscode.window.showInformationMessage(
    `Exported ${groupedPlural(rows, 'row')} of "${name}" to ${file.path}.`,
  );
}
