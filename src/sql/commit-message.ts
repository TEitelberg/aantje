// The commit message of the snapshots of a run in the SQL editor. DuckLake stores an author and a message per snapshot
// (`ducklake_snapshot_changes`); `set_commit_message` sets them for the transaction that it runs in, before or after
// its writes, and a call outside a transaction sets nothing (checked with DuckDB 2.0 and its ducklake extension).
import { quoteLiteral } from '../catalog/ddl';
import type { ConnectionProfile } from '../connections/profile';
import { LAKE } from '../data/attach';
import { withoutInvisible } from '../markdown';
import type { TransactionState } from './session';

/** The message of the snapshots of a run, and their author; the author is set only together with a message. */
export interface CommitMessage {
  readonly author: string | null;
  readonly message: string;
}

/** The call that gives the transaction it runs in its message, on the lake as the session attaches it. */
export function setCommitMessageCall({ author, message }: CommitMessage): string {
  return `CALL ${LAKE}.set_commit_message(${author === null ? 'NULL' : quoteLiteral(author)}, ${quoteLiteral(message)})`;
}

/**
 * The commented call for the transaction of a script that aantje opens (a restore, Script as Update), with a suggested
 * message on one line: removing the `-- ` gives the snapshot that message. When the SQL editor asks for a message at
 * the COMMIT, the one given there comes later and counts.
 */
export function commitMessageLine(suggestion: string): string {
  return `-- ${setCommitMessageCall({ author: null, message: withoutInvisible(suggestion) })};`;
}

/**
 * The author of a commit message: the setting `aantje.commitAuthor`, else the user of a PostgreSQL connection (for an
 * Entra login that is the UPN), else none.
 */
export function commitAuthorOf(setting: string, profile: ConnectionProfile): string | null {
  const own = setting.trim();
  if (own !== '') return own;
  return profile.kind === 'postgres' ? profile.user : null;
}

const STARTS = new Set(['BEGIN', 'START']);
const COMMITS = new Set(['COMMIT', 'END']);
const ROLLS_BACK = new Set(['ROLLBACK', 'ABORT']);

/** The statements that open, commit or roll back a transaction; a run never wraps them in one of its own. */
export function controlsTransaction(keyword: string): boolean {
  return STARTS.has(keyword) || COMMITS.has(keyword) || ROLLS_BACK.has(keyword);
}

/** Whether the statement commits the transaction (`COMMIT`, `END`). */
export function commits(keyword: string): boolean {
  return COMMITS.has(keyword);
}

/**
 * Whether a run of the statements commits a change, so that it asks for a message: a statement that may change the
 * catalog outside a transaction (it commits itself), or the COMMIT of a transaction in which one ran. `start` is the
 * state of the session before the run; a statement that fails is not foreseen.
 */
export function commitsChange(
  statements: readonly { readonly keyword: string; readonly changesCatalog: boolean }[],
  start: { readonly inTransaction: TransactionState; readonly changed: boolean },
): boolean {
  let open = start.inTransaction;
  let changed = start.changed;
  for (const { keyword, changesCatalog } of statements) {
    if (STARTS.has(keyword)) {
      if (open === 'none') [open, changed] = ['open', false];
    } else if (COMMITS.has(keyword) || ROLLS_BACK.has(keyword)) {
      if (COMMITS.has(keyword) && open === 'open' && changed) return true;
      [open, changed] = ['none', false];
    } else if (changesCatalog) {
      if (open === 'none') return true;
      changed = true;
    }
  }
  return false;
}

/**
 * Runs `work` in a transaction of its own that carries the message: `BEGIN`, the call, the work, `COMMIT`. A failure,
 * also of the COMMIT (a conflict with another writer), rolls it back and is the failure of the work.
 */
export async function inTransactionOf<T>(
  call: string,
  run: (sql: string) => Promise<unknown>,
  work: () => Promise<T>,
): Promise<T> {
  await run('BEGIN');
  try {
    await run(call);
    const result = await work();
    await run('COMMIT');
    return result;
  } catch (cause) {
    await run('ROLLBACK').catch(() => undefined);
    throw cause;
  }
}
