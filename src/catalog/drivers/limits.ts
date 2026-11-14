import { AantjeError } from '../../errors';

// One text per situation for every driver: the tree shows them as message nodes, so the same situation must read the
// same whatever kind of catalog the connection has.

/** Added to the message of a native engine that cannot be loaded, by the drivers that need it. */
export const NO_ENGINE_ADVICE = ', or use a SQLite or PostgreSQL catalog.';

/** The caller's signal fired, or the driver was closed while the query ran. */
export const queryCancelled = (cause?: unknown): AantjeError =>
  new AantjeError('ABORTED', 'The query was cancelled.', cause === undefined ? undefined : { cause });

/** The statement ran longer than `aantje.queryTimeoutSeconds`. */
export const queryTimedOut = (timeoutMs: number, cause?: unknown): AantjeError =>
  new AantjeError(
    'TIMEOUT',
    `The catalog query exceeded the time limit of ${timeoutMs / 1000} s and was cancelled.`,
    cause === undefined ? undefined : { cause },
  );

/** A query after `close()`. Not `QUERY_FAILED`: the reader takes that for a missing table. */
export const catalogClosed = (): AantjeError =>
  new AantjeError('CONNECTION_FAILED', 'The catalog connection is closed.');

/** A statement that the engine refused, with the engine's reason. */
export const queryFailed = (reason: string, cause: unknown): AantjeError =>
  new AantjeError('QUERY_FAILED', `The catalog query failed: ${reason}`, { cause });

/** An integer that a number cannot hold exactly: the driver refuses it instead of passing on a rounded id or count. */
export const unsafeInteger = (value: number | bigint): AantjeError =>
  new AantjeError(
    'QUERY_FAILED',
    `The catalog returned the integer ${value}, which is larger than the largest exactly representable number (${Number.MAX_SAFE_INTEGER}).`,
  );

/** A catalog file that cannot be read; `code` is the code of the file system (`ENOENT`, `EACCES`). */
export const unreadableFile = (path: string, code: string | undefined, cause: unknown): AantjeError =>
  new AantjeError('FILE_NOT_FOUND', `Cannot read "${path}": ${code ?? 'unknown error'}.`, { cause });

/** The signal that ends one query (its limit, its caller, the driver's close) and the error that tells which. */
export function queryLimits(
  shutdown: AbortSignal,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { readonly cancel: AbortSignal; readonly cancelled: () => AantjeError } {
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const cancel = AbortSignal.any([shutdown, signal, timeout].filter((s) => s !== undefined));
  const cancelled = (): AantjeError =>
    timeoutMs !== undefined && cancel.reason === timeout?.reason
      ? queryTimedOut(timeoutMs)
      : queryCancelled();
  return { cancel, cancelled };
}

/** Keeps `promise` in `running` until it settles, so that a close can wait for the work that runs now. */
export function track<T>(running: Set<Promise<unknown>>, promise: Promise<T>): Promise<T> {
  running.add(promise);
  const forget = (): void => void running.delete(promise);
  promise.then(forget, forget);
  return promise;
}
