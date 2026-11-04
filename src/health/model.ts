import type { SnapshotId } from '../catalog/model';
import { compareText } from '../order';

export type HealthSeverity = 'error' | 'warning' | 'info';

/** The check groups in run and display order. */
export const HEALTH_GROUPS = ['catalog', 'connection', 'storage', 'deep'] as const;
export type HealthGroup = (typeof HEALTH_GROUPS)[number];

export type HealthScope =
  | { readonly kind: 'lake' }
  | { readonly kind: 'schema'; readonly schemaId: number }
  | { readonly kind: 'table'; readonly tableId: number };

/** Where a finding is, and what a report is about: the lake as a whole, one schema or one table. */
export type FindingScope =
  | { readonly kind: 'lake' }
  | { readonly kind: 'schema'; readonly id: number; readonly name: string }
  | { readonly kind: 'table'; readonly id: number; readonly schema: string; readonly name: string };

/** What a run may read and report; `HealthRequest.limits` overrides each default. */
export interface HealthLimits {
  /** Most findings reported per check; the rest are counted in `omitted`. */
  readonly findingsPerCheck: number;
  /** Catalog files the storage check compares and store keys it lists; more skips the check. */
  readonly storageFiles: number;
  /** Files whose Parquet footer the deep check reads. */
  readonly deepFiles: number;
}

export const DEFAULT_LIMITS: HealthLimits = { findingsPerCheck: 50, storageFiles: 100_000, deepFiles: 200 };

export interface HealthRequest {
  readonly scope: HealthScope;
  /** `quick`: catalog, connection and a store listing (no file opened). `deep` adds the footers. */
  readonly depth: 'quick' | 'deep';
  /** The snapshot the user looks at. It only names the table of a table scope (a schema is named at the newest snapshot); checks read the newest snapshot. */
  readonly snapshot: SnapshotId;
  readonly limits?: Partial<HealthLimits>;
}

/** The checks; every finding of a check has one of its severities. */
export const CHECKS = {
  'catalog.spec-version': { group: 'catalog', severities: ['error'] },
  'catalog.spec-version-newer': { group: 'catalog', severities: ['info'] },
  'catalog.data-path-missing': { group: 'catalog', severities: ['error'] },
  'catalog.snapshot-gaps': { group: 'catalog', severities: ['info'] },
  'catalog.many-snapshots': { group: 'catalog', severities: ['info'] },
  'catalog.files-without-table': { group: 'catalog', severities: ['error'] },
  'catalog.files-unknown-partitioning': { group: 'catalog', severities: ['warning'] },
  'catalog.delete-files-without-data-file': { group: 'catalog', severities: ['error'] },
  'catalog.stats-without-column': { group: 'catalog', severities: ['warning'] },
  'catalog.partition-values-without-partitioning': { group: 'catalog', severities: ['warning'] },
  'catalog.partition-columns-without-partitioning': { group: 'catalog', severities: ['warning'] },
  'catalog.sort-expressions-without-sort-order': { group: 'catalog', severities: ['warning'] },
  'catalog.tables-without-schema': { group: 'catalog', severities: ['error'] },
  'catalog.views-without-schema': { group: 'catalog', severities: ['error'] },
  'catalog.tables-without-columns': { group: 'catalog', severities: ['error'] },
  'catalog.negative-counts': { group: 'catalog', severities: ['error'] },
  'catalog.delete-count-over-records': { group: 'catalog', severities: ['error'] },
  'catalog.files-without-size': { group: 'catalog', severities: ['warning'] },
  'catalog.snapshot-range-invalid': { group: 'catalog', severities: ['error'] },
  'catalog.row-ids-overlap': { group: 'catalog', severities: ['error'] },
  'catalog.cleanup-overdue': { group: 'catalog', severities: ['warning'] },
  'catalog.cleanup-pending': { group: 'catalog', severities: ['info'] },
  'catalog.small-files': { group: 'catalog', severities: ['info', 'warning'] },
  'catalog.large-inlined-data': { group: 'catalog', severities: ['info'] },
  'catalog.auto-compact-off': { group: 'catalog', severities: ['info'] },
  'connection.catalog-unreachable': { group: 'connection', severities: ['error'] },
  'connection.engine-unavailable': { group: 'connection', severities: ['error'] },
  'connection.attach-failed': { group: 'connection', severities: ['error'] },
  'connection.local-path-missing': { group: 'connection', severities: ['error'] },
  'connection.relative-data-path': { group: 'connection', severities: ['warning'] },
  'connection.credentials-missing': { group: 'connection', severities: ['warning'] },
  'connection.endpoint-not-set': { group: 'connection', severities: ['warning', 'error'] },
  'connection.url-style-vhost-ip': { group: 'connection', severities: ['warning'] },
  'connection.endpoint-with-path': { group: 'connection', severities: ['warning'] },
  'connection.endpoint-cleartext': { group: 'connection', severities: ['warning'] },
  'connection.store-access-denied': { group: 'connection', severities: ['error'] },
  'connection.store-bucket-missing': { group: 'connection', severities: ['error'] },
  'connection.store-host-unresolved': { group: 'connection', severities: ['error'] },
  'connection.store-unreachable': { group: 'connection', severities: ['error'] },
  'connection.store-ssl-mismatch': { group: 'connection', severities: ['error'] },
  'connection.store-not-found': { group: 'connection', severities: ['error'] },
  'connection.store-failed': { group: 'connection', severities: ['error'] },
  'storage.file-missing': { group: 'storage', severities: ['error', 'warning'] },
  'storage.file-size-mismatch': { group: 'storage', severities: ['error', 'warning'] },
  'storage.file-orphaned': { group: 'storage', severities: ['info'] },
  'storage.nothing-found': { group: 'storage', severities: ['error'] },
  'deep.file-unreadable': { group: 'deep', severities: ['error'] },
  'deep.row-count-mismatch': { group: 'deep', severities: ['error'] },
  'deep.columns-unknown': { group: 'deep', severities: ['warning'] },
} as const satisfies Record<string, { group: HealthGroup; severities: readonly HealthSeverity[] }>;

export type CheckId = keyof typeof CHECKS;

/** The steps of a maintenance script in the order they have to run: an option first, since a table with `auto_compact` false is skipped by the compaction. */
export const FIX_STEPS = ['option', 'compact', 'expire', 'cleanup', 'orphans'] as const;
export type FixStep = (typeof FIX_STEPS)[number];

export interface HealthFinding {
  /** Stable for the same check and object (`storage.file-missing:data:12`) across runs. */
  readonly id: string;
  readonly check: CheckId;
  readonly severity: HealthSeverity;
  readonly group: HealthGroup;
  readonly scope: FindingScope;
  /** What is wrong, in one sentence. */
  readonly title: string;
  /** What was found, with the numbers. */
  readonly detail: string;
  readonly cause: string;
  /** What to do; aantje only suggests, it changes nothing. */
  readonly fix: string;
  /** SQL that shows the evidence. */
  readonly inspectSql?: string;
  /** SQL that fixes the finding; aantje only shows it. */
  readonly fixSql?: string;
  /** Where `fixSql` belongs in a script for all findings. */
  readonly fixStep?: FixStep;
  /** An `aantje.*` setting, without the `aantje.` prefix, to look at. */
  readonly settingKey?: string;
  readonly objectKey?: string;
  /** An S3 endpoint the extension host environment names; the panel offers to write it into the settings. */
  readonly suggestion?: EndpointSuggestion;
}

/** The `aantje.s3.endpoint` and `aantje.s3.urlStyle` values a finding suggests, and the endpoint's source. */
export interface EndpointSuggestion {
  readonly endpoint: string;
  /** Only for a non-AWS store. */
  readonly urlStyle?: 'path';
  /** The environment variable name. */
  readonly source: string;
}

type GroupState = 'running' | 'done' | 'skipped' | 'failed';

export interface GroupStatus {
  readonly group: HealthGroup;
  readonly state: GroupState;
  /** Why the group did not run (`skipped`). */
  readonly reason?: string;
  /** What went wrong (`failed`), free of secrets. */
  readonly message?: string;
  /** A cap was reached (files, findings of a check), so the group saw less than exists. */
  readonly truncated?: true;
  /** Findings counted but not reported because their check reached `findingsPerCheck`. */
  readonly omitted?: number;
  /** Files (for the catalog, checks) left out without any finding. */
  readonly notChecked?: number;
}

export interface HealthSummary {
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  /** Sum of `omitted` over the groups. */
  readonly omitted: number;
  readonly elapsedMs: number;
  /** The run was cancelled; unfinished groups are `skipped`. */
  readonly cancelled: boolean;
}

export type HealthEvent =
  | { readonly type: 'group'; readonly status: GroupStatus }
  | { readonly type: 'progress'; readonly group: HealthGroup; readonly done: number; readonly total: number }
  | { readonly type: 'finding'; readonly finding: HealthFinding }
  | { readonly type: 'summary'; readonly summary: HealthSummary };

export interface HealthReport {
  readonly request: HealthRequest;
  /** The newest snapshot, which was checked; undefined when the catalog was unreadable. */
  readonly snapshot?: SnapshotId;
  /** In `HEALTH_GROUPS` order. */
  readonly groups: readonly GroupStatus[];
  /** Ordered by group, severity (error first), check, object, so the same catalog gives the same list. */
  readonly findings: readonly HealthFinding[];
  readonly summary: HealthSummary;
}

const SEVERITY_ORDER: Record<HealthSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Report order: group, severity, check, table, id. */
export function compareFindings(a: HealthFinding, b: HealthFinding): number {
  const table = ({ scope }: HealthFinding): string => {
    if (scope.kind === 'lake') return '';
    return scope.kind === 'schema' ? scope.name : `${scope.schema}.${scope.name}`;
  };
  return (
    HEALTH_GROUPS.indexOf(a.group) - HEALTH_GROUPS.indexOf(b.group) ||
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    compareText(a.check, b.check) ||
    compareText(table(a), table(b)) ||
    compareText(a.id, b.id)
  );
}
