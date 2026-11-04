import * as vscode from 'vscode';
import { createLogger } from './log';
import type { Logger, SecretRegistry } from './log';

/** Logger for the "aantje" output channel; the user sets the level in the editor, the extension does not filter. */
export function createOutputChannelLogger(secrets: SecretRegistry): Logger & { dispose(): void } {
  const channel = vscode.window.createOutputChannel('aantje', { log: true });
  const logger = createLogger((level, message) => channel[level](message), secrets);
  return { ...logger, dispose: () => channel.dispose() };
}
