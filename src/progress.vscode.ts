import * as vscode from 'vscode';
import { runCancellable } from './cancel';

/** Runs `run` under a notification with Cancel; cancelling or `outer` aborts what the engine can stop. */
export async function withCancel<T>(
  title: string,
  run: (signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal,
): Promise<T> {
  return await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    (_progress, token) => runCancellable(token, run, outer),
  );
}
