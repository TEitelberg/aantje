// Find Last Good Snapshot: walks back from the newest snapshot to the newest one at which the checks pass. Files are
// never changed, so a file that is missing or broken makes every snapshot bad that needs it: the store is compared
// once, and a snapshot that needs a bad file is passed over without asking the catalog. The catalog rows a later write
// broke are checked snapshot by snapshot. Read-only like the health check.
import { globalValue } from '../catalog/model';
import type { ConsistencyCheck, SnapshotId, SnapshotInfo, StoredFile } from '../catalog/model';
import { DEFAULT_LIMITS } from './model';
import type { CheckId, HealthScope } from './model';
import { runHealthCheck } from './run';
import type { HealthDeps } from './run-context';
import { neededBy } from './storage-checks';

/** The snapshots looked at by default, newest first. */
export const DEFAULT_SNAPSHOT_LIMIT = 500;
/** The files a verdict names; the others are counted. */
export const NAMED_FILES = 20;
// Rows read per consistency check of a snapshot; the verdict counts all.
const SAMPLES = 10;
// Every lost file is a finding of the quick check here, not the first 50 of each check.
const ALL_FINDINGS = 1_000_000;

const BAD_FILE_CHECKS: readonly CheckId[] = ['storage.file-missing', 'storage.file-size-mismatch'];

export interface SnapshotRef {
  readonly id: SnapshotId;
  /** ISO 8601 UTC. */
  readonly time: string;
  readonly author: string | null;
  readonly commitMessage: string | null;
}

/** A missing or broken file that a snapshot needs. */
export interface BadFile {
  readonly kind: 'data' | 'delete';
  readonly id: number;
  readonly location: string | null;
  readonly table: string | null;
  readonly problem: 'missing' | 'size';
}

/** What makes a snapshot bad: the bad files it needs, or the catalog checks its rows break. */
export interface SnapshotVerdict {
  readonly snapshot: SnapshotRef;
  /** At most `NAMED_FILES`; `fileCount` counts them all. */
  readonly files: readonly BadFile[];
  readonly fileCount: number;
  readonly problems: readonly { readonly check: ConsistencyCheck; readonly count: number }[];
}

export interface LastGoodResult {
  readonly newest: SnapshotId;
  /** The newest snapshot at which the checks pass; null when none of those looked at passes. */
  readonly good: SnapshotRef | null;
  /** The snapshot right after the good one (the oldest looked at when none passed), and what was found there. */
  readonly firstBad: SnapshotVerdict | null;
  /** The snapshots looked at. */
  readonly checked: number;
  readonly limit: number;
  /** The catalog has older snapshots than the limit let the walk look at. */
  readonly more: boolean;
  /** Whether the store was compared, how many files are bad, and else why not. */
  readonly files:
    { readonly checked: true; readonly bad: number } | { readonly checked: false; readonly reason: string };
  readonly cancelled: boolean;
}

export interface LastGoodRun {
  readonly signal?: AbortSignal;
  /** Called before each snapshot: `done` of `total` looked at. */
  readonly onProgress?: (done: number, total: number) => void;
}

const refOf = (snapshot: SnapshotInfo): SnapshotRef => ({
  id: snapshot.id,
  time: snapshot.time,
  author: snapshot.author,
  commitMessage: snapshot.commitMessage,
});

// The files of the quick check's findings: `storage.file-missing:data:12` is the data file 12.
async function badFiles(
  deps: HealthDeps,
  scope: HealthScope,
  newest: SnapshotId,
  signal: AbortSignal | undefined,
): Promise<{ files: (StoredFile & { problem: BadFile['problem'] })[]; reason?: string }> {
  const report = await runHealthCheck(
    deps,
    { scope, depth: 'quick', snapshot: newest, limits: { findingsPerCheck: ALL_FINDINGS } },
    { ...(signal ? { signal } : {}) },
  );
  const storage = report.groups.find((group) => group.group === 'storage');
  if (storage?.state !== 'done') {
    return { files: [], reason: storage?.reason ?? storage?.message ?? 'The store was not compared.' };
  }
  const keys = new Map<string, BadFile['problem']>();
  for (const finding of report.findings) {
    if (BAD_FILE_CHECKS.includes(finding.check)) {
      keys.set(
        finding.id.slice(finding.check.length + 1),
        finding.check === 'storage.file-missing' ? 'missing' : 'size',
      );
    }
  }
  if (keys.size === 0) return { files: [] };
  const scopeRef =
    scope.kind === 'table'
      ? { tableId: scope.tableId }
      : scope.kind === 'schema'
        ? { schemaId: scope.schemaId }
        : {};
  const dataPath = globalValue(await deps.reader.metadata(), 'data_path');
  const places = await deps.reader.fileLocations(scopeRef, dataPath, DEFAULT_LIMITS.storageFiles, signal);
  return {
    files: places.files.flatMap((file) => {
      const problem = keys.get(`${file.kind}:${file.id}`);
      return problem ? [{ ...file, problem }] : [];
    }),
  };
}

const named = (file: StoredFile & { problem: BadFile['problem'] }): BadFile => ({
  kind: file.kind,
  id: file.id,
  location: file.location,
  table: file.schema === null || file.table === null ? null : `${file.schema}.${file.table}`,
  problem: file.problem,
});

/** Walks back from the newest snapshot, at most `limit` snapshots, to the newest one at which the checks pass. */
export async function findLastGood(
  deps: HealthDeps,
  scope: HealthScope,
  limit: number,
  run: LastGoodRun = {},
): Promise<LastGoodResult> {
  const { signal } = run;
  const { reader } = deps;
  const newest = (await reader.info()).latestSnapshot;
  // One more tells whether the catalog has older snapshots than the walk looks at.
  const snapshots = await reader.snapshots(limit + 1);
  const considered = snapshots.slice(0, limit);
  const bad = await badFiles(deps, scope, newest, signal);
  const scopeRef =
    scope.kind === 'table'
      ? { tableId: scope.tableId }
      : scope.kind === 'schema'
        ? { schemaId: scope.schemaId }
        : {};
  let good: SnapshotRef | null = null;
  let firstBad: SnapshotVerdict | null = null;
  let checked = 0;
  for (const [index, snapshot] of considered.entries()) {
    if (signal?.aborted) break;
    run.onProgress?.(index, considered.length);
    checked++;
    const files = bad.files.filter((file) => neededBy(file, snapshot.id));
    // A snapshot that needs a bad file is bad whatever its catalog rows say.
    const problems =
      files.length > 0
        ? []
        : (await reader.consistency(scopeRef, newest, SAMPLES, signal, snapshot.id)).problems.map(
            ({ check, count }) => ({ check, count }),
          );
    if (files.length === 0 && problems.length === 0) {
      good = refOf(snapshot);
      break;
    }
    firstBad = {
      snapshot: refOf(snapshot),
      files: files.slice(0, NAMED_FILES).map(named),
      fileCount: files.length,
      problems,
    };
  }
  return {
    newest,
    good,
    firstBad,
    checked,
    limit,
    more: snapshots.length > limit,
    files:
      bad.reason === undefined
        ? { checked: true, bad: bad.files.length }
        : { checked: false, reason: bad.reason },
    cancelled: signal?.aborted === true,
  };
}
