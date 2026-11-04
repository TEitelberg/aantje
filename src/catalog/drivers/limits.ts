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
