import * as vscode from 'vscode';
import type { Register } from '../command.vscode';
import { pickerLabel } from '../messages';
import { pickOne } from '../pick.vscode';
import type { CatalogTree } from '../tree/model';
import type { TreeNode } from '../tree/refs';
import { importFlow } from './import-flow';
import type { ImportUi } from './import-flow';

interface FilesCommandEnv {
  readonly tree: CatalogTree;
  readonly register: Register;
  /** Opens the text in a new SQL editor bound to the connection; it never runs it. */
  readonly openSql: (connectionId: string, text: string) => Promise<void>;
}

const ui: ImportUi = {
  async pick(title, placeholder, items, active) {
    const rows = items.map((item) => ({
      label: item.label,
      description: item.description,
      value: item.value,
    }));
    const chosen = await pickOne(rows, {
      title,
      placeholder,
      active: rows.filter((row) => active !== undefined && row.value === active),
    });
    return chosen?.value;
  },
  input: (title, prompt, value, validate) =>
    Promise.resolve(
      vscode.window.showInputBox({
        title,
        prompt,
        value,
        ignoreFocusOut: true,
        validateInput: (text) => (text.trim() === '' ? 'Enter a name.' : validate?.(text)),
      }),
    ),
  info: (message) => void vscode.window.showInformationMessage(message),
};

/** The path of a file or folder node of the Files folder; undefined for any other node. */
function pathOf(node: TreeNode | undefined): string | undefined {
  const ref = node?.ref;
  return ref?.kind === 'file' ? ref.entry.path : ref?.kind === 'fileFolder' ? ref.place.path : undefined;
}

/** Copy Path, Refresh and the two import scripts of the folder Files. */
export function registerFilesCommands({ tree, register, openSql }: FilesCommandEnv): vscode.Disposable[] {
  return [
    register('aantje.copyPath', async (node) => {
      const path = pathOf(node);
      if (path === undefined) return;
      await vscode.env.clipboard.writeText(path);
      vscode.window.setStatusBarMessage(`Copied ${pickerLabel(path)}`, 3000);
    }),
    register('aantje.refreshFiles', (node) => {
      if (node) tree.refreshFiles(node);
    }),
    register('aantje.scriptImportFile', async (node) => {
      if (node) await importFlow({ tree, ui, openSql }, node, 'create');
    }),
    register('aantje.scriptInsertFile', async (node) => {
      if (node) await importFlow({ tree, ui, openSql }, node, 'insert');
    }),
  ];
}
