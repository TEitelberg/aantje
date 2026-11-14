import { isBelowDataPath } from '../catalog/locations';
import { quoteLiteral } from '../catalog/ddl';
import { LAKE } from '../data/attach';
import { LakeFailure, failureMessageOf, withLakeSession } from '../data/lake-session';
import type { LakeSession } from '../data/lake-session';
import type { DataAccess } from '../data/types';
import { escapeGlob } from '../data/store-sql';
import { isAantjeError } from '../errors';
import { SIZED_FILES } from './model';
import type { ExpiryMeasure, FileMeasure, Measured, Policy } from './model';

// Paths per statement that looks up sizes.
const SIZE_BATCH = 250;

// The default time limit of a statement; listing a large store takes a while.
const STATEMENT_MS = 60_000;

// Fixed text. Values are only the policy interval and the paths the dry runs returned, as string literals.
// Glob characters in paths are written as classes. Every statement is a dry run or a read: `dry_run => true`.
const statements = {
  expiry: (interval: string): string =>
    `SELECT count(*), epoch_ms(min(snapshot_time)), epoch_ms(max(snapshot_time)) FROM ducklake_expire_snapshots('${LAKE}', older_than => now() - CAST(${quoteLiteral(interval)} AS INTERVAL), dry_run => true)`,
  cleanup: `SELECT path, count(*) OVER () FROM ducklake_cleanup_old_files('${LAKE}', dry_run => true) LIMIT ${SIZED_FILES}`,
  orphans: `SELECT path, count(*) OVER () FROM ducklake_delete_orphaned_files('${LAKE}', dry_run => true) LIMIT ${SIZED_FILES}`,
  sizes: (paths: readonly string[]): string =>
    `SELECT count(*), sum(size) FROM read_blob([${paths.map((path) => quoteLiteral(escapeGlob(path))).join(', ')}])`,
};

// The reason on the page, as the health check words a failure: short and free of secrets (the engine scrubs them).
function reasonOf(error: unknown): string {
  const line = failureMessageOf(error).trim();
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

async function attempt<T>(use: () => Promise<T>): Promise<Measured<T>> {
  try {
    return { state: 'measured', value: await use() };
  } catch (error) {
    if (error instanceof LakeFailure) {
      return { state: 'skipped', reason: reasonOf(error) };
    }
    throw error;
  }
}

const toIso = (milliseconds: unknown): string | null =>
  milliseconds === null || milliseconds === undefined ? null : new Date(Number(milliseconds)).toISOString();

async function expiryOf(
  session: LakeSession,
  policy: Policy,
  snapshots: number,
  limitMs: number,
): Promise<ExpiryMeasure> {
  const [row] = await session.rows(statements.expiry(policy.expire.text), limitMs);
  const expiring = Number(row?.[0] ?? 0);
  return {
    snapshots,
    expiring,
    oldest: expiring === 0 ? null : toIso(row?.[1]),
    newest: expiring === 0 ? null : toIso(row?.[2]),
  };
}

// The files a dry run lists; the first `SIZED_FILES` inside the data path are sized in batches.
async function filesOf(
  session: LakeSession,
  statement: string,
  dataPath: string | null,
  limitMs: number,
): Promise<FileMeasure> {
  const rows = await session.rows(statement, limitMs);
  const paths = rows.flatMap((row) =>
    typeof row[0] === 'string' && isBelowDataPath(row[0], dataPath) ? [row[0]] : [],
  );
  const files = Number(rows[0]?.[1] ?? 0);
  let bytes = 0;
  let sized = 0;
  for (let start = 0; start < paths.length; start += SIZE_BATCH) {
    try {
      const [found] = await session.rows(statements.sizes(paths.slice(start, start + SIZE_BATCH)), limitMs);
      sized += Number(found?.[0] ?? 0);
      bytes += Number(found?.[1] ?? 0);
    } catch (error) {
      // The files are listed; a store that refuses to tell their size leaves them unsized, and the page says so.
      if (!(error instanceof LakeFailure)) throw error;
    }
  }
  return { files, bytes, sized };
}

interface Measures {
  readonly expiry: Measured<ExpiryMeasure>;
  readonly cleanup: Measured<FileMeasure>;
  readonly orphans: Measured<FileMeasure>;
}

/**
 * Runs the three dry runs through the read-only one-shot engine (`READ_ONLY`, locked configuration): nothing commits.
 * A failed dry run is `skipped` with its reason; only files below `dataPath` are sized; a cancel rejects.
 */
export async function measureDryRuns(
  access: DataAccess,
  policy: Policy,
  snapshots: number,
  dataPath: string | null,
  signal?: AbortSignal,
): Promise<Measures> {
  const limitMs = access.timeoutMs ?? STATEMENT_MS;
  try {
    return await withLakeSession(access, signal, async (session) => {
      const expiry = await attempt(() => expiryOf(session, policy, snapshots, limitMs));
      const cleanup = await attempt(() => filesOf(session, statements.cleanup, dataPath, limitMs));
      const orphans = await attempt(() => filesOf(session, statements.orphans, dataPath, limitMs));
      return { expiry, cleanup, orphans };
    });
  } catch (error) {
    // A lake that cannot be opened skips all three; anything else is a fault that the command reports.
    if (signal?.aborted || !(error instanceof LakeFailure || isAantjeError(error))) throw error;
    const skipped = { state: 'skipped', reason: reasonOf(error) } as const;
    return { expiry: skipped, cleanup: skipped, orphans: skipped };
  }
}
