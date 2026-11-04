import * as vscode from 'vscode';
import type { SecretsPort, SettingsPort, WizardUi } from './ports';

export function createSettingsPort(): SettingsPort {
  return {
    read: () => vscode.workspace.getConfiguration('aantje').get<unknown>('connections'),
    write: async (value) => {
      await vscode.workspace
        .getConfiguration('aantje')
        .update('connections', value, vscode.ConfigurationTarget.Global);
    },
  };
}

export function createSecretsPort(secrets: vscode.SecretStorage): SecretsPort {
  return {
    get: async (key) => secrets.get(key),
    set: async (key, value) => {
      await secrets.store(key, value);
    },
    delete: async (key) => {
      await secrets.delete(key);
    },
  };
}

export function createWizardUi(): WizardUi {
  return {
    async pick(title, items) {
      const picked = await vscode.window.showQuickPick(items, { title, ignoreFocusOut: true });
      return picked?.value;
    },
    input: (options) =>
      Promise.resolve(
        vscode.window.showInputBox({
          title: options.title,
          prompt: options.prompt,
          value: options.value,
          password: options.password,
          validateInput: options.validate,
          ignoreFocusOut: true,
        }),
      ),
    async confirm(message, action) {
      return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
    },
    info: (message) => void vscode.window.showInformationMessage(message),
    error: (message) => void vscode.window.showErrorMessage(message),
    withProgress: (title, task) =>
      Promise.resolve(
        vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, (progress) =>
          task((message) => progress.report({ message })),
        ),
      ),
  };
}
