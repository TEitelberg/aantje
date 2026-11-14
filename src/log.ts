import { inspect } from 'node:util';
import { isAantjeError } from './errors';
import { MIN_SECRET_LENGTH, SECRET_MASK, maskPattern } from './secrets';

/** Logging port; the VS Code output channel implements it (`log.vscode.ts`). */
export interface Logger {
  /** Details that the channel shows only at the level Debug (Developer: Set Log Level...). */
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

/** Logger that discards everything. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

type Level = 'debug' | 'info' | 'warn' | 'error';

type LogSink = (level: Level, message: string) => void;

// `scheme://user:password@host`. The password ends at the last `@` of the authority, so a raw `@` in
// the password or the user name (`user@server` of Azure) is covered.
const URL_PASSWORD = /(:\/\/[^\s:/?#]*):[^\s/?#]*@/g;
// libpq style `password=secret` and `password='it\'s quoted'`.
const KEYWORD_PASSWORD = /(password\s*=\s*)(?:'(?:[^'\\]|\\.)*'|\S+)/gi;

/** Masks registered secrets in log text, and passwords in connection strings even when unregistered. */
export class SecretRegistry {
  private readonly values = new Set<string>();
  private pattern: RegExp | undefined;

  /**
   * Registers a secret so that it is masked in every form it may take in text (see `maskPattern`); values under
   * `MIN_SECRET_LENGTH` characters are ignored so a short value cannot garble every line.
   */
  add(value: string): void {
    if (value.length < MIN_SECRET_LENGTH || this.values.has(value)) {
      return;
    }
    this.values.add(value);
    this.pattern = maskPattern(this.values);
  }

  /** Replaces registered secrets and connection string passwords with `***`. */
  redact(text: string): string {
    const masked = this.pattern ? text.replace(this.pattern, SECRET_MASK) : text;
    return masked.replace(URL_PASSWORD, `$1:${SECRET_MASK}@`).replace(KEYWORD_PASSWORD, `$1${SECRET_MASK}`);
  }
}

/** Redacts every message and error detail before it reaches the sink. */
export function createLogger(sink: LogSink, secrets: SecretRegistry): Logger {
  const write = (level: Level, text: string): void => sink(level, secrets.redact(text));
  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message, error) =>
      write('error', error === undefined ? message : `${message}\n${formatError(error)}`),
  };
}

/** Runs `run`; a rejection is logged as "<what> failed." with its causes and thrown again unchanged. */
export async function logFailure<T>(logger: Logger, what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    logger.error(`${what} failed.`, error);
    throw error;
  }
}

// Log text for a thrown value. An `AantjeError` reads `code: userMessage`; other errors keep their stack, also as a
// cause: `openCatalog` wraps unexpected errors, so the cause locates the bug. Causes follow as `Caused by:`.
/** Exported for its test. */
export function formatError(error: unknown): string {
  const lines = [describeError(error)];
  const seen = new Set<unknown>([error]);
  const addCauses = (parent: unknown): void => {
    for (const cause of causesOf(parent)) {
      if (!seen.has(cause)) {
        seen.add(cause);
        lines.push(`Caused by: ${describeError(cause)}`);
        addCauses(cause);
      }
    }
  };
  addCauses(error);
  return lines.join('\n');
}

function describeError(error: unknown): string {
  if (isAantjeError(error)) {
    return `${error.code}: ${error.userMessage}`;
  }
  if (error instanceof Error) {
    return error.stack ?? (error.message === '' ? error.name : `${error.name}: ${error.message}`);
  }
  // `compact: true`: otherwise Node groups arrays of more than six items into rows.
  return typeof error === 'string' ? error : inspect(error, { breakLength: Infinity, compact: true });
}

// `cause` plus `AggregateError` members: Node reports a refused `localhost` as one, with an empty message
// and one member per address.
function causesOf(error: unknown): unknown[] {
  if (!(error instanceof Error)) {
    return [];
  }
  const members: unknown[] = error instanceof AggregateError ? error.errors : [];
  return error.cause === undefined ? members : [error.cause, ...members];
}
