/** Failure categories; each error carries a message safe to show. */
export type ErrorCode =
  | 'INVALID_PROFILE'
  | 'FILE_NOT_FOUND'
  | 'CONNECTION_FAILED'
  | 'AUTH_FAILED'
  | 'LOCKED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'QUERY_FAILED'
  | 'VIEW_UNTRUSTED'
  | 'NOT_A_DUCKLAKE'
  | 'UNSUPPORTED_VERSION';

/** Error with a secret-free `userMessage`; the original error stays in `cause` and goes only to the redacted log. */
export class AantjeError extends Error {
  /** The table (plain names) whose read failed; the health check starts from it. */
  readonly table?: { readonly schema: string; readonly table: string };
  /** The connection whose data read failed; with the table it tells the health check where to look. */
  readonly connectionId?: string;

  constructor(
    readonly code: ErrorCode,
    readonly userMessage: string,
    options?: {
      cause?: unknown;
      table?: { readonly schema: string; readonly table: string };
      connectionId?: string;
    },
  ) {
    super(userMessage, options && 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'AantjeError';
    if (options?.table) {
      this.table = options.table;
    }
    if (options?.connectionId !== undefined) {
      this.connectionId = options.connectionId;
    }
  }
}

export function isAantjeError(error: unknown): error is AantjeError {
  return error instanceof AantjeError;
}

/** True when the user declined a confirmation or cancelled an action; nothing went wrong. */
export function isAborted(error: unknown): boolean {
  return isAantjeError(error) && error.code === 'ABORTED';
}

/** The message to show for any thrown value; unknown errors become generic text. */
export function userMessageOf(error: unknown): string {
  return isAantjeError(error)
    ? error.userMessage
    : 'Unexpected error. See the "aantje" output channel for details.';
}

/** The message of a thrown value; a non-`Error` (string, `null`) is converted to text. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Node system errors carry the failure code (`EBUSY`, `ECONNREFUSED`, ...).
/** The words for a network failure that Node reports by its code; undefined for any other error. */
export function networkReason(error: unknown): string | undefined {
  const code = isErrnoException(error) ? error.code : undefined;
  if (code === 'ECONNREFUSED') return 'connection refused (is the server running on this port?)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the host name could not be resolved';
  return undefined;
}

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && typeof error.code === 'string';
}
