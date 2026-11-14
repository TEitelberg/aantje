import * as vscode from 'vscode';
import { runCancellable } from './cancel';
import { queryCancelled } from './catalog/drivers/limits';

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

/**
 * `withCancel` for reads that do not all stop at the signal: after a cancel the command stops once the reads in flight
 * are done, and nothing that they returned is used.
 */
export function cancellable<T>(title: string, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return withCancel(title, async (signal) => {
    const result = await read(signal);
    if (signal.aborted) throw queryCancelled();
    return result;
  });
}
