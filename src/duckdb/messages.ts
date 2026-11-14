import { AantjeError, messageOf } from '../errors';
import { maskSecrets } from '../secrets';

export const EXTENSION_HINT =
  'aantje downloads them from extensions.duckdb.org on first use. Without network access, point the setting "aantje.duckdb.extensionDirectory" to a directory that already holds the extensions.';

export function firstLine(message: string): string {
  return message.split(/\r?\n/)[0] ?? message;
}

/** An engine message without secrets. */
interface ScrubbedMessage {
  /** The whole message; DuckDB may add paragraphs, such as the answer of an object store. */
  readonly text: string;
  /** Its first line: the part that messages and the causes of errors show. */
  readonly line: string;
}

/**
 * The message of an engine failure with every form of the secrets masked. Every engine message goes through it before
 * it is shown or logged.
 */
export function scrubbed(cause: unknown, secrets: readonly string[]): ScrubbedMessage {
  const text = maskSecrets(messageOf(cause), secrets);
  return { text, line: firstLine(text) };
}

/**
 * The error for an extension that could not be installed or loaded. `subject` starts the sentence, for example "A
 * DuckDB extension that the lake needs"; `line` is the scrubbed first line of the engine message and the cause.
 */
export function extensionFailure(
  subject: string,
  line: string,
  where: {
    readonly table?: { readonly schema: string; readonly table: string };
    readonly connectionId?: string;
  } = {},
): AantjeError {
  return new AantjeError(
    'CONNECTION_FAILED',
    `${subject} could not be installed or loaded (${line}). ${EXTENSION_HINT}`,
    { cause: new Error(line), ...where },
  );
}
