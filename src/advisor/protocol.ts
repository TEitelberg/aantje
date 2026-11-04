import {
  isArrayOf,
  isCount,
  isFiniteNumber,
  isNullOr,
  isObject,
  isOneOf,
  isOptional,
  isShape,
  isString,
  isTrue,
  own,
} from '../guards';
import { isExpirable } from '../catalog/expirable';
import { isScheduled } from '../catalog/scheduled';
import { actionGuard } from '../shell/protocol';
import { isReportScope } from '../shell/scope';
import type { ActionMessage } from '../shell/protocol';
import type { AdvisorActionId } from './actions';
import type { AdvisorData } from './model';

export type AdvisorMessage = { readonly type: 'advisor'; readonly data: AdvisorData };

const isTable = isShape({ id: isCount, schemaId: isCount, schema: isString, name: isString });

const isMeasured = (isValue: (value: unknown) => boolean) => (value: unknown) =>
  isShape({ state: isOneOf('measured'), value: isValue })(value) ||
  isShape({ state: isOneOf('skipped'), reason: isString })(value);

const isFileMeasure = isShape({ files: isCount, bytes: isCount, sized: isCount });

const isSource = isOneOf('option', 'default');

const isData = isShape({
  connection: isString,
  scope: isReportScope,
  snapshot: isCount,
  readAt: isString,
  policy: isShape({
    expire: isShape({ text: isString, source: isSource }),
    delete: isNullOr(isString),
    rewrite: isShape({ share: isFiniteNumber, source: isSource }),
    target: isShape({ bytes: isCount, source: isSource }),
    unreadable: isArrayOf(isString),
  }),
  scheduled: isScheduled,
  expirable: isExpirable,
  expiry: isMeasured(
    isShape({
      snapshots: isCount,
      expiring: isCount,
      oldest: isNullOr(isString),
      newest: isNullOr(isString),
    }),
  ),
  cleanup: isMeasured(isFileMeasure),
  orphans: isMeasured(isFileMeasure),
  merge: isArrayOf(
    isShape({
      table: isTable,
      files: isCount,
      smallFiles: isCount,
      smallBytes: isCount,
      estimatedAfter: isCount,
    }),
  ),
  rewrite: isArrayOf(
    isShape({
      table: isTable,
      files: isCount,
      atThreshold: isCount,
      records: isCount,
      deleted: isCount,
      sizeBytes: isCount,
    }),
  ),
  flush: isArrayOf(isShape({ table: isTable, rows: isCount })),
  more: isOptional(isTrue),
});

/** Guard for the messages the extension sends to the page. */
export function isAdvisorMessage(value: unknown): value is AdvisorMessage {
  return isObject(value) && own(value, 'type') === 'advisor' && isData(own(value, 'data'));
}

export type AdvisorAction = ActionMessage & { readonly action: AdvisorActionId; readonly table?: number };

/** A known action with the table id where one applies and no other field; the extension checks it was sent. */
export const isAdvisorAction: (value: unknown) => value is AdvisorAction = actionGuard({
  scriptExpire: {},
  scriptCleanup: {},
  scriptOrphans: {},
  scriptMerge: { table: isCount },
  scriptRewrite: { table: isCount },
  scriptFlush: { table: isCount },
  showStatistics: { table: isCount },
  revealTable: { table: isCount },
  showStorage: {},
  checkHealth: {},
  maintenanceScript: {},
});
