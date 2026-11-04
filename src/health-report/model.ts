import { DEFAULT_LIMITS, HEALTH_GROUPS, compareFindings } from '../health/model';
import type {
  CheckId,
  FindingScope,
  GroupStatus,
  HealthEvent,
  HealthFinding,
  HealthGroup,
  HealthSeverity,
  HealthSummary,
} from '../health/model';
import type { MaintenanceKind } from '../maintenance';
import { MAINTENANCE_LABEL } from '../maintenance-labels';
import { count, plural } from '../shell/model';
import { formatDuration } from '../shell/numbers';
import type { Card } from '../shell/model';

export const DEFAULT_DEEP_FILES = 200;
/** The most files a page may ask the deep check to open. */
export const MAX_DEEP_FILES = 10_000;

export const SEVERITIES: readonly HealthSeverity[] = ['error', 'warning', 'info'];
export const SEVERITY_LABEL: Readonly<Record<HealthSeverity, string>> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
};
/** A sign for each severity, so that colour is never the only carrier. */
export const SEVERITY_SIGN: Readonly<Record<HealthSeverity, string>> = {
  error: '✖',
  warning: '⚠',
  info: 'ℹ',
};
export const GROUP_LABEL: Readonly<Record<HealthGroup, string>> = {
  catalog: 'Catalog',
  connection: 'Connection',
  storage: 'Storage',
  deep: 'Deep',
};

// `failed` is a run that could not start (settings, credentials), not a finding.
type HealthRunState = 'idle' | 'running' | 'done' | 'cancelled' | 'failed';

/** Everything the page shows; the extension holds the same and sends it whole when a page asks for it. */
export interface HealthData {
  readonly connection: string;
  readonly scope: FindingScope;
  /** The choice of the next run (the controls of the page start from it). */
  readonly depth: 'quick' | 'deep';
  readonly deepFiles: number;
  readonly status: HealthRunState;
  /** The snapshot that was checked, the newest one; known when the run has read the catalog. */
  readonly snapshot?: number;
  /** The groups that have reported, in the order of `HEALTH_GROUPS`. */
  readonly groups: readonly GroupStatus[];
  /** The file the deep check is at. */
  readonly progress?: { readonly group: HealthGroup; readonly done: number; readonly total: number };
  /** In the order they were found; the page and the document sort them. */
  readonly findings: readonly HealthFinding[];
  readonly summary?: HealthSummary;
  /** Why the run could not start (`failed`). */
  readonly message?: string;
}

/** What happens during a run: the events of the check, the snapshot it read, and a failure to start. */
export type PanelEvent =
  | HealthEvent
  | { readonly type: 'snapshot'; readonly snapshot: number }
  | { readonly type: 'failed'; readonly message: string };

/** The data of a panel that has not run, or whose run starts. */
export function freshData(
  connection: string,
  scope: FindingScope,
  choice: { readonly depth: 'quick' | 'deep'; readonly deepFiles: number },
  status: 'idle' | 'running',
): HealthData {
  return { connection, scope, ...choice, status, groups: [], findings: [] };
}

/** The data after one event. The extension and the page both apply the events, so that they hold the same. */
export function applyHealthEvent(data: HealthData, event: PanelEvent): HealthData {
  switch (event.type) {
    case 'group': {
      const { status } = event;
      const { progress, ...rest } = data;
      return {
        ...rest,
        groups: HEALTH_GROUPS.flatMap((group) =>
          group === status.group ? [status] : data.groups.filter((known) => known.group === group),
        ),
        ...(progress && !(progress.group === status.group && status.state !== 'running') ? { progress } : {}),
      };
    }
    case 'progress':
      return { ...data, progress: { group: event.group, done: event.done, total: event.total } };
    case 'finding':
      return data.findings.some(({ id }) => id === event.finding.id)
        ? data
        : { ...data, findings: [...data.findings, event.finding] };
    case 'summary': {
      const { progress: _progress, ...rest } = data;
      return { ...rest, summary: event.summary, status: event.summary.cancelled ? 'cancelled' : 'done' };
    }
    case 'snapshot':
      return { ...data, snapshot: event.snapshot };
    case 'failed': {
      const { progress: _progress, ...rest } = data;
      return { ...rest, status: 'failed', message: event.message };
    }
  }
}

export const applyEvents = (data: HealthData, events: readonly PanelEvent[]): HealthData =>
  events.reduce(applyHealthEvent, data);

export function healthScopeLabel(scope: FindingScope): string {
  if (scope.kind === 'lake') return 'Lakehouse';
  if (scope.kind === 'schema') return `Schema ${scope.name}`;
  return scope.schema === '' ? scope.name : `${scope.schema}.${scope.name}`;
}

/** One panel per connection and scope. JSON, so that no combination of ids can imitate another key. */
export const healthKey = (connectionId: string, scope: FindingScope): string =>
  JSON.stringify(scope.kind === 'lake' ? [connectionId, 'lake'] : [connectionId, scope.kind, scope.id]);

export const healthTitle = (connection: string, scope: FindingScope): string =>
  scope.kind === 'lake' ? `Health · ${connection}` : `Health · ${connection} · ${healthScopeLabel(scope)}`;

/** What the user chose to see; `severities` and `groups` are the ones that are shown. */
export interface HealthFilter {
  readonly text: string;
  readonly severities: readonly HealthSeverity[];
  readonly groups: readonly HealthGroup[];
}

export const DEFAULT_FILTER: HealthFilter = { text: '', severities: SEVERITIES, groups: HEALTH_GROUPS };

const searchable = (finding: HealthFinding): string =>
  [
    finding.title,
    finding.detail,
    finding.cause,
    finding.fix,
    finding.check,
    finding.objectKey ?? '',
    healthScopeLabel(finding.scope),
  ]
    .join('\n')
    .toLowerCase();

/** The findings that pass the filter, in the order of the report. */
export function matchingFindings(findings: readonly HealthFinding[], filter: HealthFilter): HealthFinding[] {
  const text = filter.text.trim().toLowerCase();
  return findings
    .filter(
      (finding) =>
        filter.severities.includes(finding.severity) &&
        filter.groups.includes(finding.group) &&
        (text === '' || searchable(finding).includes(text)),
    )
    .toSorted(compareFindings);
}

interface FindingSection {
  readonly label: string;
  readonly findings: readonly HealthFinding[];
}

/** The label of the section of the lake's findings; a schema report says that they concern the whole lake. */
export const lakeSectionLabel = (reportScope: FindingScope): string =>
  reportScope.kind === 'schema' ? 'Lakehouse (lake-wide)' : healthScopeLabel({ kind: 'lake' });

/** The lakehouse first, then the schema and the tables by name; the findings keep their order. */
export function sections(findings: readonly HealthFinding[], lakeLabel = 'Lakehouse'): FindingSection[] {
  const byLabel = new Map<string, HealthFinding[]>();
  for (const finding of findings) {
    const label = finding.scope.kind === 'lake' ? lakeLabel : healthScopeLabel(finding.scope);
    byLabel.set(label, [...(byLabel.get(label) ?? []), finding]);
  }
  return [...byLabel]
    .map(([label, list]) => ({ label, findings: list }))
    .toSorted((a, b) => {
      const lake = (section: FindingSection): number => (section.findings[0]?.scope.kind === 'lake' ? 0 : 1);
      return lake(a) - lake(b) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
    });
}

/** The findings of each severity and group, to put the count on the filter buttons. */
export function counts(findings: readonly HealthFinding[]): {
  readonly severity: Readonly<Record<HealthSeverity, number>>;
  readonly group: Readonly<Record<HealthGroup, number>>;
} {
  return {
    severity: Object.fromEntries(
      SEVERITIES.map((severity) => [severity, findings.filter((item) => item.severity === severity).length]),
    ) as Record<HealthSeverity, number>,
    group: Object.fromEntries(
      HEALTH_GROUPS.map((group) => [group, findings.filter((item) => item.group === group).length]),
    ) as Record<HealthGroup, number>,
  };
}

export { formatDuration };

/** How a group stands, in words and with a sign. */
export function groupLine(status: GroupStatus | undefined, progress: HealthData['progress']): string {
  if (!status) {
    return 'Waiting';
  }
  const at =
    progress?.group === status.group ? ` (${count(progress.done)} of ${count(progress.total)} files)` : '';
  switch (status.state) {
    case 'running':
      return `Running${at}...`;
    case 'done':
      return '✔ Done';
    case 'skipped':
      return `– Skipped: ${status.reason ?? 'not run'}`;
    case 'failed':
      return `✖ Failed: ${status.message ?? 'unknown error'}`;
  }
}

/** Notes on what a cap or a gap left out, one per group that has something to say. */
export function limitNotes(groups: readonly GroupStatus[]): string[] {
  return groups.flatMap((status) => {
    const label = GROUP_LABEL[status.group];
    return [
      ...(status.truncated ? [`${label}: a limit was reached, so not everything was looked at.`] : []),
      ...(status.notChecked
        ? [
            status.group === 'catalog'
              ? `${label}: ${plural(status.notChecked, 'check could', 'checks could')} not run on this catalog.`
              : `${label}: ${plural(status.notChecked, 'file was', 'files were')} not checked.`,
          ]
        : []),
      ...(status.omitted
        ? [
            `${label}: ${plural(status.omitted, 'more finding was', 'more findings were')} counted and not listed (at most ${DEFAULT_LIMITS.findingsPerCheck} per check are reported).`,
          ]
        : []),
    ];
  });
}

const CHECKED: Readonly<Record<HealthGroup, string>> = {
  catalog: 'the catalog for contradictions and for maintenance that is due',
  connection: 'the connection and the settings against the data path',
  storage: 'that every file the catalog lists is in the store, and the files the catalog does not know',
  deep: 'the Parquet footers of the files (readable, row count, columns)',
};

/** What a finished run looked at and what it did not, for the healthy state and the document. */
export function coverage(data: HealthData): { readonly checked: string[]; readonly notChecked: string[] } {
  const state = (group: HealthGroup): GroupStatus | undefined =>
    data.groups.find((status) => status.group === group);
  return {
    checked: HEALTH_GROUPS.filter((group) => state(group)?.state === 'done').map((group) => CHECKED[group]),
    notChecked: [
      ...HEALTH_GROUPS.flatMap((group) => {
        const status = state(group);
        if (status?.state === 'skipped') {
          return [`${GROUP_LABEL[group]}: ${status.reason ?? 'not run'}`];
        }
        return status?.state === 'failed'
          ? [`${GROUP_LABEL[group]}: failed, ${status.message ?? 'unknown error'}`]
          : [];
      }),
      ...limitNotes(data.groups),
    ],
  };
}

type Verdict = 'idle' | 'running' | 'failed' | 'problems' | 'incomplete' | 'healthy';

/** What to tell the user at the top of the list. Infos are no problems. */
export function verdict(data: HealthData): Verdict {
  if (data.status === 'idle' || data.status === 'running' || data.status === 'failed') {
    return data.status;
  }
  if (data.findings.some((finding) => finding.severity !== 'info')) {
    return 'problems';
  }
  return data.status === 'cancelled' || data.groups.some((status) => status.state === 'failed')
    ? 'incomplete'
    : 'healthy';
}

/** The key figures of a run that has a summary. */
export function healthCards(data: HealthData): Card[] {
  const { summary } = data;
  if (!summary) {
    return [];
  }
  const notChecked = data.groups.reduce((sum, status) => sum + (status.notChecked ?? 0), 0);
  const truncated = data.groups.filter((status) => status.truncated).length;
  return [
    {
      label: 'Errors',
      value: count(summary.errors),
      severity: summary.errors > 0 ? 'error' : 'ok',
    },
    {
      label: 'Warnings',
      value: count(summary.warnings),
      severity: summary.warnings > 0 ? 'warning' : 'ok',
    },
    { label: 'Infos', value: count(summary.infos), severity: 'ok' },
    { label: 'Duration', value: formatDuration(summary.elapsedMs), severity: 'ok' },
    {
      label: 'Checked snapshot',
      value: data.snapshot === undefined ? 'not read' : `@${data.snapshot}`,
      severity: 'ok',
    },
    {
      label: 'Not checked',
      value: count(notChecked + summary.omitted),
      ...(notChecked + summary.omitted > 0 || truncated > 0
        ? {
            detail: [
              ...(notChecked > 0 ? [plural(notChecked, 'file or check', 'files or checks')] : []),
              ...(summary.omitted > 0 ? [`${count(summary.omitted)} findings not listed`] : []),
              ...(truncated > 0 ? [`${plural(truncated, 'limit', 'limits')} reached`] : []),
            ].join(', '),
          }
        : {}),
      severity: truncated > 0 || notChecked + summary.omitted > 0 ? 'warning' : 'ok',
    },
  ];
}

export type FindingActionId =
  'inspect' | 'setting' | 'useEndpoint' | 'setCredentials' | 'script' | 'revealTable' | 'showStatistics';

interface ScriptEntry {
  readonly kind: MaintenanceKind;
  /** `table`: the script is for the table of the finding; `lake`: for the whole lake. */
  readonly level: 'lake' | 'table';
  /** The name of the entry in the Maintenance menu. */
  readonly label: string;
  /** Said in the description of the button besides "nothing runs". */
  readonly warning?: string;
}

const SCRIPTS: Readonly<Partial<Record<CheckId, ScriptEntry>>> = {
  'catalog.cleanup-overdue': { kind: 'cleanup', level: 'lake', label: MAINTENANCE_LABEL.cleanup },
  'catalog.cleanup-pending': { kind: 'cleanup', level: 'lake', label: MAINTENANCE_LABEL.cleanup },
  'catalog.many-snapshots': { kind: 'expire', level: 'lake', label: MAINTENANCE_LABEL.expire },
  'catalog.small-files': { kind: 'merge', level: 'table', label: MAINTENANCE_LABEL.merge },
  'catalog.large-inlined-data': { kind: 'flush', level: 'table', label: MAINTENANCE_LABEL.flush },
  'storage.file-orphaned': {
    kind: 'orphans',
    level: 'lake',
    label: MAINTENANCE_LABEL.orphans,
    warning:
      'A writer that is running at the moment may have uploaded these files and not committed yet; deleting them breaks its commit',
  },
};

/** Whether the findings include one that a script of the Maintenance menu fixes. */
export const hasMaintenanceScript = (findings: readonly HealthFinding[]): boolean =>
  findings.some((finding) => finding.fixSql !== undefined && finding.fixStep !== undefined);

/** The script for a finding; a table script needs a finding of a table. */
export function healthScriptOf(finding: HealthFinding): ScriptEntry | undefined {
  const entry = SCRIPTS[finding.check];
  return entry && (entry.level === 'lake' || finding.scope.kind === 'table') ? entry : undefined;
}

const CREDENTIAL_CHECKS: readonly CheckId[] = [
  'connection.credentials-missing',
  'connection.store-access-denied',
  'connection.endpoint-not-set',
];

/** The actions that a finding offers; the extension checks a request against this list again. */
export function actionsOf(finding: HealthFinding): FindingActionId[] {
  return [
    ...(finding.inspectSql === undefined ? [] : (['inspect'] as const)),
    ...(finding.check === 'connection.endpoint-not-set' && finding.suggestion
      ? (['useEndpoint'] as const)
      : []),
    ...(CREDENTIAL_CHECKS.includes(finding.check) ? (['setCredentials'] as const) : []),
    ...(finding.settingKey === undefined ? [] : (['setting'] as const)),
    ...(healthScriptOf(finding) ? (['script'] as const) : []),
    ...(finding.scope.kind === 'table' ? (['revealTable', 'showStatistics'] as const) : []),
  ];
}

const tally = (data: HealthData): string => {
  const of = (severity: HealthSeverity): number =>
    data.findings.filter((finding) => finding.severity === severity).length;
  const parts = [
    ...(of('error') > 0 ? [plural(of('error'), 'error', 'errors')] : []),
    ...(of('warning') > 0 ? [plural(of('warning'), 'warning', 'warnings')] : []),
    ...(of('info') > 0 ? [plural(of('info'), 'info', 'infos')] : []),
  ];
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? 'nothing');
};

/** The sentence at the top of the list, from the verdict and the numbers. */
export function verdictText(data: HealthData): string {
  switch (verdict(data)) {
    case 'idle':
      return 'The check has not run yet.';
    case 'running':
      return 'The check is running. The list shows what it has found so far.';
    case 'failed':
      return `The check could not run: ${data.message ?? 'unknown error'}`;
    case 'problems':
      return `Found ${tally(data)}.${data.status === 'cancelled' ? ' The check was cancelled, so there may be more.' : ''}`;
    case 'incomplete':
      return data.status === 'cancelled'
        ? 'The check was cancelled. No problem was found in the part that ran.'
        : 'No problem was found, but a group of checks failed. See what was not checked.';
    case 'healthy':
      return 'No problems found.';
  }
}
