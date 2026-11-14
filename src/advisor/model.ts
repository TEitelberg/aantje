import type { DeletedFiles, SnapshotId, StorageInfo } from '../catalog/model';
import { MAINTENANCE_LABEL } from '../maintenance/labels';
import { DEFAULT_DELETE_OLDER_THAN } from '../catalog/scheduled';
import type { Card } from '../shell/model';
import { count, files, formatBytes, groupedPlural } from '../shell/model';
import { expirableLine, expirableNote, scheduledLine, scheduledNote } from '../shell/scheduled-text';
import { lakeWide } from '../shell/scope';
import type { ReportScope } from '../shell/scope';
import { percent } from '../shell/numbers';

/** The share of deleted rows from which `ducklake_rewrite_data_files` rewrites a file when `rewrite_delete_threshold` is not set (checked with DuckDB 2.0.0). */
export const DEFAULT_REWRITE_THRESHOLD = 0.95;

// Files below this share of deleted rows are not mentioned, unless the rewrite threshold is lower.
const REWRITE_FLOOR = 0.5;

/** The share of deleted rows from which a file is a rewrite candidate: half, or a lower lake threshold. */
export const rewriteFloor = (policy: Pick<Policy, 'rewrite'>): number =>
  Math.min(REWRITE_FLOOR, policy.rewrite.share);

/** The size that `ducklake_merge_adjacent_files` aims at when `target_file_size` is not set. */
export const DEFAULT_TARGET_FILE_BYTES = 512_000_000;

/** Tables per kind of candidate that the data holds; a list that was cut says so. */
export const CANDIDATE_LIMIT = 100;

/** Files of a dry run whose size is looked up; the figures of a longer list are lower bounds. */
export const SIZED_FILES = 1000;

export const MARKDOWN_RECOMMENDATIONS = 50;

/** `schema.table` of a table that a candidate is about. */
export interface AdvisorTable {
  readonly id: number;
  readonly schemaId: number;
  readonly schema: string;
  readonly name: string;
}

/** What one dry run or listing gave, or why it was not made. */
export type Measured<T> =
  { readonly state: 'measured'; readonly value: T } | { readonly state: 'skipped'; readonly reason: string };

export interface ExpiryMeasure {
  readonly snapshots: number;
  /** The snapshots the dry run lists. */
  readonly expiring: number;
  /** ISO 8601, UTC; null when none expires. */
  readonly oldest: string | null;
  readonly newest: string | null;
}

export interface FileMeasure {
  readonly files: number;
  /** The size of the `sized` files that the store has. */
  readonly bytes: number;
  /** The files whose size was found; fewer than `files` for a long list or a file that is gone. */
  readonly sized: number;
}

interface MergeCandidate {
  readonly table: AdvisorTable;
  readonly files: number;
  readonly smallFiles: number;
  readonly smallBytes: number;
  /** The estimate of the number of data files after a merge, see `estimatedFilesAfterMerge`. */
  readonly estimatedAfter: number;
  /**
   * The files of the table with deleted rows, when some of the small files have them: the merge leaves them alone, so
   * its script rewrites them first. Null when they could not be read: the script then says so.
   */
  readonly deleted?: DeletedFiles | null;
}

interface RewriteCandidate {
  readonly table: AdvisorTable;
  /** Data files in which at least the floor (`rewriteFloor`) of the rows are deleted. */
  readonly files: number;
  /** Of those, the files a rewrite with the threshold of the policy rewrites. */
  readonly atThreshold: number;
  readonly records: number;
  readonly deleted: number;
  readonly sizeBytes: number;
}

interface FlushCandidate {
  readonly table: AdvisorTable;
  readonly rows: number;
}

/** The numbers the advice rests on, each from an option of the lake or the default that is named. */
export interface Policy {
  /** The age for Expire Snapshots, as DuckDB reads an interval (`30 days`). */
  readonly expire: { readonly text: string; readonly source: 'option' | 'default' };
  /** `delete_older_than` as the lake stores it; null when it is not set and DuckLake's own default applies. */
  readonly delete: string | null;
  readonly rewrite: { readonly share: number; readonly source: 'option' | 'default' };
  readonly target: { readonly bytes: number; readonly source: 'option' | 'default' };
  /** Options the lake sets that the advisor cannot read; their default is used. */
  readonly unreadable: readonly string[];
}

/** What the advice is about. Snapshots, expiry and files are lake-wide either way. */
export type AdvisorScope = ReportScope;

/** What the extension sends to the page. */
export interface AdvisorData {
  readonly connection: string;
  readonly scope: AdvisorScope;
  /** The newest snapshot: the dry runs and the facts are about it. */
  readonly snapshot: SnapshotId;
  /** When the data was read (ISO 8601, UTC). */
  readonly readAt: string;
  readonly policy: Policy;
  readonly scheduled: StorageInfo['scheduledForDeletion'];
  readonly expirable: StorageInfo['expirableSnapshots'];
  readonly expiry: Measured<ExpiryMeasure>;
  readonly cleanup: Measured<FileMeasure>;
  readonly orphans: Measured<FileMeasure>;
  /** The ones with the most files first. */
  readonly merge: readonly MergeCandidate[];
  readonly rewrite: readonly RewriteCandidate[];
  readonly flush: readonly FlushCandidate[];
  /** A list of candidates was cut at `CANDIDATE_LIMIT`. */
  readonly more?: true;
  /** The inlined rows of some tables could not be read: `flush` may lack tables. */
  readonly inlinedFailed?: true;
}

/** The note on a page and in a document whose data has `inlinedFailed`. */
export const INLINED_FAILED_NOTE =
  'The inlined rows of some tables could not be read, so Flush Inlined Data may be worth doing for more tables than listed.';

/** A share as the reports write it: `95 %`. */
export const advisorShareText = (share: number): string => percent(share);

/** The rewrite floor as a phrase: `half`, or `30 %` when the lake threshold is lower. */
export const floorText = (floor: number): string =>
  floor === REWRITE_FLOOR ? 'half' : advisorShareText(floor);

/** The size of a dry run's files: exact when every file was found, else a lower bound. */
export function sizeText(measure: FileMeasure): string {
  if (measure.files === 0) return formatBytes(0);
  if (measure.sized === 0) return 'size unknown';
  return `${measure.sized < measure.files ? 'at least ' : ''}${formatBytes(measure.bytes)}`;
}

/**
 * Estimated data files after a merge: small files become target-size files. It counts on the rewrite that the Merge
 * script puts first, so the small files with deleted rows are merged too. A merge keeps partitions apart, so the real
 * number can be higher.
 */
export function estimatedFilesAfterMerge(
  totalFiles: number,
  smallFiles: number,
  smallBytes: number,
  targetBytes: number,
): number {
  const merged = Math.min(smallFiles, Math.max(1, Math.ceil(smallBytes / targetBytes)));
  return totalFiles - smallFiles + merged;
}

const tablesText = (value: number): string => groupedPlural(value, 'table', 'tables');

export function advisorCards(data: AdvisorData): Card[] {
  const lake = (label: string): string => lakeWide(data.scope, label);
  const skipped = (what: string, reason: string): Card => ({
    label: lake(what),
    value: 'not measured',
    detail: reason,
    severity: 'warning',
    hint: reason,
  });
  const expiry = data.expiry;
  const cleanup = data.cleanup;
  const orphans = data.orphans;
  const measures = [cleanup, orphans];
  const reclaim = measures.flatMap((measure) => (measure.state === 'measured' ? [measure.value] : []));
  const partial = measures.some((measure) => measure.state === 'skipped') || reclaim.some(isPartial);
  const reclaimFiles = reclaim.reduce((sum, measure) => sum + measure.files, 0);
  const reclaimBytes = reclaim.reduce((sum, measure) => sum + measure.bytes, 0);
  const fewer = data.merge.reduce((sum, item) => sum + item.files - item.estimatedAfter, 0);
  return [
    expiry.state === 'skipped'
      ? skipped('Snapshots to expire', expiry.reason)
      : {
          label: lake('Snapshots to expire'),
          value: count(expiry.value.expiring),
          detail: `of ${count(expiry.value.snapshots)}, older than ${data.policy.expire.text}`,
          severity: 'ok',
          hint: [
            `The dry run of Expire Snapshots with older_than set to ${data.policy.expire.text} ago`,
            expirableLine(data.expirable),
            expirableNote(data.expirable),
          ]
            .filter(Boolean)
            .join('. '),
        },
    cleanup.state === 'skipped'
      ? skipped('Files to clean up', cleanup.reason)
      : {
          label: lake('Files to clean up'),
          value: count(cleanup.value.files),
          detail: sizeText(cleanup.value),
          severity: 'ok',
          hint: 'The dry run of Clean Up Old Files: files that no snapshot needs and that are old enough by the rule of the lake.',
        },
    orphans.state === 'skipped'
      ? skipped('Orphaned files', orphans.reason)
      : {
          label: lake('Orphaned files'),
          value: count(orphans.value.files),
          detail: sizeText(orphans.value),
          severity: 'ok',
          hint: 'The dry run of Delete Orphaned Files: files in the data path that the catalog does not know.',
        },
    reclaim.length === 0
      ? skipped(
          'Reclaimable space',
          'Neither Clean Up Old Files nor Delete Orphaned Files could be measured.',
        )
      : {
          label: lake('Reclaimable space'),
          value: `${partial ? 'at least ' : ''}${formatBytes(reclaimBytes)}`,
          detail: groupedPlural(reclaimFiles, 'file', 'files'),
          severity: 'ok',
          hint: 'Clean Up Old Files and Delete Orphaned Files together. Expiring snapshots frees nothing by itself: it makes files unnecessary, and Clean Up Old Files deletes them.',
        },
    {
      label: lake('Scheduled for deletion'),
      value: count(data.scheduled.count),
      detail:
        data.scheduled.split === null || data.scheduled.count === 0
          ? 'files that maintenance replaced'
          : `${count(data.scheduled.split.ready)} ready now, ${count(data.scheduled.split.waiting)} waiting`,
      severity: 'ok',
      hint: [scheduledLine(data.scheduled), scheduledNote(data.scheduled)].filter(Boolean).join('. '),
    },
    {
      label: 'Merge candidates',
      value: count(data.merge.length),
      detail:
        data.merge.length === 0
          ? 'no table'
          : `${tablesText(data.merge.length)}, about ${files(fewer)} fewer`,
      severity: 'ok',
      hint: 'Tables with many small files. The number of files after a merge is an estimate.',
    },
    {
      label: 'Rewrite candidates',
      value: count(data.rewrite.length),
      detail: tablesText(data.rewrite.length),
      severity: 'ok',
      hint: `Tables with data files in which at least ${floorText(rewriteFloor(data.policy))} of the rows are deleted.`,
    },
    {
      label: 'Flush candidates',
      value: count(data.flush.length),
      detail: groupedPlural(
        data.flush.reduce((sum, item) => sum + item.rows, 0),
        'inlined row',
        'inlined rows',
      ),
      severity: 'ok',
      hint: 'Tables with many rows inlined in the catalog.',
    },
    {
      label: lake('Expire older than'),
      value: data.policy.expire.text,
      detail: data.policy.expire.source === 'option' ? 'option of the lake' : 'default of the advisor',
      severity: 'ok',
      hint: 'Set the option expire_older_than to change the age that the advisor measures with.',
    },
  ];
}

const isPartial = (measure: FileMeasure): boolean => measure.sized < measure.files;

/** The measurements that were skipped, with the script that does the dry run by hand. */
export function skippedMeasures(
  data: Pick<AdvisorData, 'expiry' | 'cleanup' | 'orphans'>,
): { readonly kind: 'expire' | 'cleanup' | 'orphans'; readonly label: string; readonly reason: string }[] {
  const all = [
    { kind: 'expire', label: MAINTENANCE_LABEL.expire, measure: data.expiry },
    { kind: 'cleanup', label: MAINTENANCE_LABEL.cleanup, measure: data.cleanup },
    { kind: 'orphans', label: MAINTENANCE_LABEL.orphans, measure: data.orphans },
  ] as const;
  return all.flatMap(({ kind, label, measure }) =>
    measure.state === 'skipped' ? [{ kind, label, reason: measure.reason }] : [],
  );
}

/** The policy as sentences for the page and the document. */
export function policyLines(policy: Policy, quote: (text: string) => string = (text) => text): string[] {
  const where = (source: 'option' | 'default', name: string): string =>
    source === 'option' ? `the option ${name} of the lake` : 'the default';
  return [
    `Expire Snapshots: snapshots older than ${policy.expire.text} (${policy.expire.source === 'option' ? 'the option expire_older_than of the lake' : 'the default of the advisor; DuckLake has none'}).`,
    `Clean Up Old Files and Delete Orphaned Files: files older than ${policy.delete === null ? `${DEFAULT_DELETE_OLDER_THAN} (the default of DuckLake, the lake sets no delete_older_than)` : `${quote(policy.delete)} (the option delete_older_than of the lake)`}.`,
    `Rewrite Data Files: files with at least ${advisorShareText(policy.rewrite.share)} of their rows deleted (${where(policy.rewrite.source, 'rewrite_delete_threshold')} of DuckLake).`,
    `Merge Adjacent Files: files of about ${formatBytes(policy.target.bytes)} (${where(policy.target.source, 'target_file_size')} of DuckLake).`,
    ...(policy.unreadable.length === 0
      ? []
      : [
          `The ${groupedPlural(policy.unreadable.length, 'option', 'options')} ${policy.unreadable.join(', ')} of the lake could not be read; the default is used.`,
        ]),
  ];
}
