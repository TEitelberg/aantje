import type { ConnectionKind } from '../connections/profile';
import {
  isCatalogFile,
  MISSING_LOCAL_FILE,
  MISSING_OBJECT,
  missingLocalFileText,
  missingObjectText,
} from '../data/errors';
import { quackProblem } from '../duckdb/quack';
import type { ErrorCode } from '../errors';
import { SIDE, refusedText, storeProblemOf } from '../storage/diagnose';
import type { StorageContext } from '../storage/diagnose';

export type SessionMode = 'read-write' | 'read-only';

export interface SqlErrorContext {
  readonly mode: SessionMode;
  readonly kind: ConnectionKind;
  /** The secret-free `data_path` of the catalog, when known; it tells catalog files from other files. */
  readonly dataPath?: string;
  /** The storage of the connection, which words where to fix a refused sign-in; the machine's S3 settings if absent. */
  readonly storage?: StorageContext;
}

interface TranslatedError {
  readonly code: ErrorCode;
  readonly message: string;
}

interface Rule {
  readonly pattern: RegExp;
  readonly mode?: SessionMode;
  readonly code: ErrorCode;
  readonly text: (match: RegExpExecArray, context: SqlErrorContext) => string;
}

const READ_ONLY_TEXT =
  'This is a read-only session: the statement would change the lake. Run "Toggle Read-only Session" to switch this editor to a read-write session.';

// DuckDB 2.0, DuckLake, PostgreSQL and S3 messages, tried in this order.
// Long PostgreSQL messages carry SQL and values and are never passed on.
const RULES: readonly Rule[] = [
  {
    // The type is that of the prepared statement ("EXECUTE" for a statement of a script), so it says nothing useful.
    pattern:
      /Cannot execute statement of type "[A-Z_ ]+" on database "([^"]+)" which is attached in read-only mode/,
    code: 'QUERY_FAILED',
    text: ([, database], { mode }) =>
      (database === 'lake' || database === '__ducklake_metadata_lake') && mode === 'read-only'
        ? READ_ONLY_TEXT
        : `The database "${database}" is attached read-only, so the statement cannot change it.`,
  },
  {
    // Maintenance calls (merge, flush, CHECKPOINT) only fail when they commit to the read-only catalog.
    pattern: /Failed to commit DuckLake transaction\.\s*Cannot append to a readonly database/,
    mode: 'read-only',
    code: 'QUERY_FAILED',
    text: () => READ_ONLY_TEXT,
  },
  {
    pattern: /Current transaction is aborted/,
    code: 'QUERY_FAILED',
    text: () =>
      'The transaction was aborted by an earlier error and accepts no more statements. Run ROLLBACK to end it.',
  },
  {
    pattern: /Transaction conflict/,
    code: 'QUERY_FAILED',
    text: () =>
      'Another writer changed the same table or schema first, so this change was not committed. Run the statement again.',
  },
  {
    pattern: /database is locked/i,
    code: 'LOCKED',
    text: () =>
      'The catalog database is locked by another writer, so the change was not committed. Wait a moment and run the statement again.',
  },
  {
    pattern: /attempt to write a readonly database/i,
    code: 'QUERY_FAILED',
    text: () =>
      'The SQLite catalog file is read-only for this user. Make the file writable or use a read-only session.',
  },
  {
    pattern: /permission denied for (table|schema) ("?\w+"?)/i,
    code: 'QUERY_FAILED',
    text: ([, object, name]) =>
      `The database user may not write to the catalog (permission denied for ${object?.toLowerCase()} ${name}). Grant the user write access to the metadata schema or use a read-only session.`,
  },
  {
    // Linux and macOS word the lock differently from Windows (untested there).
    pattern: /being used by another process|Could not set lock on file|Conflicting lock is held/,
    code: 'LOCKED',
    text: (_match, { kind, mode }) =>
      kind !== 'duckdb'
        ? 'A file is open in another process and cannot be used.'
        : mode === 'read-write'
          ? 'The DuckDB catalog file is open in another process or session, and a writable session needs it exclusively. Close the other session or disconnect the explorer connection, or open a read-only session.'
          : 'The DuckDB catalog file is locked for writing by another session. Close it and try again.',
  },
  {
    pattern: /password authentication failed|no password was provided|authentication failed/i,
    code: 'AUTH_FAILED',
    text: () => 'The PostgreSQL server rejected the user name or the password of this connection.',
  },
  {
    pattern: /data_path is not set|creating a new DuckLake is explicitly disabled/,
    code: 'CONNECTION_FAILED',
    text: () =>
      'The catalog is empty or does not exist. aantje never creates a DuckLake or sets its data path: create it with DuckDB first.',
  },
  {
    pattern: /Failed to create directory "([^"]+)"/,
    code: 'QUERY_FAILED',
    text: ([, directory]) =>
      `The data path of the catalog cannot be written: the directory "${directory}" could not be created. Check that it exists and may be written.`,
  },
  {
    pattern: MISSING_OBJECT,
    code: 'QUERY_FAILED',
    text: (match, context) =>
      `Cannot read a data file: ${missingObjectText(match, context)}${isCatalogFile(match, context.dataPath) ? ' If the statement reads an older snapshot (AT (VERSION => ...)), try a newer one.' : ''}`,
  },
  {
    pattern: MISSING_LOCAL_FILE,
    code: 'QUERY_FAILED',
    text: (match, context) =>
      `Cannot read a data file: ${missingLocalFileText(match, context)}${isCatalogFile(match, context.dataPath) ? ' If the statement reads an older snapshot (AT (VERSION => ...)), try a newer one.' : ''}`,
  },
];

/** The friendly text and code for a failed statement; `raw` must be free of secrets, unknown messages shrink to line one. */
export function translateSqlError(raw: string, context: SqlErrorContext): TranslatedError {
  // A Quack server words its refusals and connection failures itself; the PostgreSQL wording would be wrong.
  const quack = context.kind === 'quack' ? quackProblem(raw) : undefined;
  if (quack) {
    const reason = `${quack.reason.charAt(0).toUpperCase()}${quack.reason.slice(1)}.`;
    // The session keeps its attach; only a new session attaches again.
    const restarted = /Invalid connection id/.test(raw);
    return {
      code: quack.code,
      message: restarted
        ? `${reason} Close the session (status bar menu) and run the statement again.`
        : reason,
    };
  }
  for (const rule of RULES) {
    if (rule.mode && rule.mode !== context.mode) continue;
    const match = rule.pattern.exec(raw);
    if (match) {
      return { code: rule.code, message: rule.text(match, context) };
    }
  }
  // The storage refused the sign-in (S3 keys, Azure token, SAS or role): where to fix it depends on the storage.
  const problem = storeProblemOf(raw, context.storage?.kind);
  if (problem !== undefined && SIDE[problem] === 'sign-in') {
    return { code: 'AUTH_FAILED', message: refusedText(context.storage ?? { perConnection: false }) };
  }
  return { code: 'QUERY_FAILED', message: raw.split(/\r?\n/)[0] ?? raw };
}
