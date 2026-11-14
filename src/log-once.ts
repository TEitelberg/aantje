import type { Logger } from './log';

export type FailureLog = (kind: string, error: unknown) => void;

/** Logs the first failure of each kind and drops repeats: a trace, not one entry per keystroke. */
export function failureLog(logger: Logger): FailureLog {
  const seen = new Set<string>();
  return (kind, error) => {
    if (!seen.has(kind)) {
      seen.add(kind);
      logger.error(`${kind} failed; further failures of it are not logged.`, error);
    }
  };
}

/** What `pending` gives, or `fallback` once it failed; the failure goes to `failed` as `kind`. */
export function withFallback<T, F>(
  failed: FailureLog,
  kind: string,
  pending: Promise<T>,
  fallback: F,
): Promise<T | F> {
  return pending.catch((error: unknown) => {
    failed(kind, error);
    return fallback;
  });
}
