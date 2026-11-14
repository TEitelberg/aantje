import { queryCancelled } from '../catalog/drivers/limits';
import { DEFAULT_EXPIRE_OLDER_THAN } from '../catalog/expirable';
import { globalValue } from '../catalog/model';
import type { CatalogReader, HealthScopeRef, MetadataEntry } from '../catalog/model';
import { LARGE_INLINED_ROWS, hasManySmallFiles } from '../catalog/thresholds';
import type { DataAccess } from '../data/types';
import { LAKE_SCOPE } from '../shell/scope';
import { measureDryRuns } from './measure';
import {
  CANDIDATE_LIMIT,
  DEFAULT_REWRITE_THRESHOLD,
  DEFAULT_TARGET_FILE_BYTES,
  estimatedFilesAfterMerge,
  rewriteFloor,
} from './model';
import type { AdvisorData, AdvisorScope, AdvisorTable, Policy } from './model';

type AdvisorReader = Pick<
  CatalogReader,
  | 'info'
  | 'metadata'
  | 'snapshotCount'
  | 'scheduledForDeletion'
  | 'expirableSnapshots'
  | 'entries'
  | 'maintenanceFacts'
  | 'deleteHeavyTables'
>;

// An interval as DuckDB reads it: whole numbers with a unit. The value goes into a SQL literal, so only this shape passes.
const INTERVAL =
  /^\d{1,6} (?:second|minute|hour|day|week|month|year)s?(?: \d{1,6} (?:second|minute|hour|day|week|month|year)s?)*$/;

/** What the lake sets, as the policy reads it; an unreadable option is named and its default used. */
export function policyOf(metadata: readonly MetadataEntry[]): Policy {
  const option = (name: string): string | undefined =>
    metadata.find((entry) => entry.key === name && entry.scope === null)?.value.trim();
  const unreadable: string[] = [];
  const read = <T>(name: string, parse: (value: string) => T | undefined, fallback: T) => {
    const value = option(name);
    const parsed = value === undefined ? undefined : parse(value);
    if (value !== undefined && parsed === undefined) {
      unreadable.push(name);
    }
    return parsed === undefined
      ? ({ value: fallback, source: 'default' } as const)
      : ({ value: parsed, source: 'option' } as const);
  };
  const expire = read(
    'expire_older_than',
    (value) => (INTERVAL.test(value) ? value : undefined),
    DEFAULT_EXPIRE_OLDER_THAN,
  );
  const rewrite = read(
    'rewrite_delete_threshold',
    (value) => {
      const share = Number(value);
      return value !== '' && share >= 0 && share <= 1 ? share : undefined;
    },
    DEFAULT_REWRITE_THRESHOLD,
  );
  const target = read(
    'target_file_size',
    (value) => (/^\d{1,15}$/.test(value) && Number(value) > 0 ? Number(value) : undefined),
    DEFAULT_TARGET_FILE_BYTES,
  );
  const deleteOlderThan = option('delete_older_than');
  return {
    expire: { text: expire.value, source: expire.source },
    delete: deleteOlderThan === undefined || deleteOlderThan === '' ? null : deleteOlderThan.slice(0, 100),
    rewrite: { share: rewrite.value, source: rewrite.source },
    target: { bytes: target.value, source: target.source },
    unreadable,
  };
}

/**
 * Reads the dry runs of Expire Snapshots, Clean Up Old Files and Delete Orphaned Files at the newest snapshot.
 * Also reads the tables a merge, rewrite or flush would help. Changes nothing.
 */
export async function readAdvisor(
  deps: { readonly reader: AdvisorReader; readonly access: DataAccess },
  connection: string,
  now: Date,
  signal?: AbortSignal,
  scope: AdvisorScope = LAKE_SCOPE,
): Promise<AdvisorData> {
  const { reader, access } = deps;
  // First, so that a catalog that is no DuckLake is reported as such.
  const { latestSnapshot } = await reader.info();
  const [metadata, snapshotCount] = await Promise.all([reader.metadata(), reader.snapshotCount()]);
  const policy = policyOf(metadata);
  const scopeRef: HealthScopeRef = scope.kind === 'schema' ? { schemaId: scope.id } : {};
  // A failed catalog read ends the call at once; the dry runs list the store and must not go on without anybody
  // waiting for them.
  const failed = new AbortController();
  const stop = signal ? AbortSignal.any([signal, failed.signal]) : failed.signal;
  // The catalog is cut at one more than the limit, to tell whether a list was cut.
  const [scheduled, expirable, entries, facts, heavy, measures] = await Promise.all([
    reader.scheduledForDeletion(metadata),
    reader.expirableSnapshots(metadata),
    reader.entries(latestSnapshot),
    reader.maintenanceFacts(scopeRef, CANDIDATE_LIMIT + 1, stop),
    reader.deleteHeavyTables(scopeRef, rewriteFloor(policy), policy.rewrite.share, CANDIDATE_LIMIT + 1, stop),
    measureDryRuns(access, policy, snapshotCount, globalValue(metadata, 'data_path'), stop),
  ]).catch((error: unknown) => {
    failed.abort();
    throw error;
  });
  if (signal?.aborted) {
    throw queryCancelled();
  }
  const tables = new Map<number, AdvisorTable>(
    entries
      .filter((entry) => entry.kind === 'table')
      .map((entry) => [
        entry.id,
        { id: entry.id, schemaId: entry.schemaId, schema: entry.schemaName, name: entry.name },
      ]),
  );
  const named = <T extends { readonly tableId: number }>(
    items: readonly T[],
  ): { item: T; table: AdvisorTable }[] =>
    items.flatMap((item) => {
      const table = tables.get(item.tableId);
      return table ? [{ item, table }] : [];
    });
  const merge = named(
    facts.smallFiles.filter(({ files, small }) => hasManySmallFiles({ files, smallFiles: small })),
  )
    .toSorted((a, b) => b.item.files - a.item.files || a.table.id - b.table.id)
    .map(({ item, table }) => ({
      table,
      files: item.files,
      smallFiles: item.small,
      smallBytes: item.smallBytes,
      estimatedAfter: estimatedFilesAfterMerge(item.files, item.small, item.smallBytes, policy.target.bytes),
      // Null when the figures could not be read (a broken size, a failed read): the scripts then say so.
      ...(item.deleted === null || item.deleted.small > 0 ? { deleted: item.deleted } : {}),
    }));
  const more =
    facts.smallFiles.length > CANDIDATE_LIMIT ||
    heavy.length > CANDIDATE_LIMIT ||
    facts.inlined.length > CANDIDATE_LIMIT;
  return {
    connection,
    scope,
    snapshot: latestSnapshot,
    readAt: now.toISOString(),
    policy,
    scheduled,
    expirable,
    ...measures,
    merge: merge.slice(0, CANDIDATE_LIMIT),
    rewrite: named(heavy)
      .slice(0, CANDIDATE_LIMIT)
      .map(({ item, table }) => ({
        table,
        files: item.files,
        atThreshold: item.atThreshold,
        records: item.records,
        deleted: item.deleted,
        sizeBytes: item.sizeBytes,
      })),
    flush: named(facts.inlined.filter(({ rows }) => rows > LARGE_INLINED_ROWS))
      .toSorted((a, b) => b.item.rows - a.item.rows || a.table.id - b.table.id)
      .slice(0, CANDIDATE_LIMIT)
      .map(({ item, table }) => ({ table, rows: item.rows })),
    ...(more ? { more: true as const } : {}),
    ...(facts.inlinedFailed ? { inlinedFailed: true as const } : {}),
  };
}
