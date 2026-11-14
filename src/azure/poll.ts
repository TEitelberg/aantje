import { ArmRequestError, ArmUnreachableError } from './arm-transport';

/** A poll survives a few failed requests in a row (see `isPassingPollFailure`); the work itself goes on in Azure. */
const TOLERATED_POLL_FAILURES = 3;

// A poll survives a few of these in a row: no answer, a server error, and an expired token, which the next request
// replaces because the sign-in of VS Code renews it.
function isPassingPollFailure(error: unknown): error is ArmRequestError | ArmUnreachableError {
  return (
    error instanceof ArmUnreachableError ||
    (error instanceof ArmRequestError && (error.status >= 500 || error.status === 401))
  );
}

export interface PollOptions {
  readonly pollMs: number;
  readonly timeoutMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  /** How long the poll has run so far; without it only the pauses count, not the time of the requests. */
  readonly spent?: () => number;
  /** A failed poll that is tried again after `pauseMs`. */
  readonly onRetry?: (error: ArmRequestError | ArmUnreachableError, pauseMs: number) => void;
  /** The error for a failure that ends the poll; without it the failure itself. */
  readonly onFailure?: (error: unknown) => Error;
  /** The error when the time is up. */
  readonly onTimeout: () => Error;
}

/**
 * Asks `check` until it returns a value. A few failures in a row that `isPassingPollFailure` accepts are tried again;
 * each one in a row doubles the pause, so that a network switch or a short outage passes.
 */
export async function pollUntil<T>(check: () => Promise<T | undefined>, options: PollOptions): Promise<T> {
  const { pollMs, timeoutMs, sleep } = options;
  let waited = 0;
  let failures = 0;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined) {
        return value;
      }
      failures = 0;
    } catch (error) {
      if (!isPassingPollFailure(error) || ++failures > TOLERATED_POLL_FAILURES) {
        throw options.onFailure ? options.onFailure(error) : error;
      }
      options.onRetry?.(error, pollMs * 2 ** failures);
    }
    if ((options.spent?.() ?? waited) >= timeoutMs) {
      throw options.onTimeout();
    }
    const pause = pollMs * 2 ** failures;
    await sleep(pause);
    waited += pause;
  }
}
