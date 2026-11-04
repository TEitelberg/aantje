import { messageOf } from '../errors';

export interface RetryOptions {
  /** Whether the failure is worth another try; any other failure is thrown at once. */
  readonly isRetryable: (error: unknown) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly attempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Called before each wait, with the number of the attempt that failed. */
  readonly onRetry?: (attempt: number, error: unknown) => void;
}

/** Runs `task` again with a doubling delay while it fails with a retryable error; the last failure is thrown. */
export async function withBackoff<T>(task: () => Promise<T>, options: RetryOptions): Promise<T> {
  const { attempts = 12, initialDelayMs = 5_000, maxDelayMs = 30_000 } = options;
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= attempts || !options.isRetryable(error)) {
        throw error;
      }
      options.onRetry?.(attempt, error);
      await options.sleep(Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs));
    }
  }
}

/** A new role assignment takes effect on the storage account after a delay that Azure does not promise. */
export function isRolePropagation(error: unknown): boolean {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  const text = `${messageOf(error)} ${cause}`;
  return /AuthorizationPermissionMismatch|not authorized to perform this operation|\b403\b|Forbidden/i.test(
    text,
  );
}
