import type { HealthFinding } from '../health/model';
import { maintenanceScriptOf } from '../health/maintenance-script';
import type { MaintenanceKind } from '../maintenance';
import { actionsOf, healthScriptOf } from './model';
import type { FindingActionId, HealthData } from './model';
import type { HealthAction } from './protocol';

export interface TableTarget {
  readonly id: number;
  readonly schema: string;
  readonly name: string;
}

/** What a request from the page asks for, checked against the data that the extension holds. */
export type HealthPlan =
  | { readonly action: 'run'; readonly depth: 'quick' | 'deep'; readonly deepFiles: number }
  | { readonly action: 'cancel' }
  | { readonly action: 'maintenanceScript'; readonly text: string }
  | { readonly action: 'inspect'; readonly sql: string }
  | { readonly action: 'setting'; readonly key: string }
  | { readonly action: 'setCredentials' }
  | {
      readonly action: 'useEndpoint';
      readonly endpoint: string;
      readonly urlStyle?: 'path';
      /** The environment variable the endpoint came from; the question names it. */
      readonly source: string;
    }
  | { readonly action: 'revealTable' | 'showStatistics'; readonly table: TableTarget }
  | {
      readonly action: 'script';
      readonly kind: MaintenanceKind;
      /** The table of a script for a table; none for a script of the lake. */
      readonly table?: TableTarget;
    };

interface FindingRequest {
  readonly finding: HealthFinding;
  readonly running: boolean;
  readonly table: TableTarget | undefined;
}

// The two actions that write settings or credentials wait for the run to end.
const FINDING_PLANS: Record<FindingActionId, (request: FindingRequest) => HealthPlan | undefined> = {
  inspect: ({ finding }) =>
    finding.inspectSql === undefined ? undefined : { action: 'inspect', sql: finding.inspectSql },
  setting: ({ finding }) =>
    finding.settingKey === undefined ? undefined : { action: 'setting', key: finding.settingKey },
  setCredentials: ({ finding, running }) =>
    !running && actionsOf(finding).includes('setCredentials') ? { action: 'setCredentials' } : undefined,
  useEndpoint: ({ finding, running }) => {
    const { suggestion } = finding;
    return !running && suggestion && actionsOf(finding).includes('useEndpoint')
      ? {
          action: 'useEndpoint',
          endpoint: suggestion.endpoint,
          ...(suggestion.urlStyle ? { urlStyle: suggestion.urlStyle } : {}),
          source: suggestion.source,
        }
      : undefined;
  },
  script: ({ finding, table }) => {
    const entry = healthScriptOf(finding);
    return (
      entry && {
        action: 'script',
        kind: entry.kind,
        ...(entry.level === 'table' && table ? { table } : {}),
      }
    );
  },
  revealTable: ({ table }) => table && { action: 'revealTable', table },
  showStatistics: ({ table }) => table && { action: 'showStatistics', table },
};

/** The plan for a request, or undefined when the data does not offer it. */
export function planHealthAction(data: HealthData, message: HealthAction): HealthPlan | undefined {
  const running = data.status === 'running';
  if (message.action === 'run') {
    return running || message.depth === undefined || message.deepFiles === undefined
      ? undefined
      : { action: 'run', depth: message.depth, deepFiles: message.deepFiles };
  }
  if (message.action === 'cancel') {
    return running ? { action: 'cancel' } : undefined;
  }
  if (message.action === 'maintenanceScript') {
    const text = running ? undefined : maintenanceScriptOf(data.findings);
    return text === undefined ? undefined : { action: 'maintenanceScript', text };
  }
  const finding = data.findings.find(({ id }) => id === message.finding);
  if (!finding) {
    return undefined;
  }
  const { scope } = finding;
  const table = scope.kind === 'table' ? { id: scope.id, schema: scope.schema, name: scope.name } : undefined;
  return FINDING_PLANS[message.action]({ finding, running, table });
}

/** The modal question before the endpoint is written: it names both settings, their values and where the value came from. */
export function endpointQuestion(plan: Extract<HealthPlan, { readonly action: 'useEndpoint' }>): {
  readonly message: string;
  readonly detail: string;
  readonly accept: string;
} {
  const settings = plan.urlStyle
    ? `aantje.s3.endpoint to "${plan.endpoint}" and aantje.s3.urlStyle to "${plan.urlStyle}"`
    : `aantje.s3.endpoint to "${plan.endpoint}"`;
  return {
    message: `Set ${settings} in your user settings?`,
    detail: `The value comes from the environment variable ${plan.source} of the extension host. aantje sends its S3 requests, with your S3 credentials, to this address: make sure it is your object store. Both are machine settings. The check runs again afterwards.`,
    accept: 'Write Settings',
  };
}
