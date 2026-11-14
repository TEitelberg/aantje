import * as vscode from 'vscode';

/** A single-choice picker; uses `createQuickPick`, not `showQuickPick`, to preselect the current choice. */
export function pickOne<T extends vscode.QuickPickItem>(
  items: readonly T[],
  options: { title: string; placeholder: string; active?: readonly T[] },
): Promise<T | undefined> {
  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick<T>();
    picker.title = options.title;
    picker.placeholder = options.placeholder;
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.items = items;
    picker.activeItems = options.active ?? [];
    let choice: T | undefined;
    picker.onDidAccept(() => {
      choice = picker.selectedItems[0];
      picker.hide();
    });
    picker.onDidHide(() => {
      picker.dispose();
      resolve(choice);
    });
    picker.show();
  });
}

/** A picker of several rows; rows with `picked` start selected. Undefined when it is cancelled. */
export async function pickMany<T extends vscode.QuickPickItem>(
  items: readonly T[],
  options: { title: string; placeholder: string },
): Promise<T[] | undefined> {
  return await vscode.window.showQuickPick(items, {
    title: options.title,
    placeHolder: options.placeholder,
    canPickMany: true,
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
}

/** The questions and hints of the time travel commands. */
export const timeTravelUi = {
  pick: pickOne,
  info: (message: string): void => {
    void vscode.window.showInformationMessage(message);
  },
};
