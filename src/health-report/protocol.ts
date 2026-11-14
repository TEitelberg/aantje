import { CHECKS, HEALTH_GROUPS } from '../health/model';
import { FIX_STEPS } from '../maintenance/steps';
import {
  isArrayOf,
  isBoolean,
  isCount,
  isObject,
  isOneOf,
  isOptional,
  isShape,
  isString,
  isTrue,
  own,
} from '../guards';
import type { Test } from '../guards';
import { actionGuard } from '../shell/protocol';
import type { ActionMessage } from '../shell/protocol';
import { MAX_DEEP_FILES, SEVERITIES } from './model';
import type { FindingActionId, HealthData, HealthFilter, PanelEvent } from './model';

/** The whole state of the run, or the events that happened since the last message. */
export type HealthMessage = {
  readonly type: 'health';
  readonly data: HealthData | { readonly events: readonly PanelEvent[] };
};

const isDeepFiles: Test = (value) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_DEEP_FILES;

const isScope: Test = (value) =>
  isObject(value) &&
  (own(value, 'kind') === 'lake' ||
    (own(value, 'kind') === 'schema' && isCount(own(value, 'id')) && isString(own(value, 'name'))) ||
    (own(value, 'kind') === 'table' &&
      isCount(own(value, 'id')) &&
      isString(own(value, 'schema')) &&
      isString(own(value, 'name'))));

const isFinding: Test = isShape({
  id: isString,
  check: isOneOf(...Object.keys(CHECKS)),
  severity: isOneOf(...SEVERITIES),
  group: isOneOf(...HEALTH_GROUPS),
  scope: isScope,
  title: isString,
  detail: isString,
  cause: isString,
  fix: isString,
  inspectSql: isOptional(isString),
  fixSql: isOptional(isString),
  fixStep: isOptional(isOneOf(...FIX_STEPS)),
  settingKey: isOptional(isString),
  objectKey: isOptional(isString),
  suggestion: isOptional(
    isShape({ endpoint: isString, urlStyle: isOptional(isOneOf('path')), source: isString }),
  ),
});

const isStatus: Test = isShape({
  group: isOneOf(...HEALTH_GROUPS),
  state: isOneOf('running', 'done', 'skipped', 'failed'),
  reason: isOptional(isString),
  message: isOptional(isString),
  truncated: isOptional(isTrue),
  omitted: isOptional(isCount),
  notChecked: isOptional(isCount),
});

const isSummary: Test = isShape({
  errors: isCount,
  warnings: isCount,
  infos: isCount,
  omitted: isCount,
  elapsedMs: isCount,
  cancelled: isBoolean,
});

const isEvent: Test = (value) => {
  if (!isObject(value)) {
    return false;
  }
  switch (own(value, 'type')) {
    case 'group':
      return isStatus(own(value, 'status'));
    case 'progress':
      return isShape({ group: isOneOf(...HEALTH_GROUPS), done: isCount, total: isCount })(value);
    case 'finding':
      return isFinding(own(value, 'finding'));
    case 'summary':
      return isSummary(own(value, 'summary'));
    case 'snapshot':
      return isCount(own(value, 'snapshot'));
    case 'failed':
      return isString(own(value, 'message'));
    default:
      return false;
  }
};

const isData: Test = isShape({
  connection: isString,
  scope: isScope,
  depth: isOneOf('quick', 'deep'),
  deepFiles: isDeepFiles,
  status: isOneOf('idle', 'running', 'done', 'cancelled', 'failed'),
  snapshot: isOptional(isCount),
  groups: isArrayOf(isStatus),
  progress: isOptional(isShape({ group: isOneOf(...HEALTH_GROUPS), done: isCount, total: isCount })),
  findings: isArrayOf(isFinding),
  summary: isOptional(isSummary),
  message: isOptional(isString),
});

/** The page checks what it is sent as the extension checks what comes out of the page. */
export function isHealthMessage(value: unknown): value is HealthMessage {
  if (!isObject(value) || own(value, 'type') !== 'health') {
    return false;
  }
  const data = own(value, 'data');
  return (
    isData(data) ||
    (isObject(data) && Object.keys(data).length === 1 && isArrayOf(isEvent)(own(data, 'events')))
  );
}

/** Whether a message is the whole state and not a batch of events. */
export const isWholeData = (data: HealthMessage['data']): data is HealthData => !('events' in data);

export type HealthAction = ActionMessage & {
  readonly action: 'run' | 'cancel' | 'maintenanceScript' | FindingActionId;
  readonly depth?: 'quick' | 'deep';
  readonly deepFiles?: number;
  readonly finding?: string;
};

const ofFinding = { finding: isString };

/** An action of the page; a finding action is offered again by that finding, so the page cannot ask for more. */
export const isHealthAction: (value: unknown) => value is HealthAction = actionGuard({
  run: { depth: isOneOf('quick', 'deep'), deepFiles: isDeepFiles },
  cancel: {},
  maintenanceScript: {},
  inspect: ofFinding,
  setting: ofFinding,
  useEndpoint: ofFinding,
  setCredentials: ofFinding,
  editConnection: ofFinding,
  setStorageSignIn: ofFinding,
  script: ofFinding,
  revealTable: ofFinding,
  showStatistics: ofFinding,
});

/** What Open as Markdown carries: the filter of the page. */
export const isHealthView: (value: unknown) => value is HealthFilter = isShape({
  text: isString,
  severities: isArrayOf(isOneOf(...SEVERITIES)),
  groups: isArrayOf(isOneOf(...HEALTH_GROUPS)),
}) as (value: unknown) => value is HealthFilter;
