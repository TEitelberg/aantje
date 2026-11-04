import {
  isArrayOf,
  isCount,
  isExactShape,
  isNullOr,
  isObject,
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
import { isGrowthPoint } from '../stats/protocol';
import type { StorageActionId, StorageData, StorageView } from './model';

type StorageMessage = { readonly type: 'storage'; readonly data: StorageData };

const isTotals = isShape({ count: isCount, sizeBytes: isCount });

const isTable = isShape({
  id: isCount,
  schemaId: isCount,
  schema: isString,
  name: isString,
  files: isCount,
  sizeBytes: isCount,
  rows: isCount,
  approximate: isOptional(isTrue),
  smallFiles: isCount,
});

const isData = isShape({
  connection: isString,
  scope: isReportScope,
  snapshot: isCount,
  readAt: isString,
  storage: isShape({
    dataPath: isNullOr(isString),
    encrypted: (value) => typeof value === 'boolean',
    dataFiles: isTotals,
    deleteFiles: isTotals,
    scheduledForDeletion: isScheduled,
    expirableSnapshots: isExpirable,
  }),
  smallFileBytes: isCount,
  rows: isCount,
  approximate: isOptional(isTrue),
  tableCount: isCount,
  tables: isArrayOf(isTable),
  growth: isArrayOf(isGrowthPoint),
  growthMerged: isOptional(isTrue),
});

/** Guard for the messages the extension sends to the page. */
export function isStorageMessage(value: unknown): value is StorageMessage {
  return isObject(value) && own(value, 'type') === 'storage' && isData(own(value, 'data'));
}

export type StorageAction = ActionMessage & { readonly action: StorageActionId; readonly table?: number };

/** A known action with the table id where one applies and no other field; the extension checks it was sent. */
export const isStorageAction: (value: unknown) => value is StorageAction = actionGuard({
  showStatistics: { table: isCount },
  revealTable: { table: isCount },
  scriptMerge: { table: isCount },
  scriptRewrite: { table: isCount },
  scriptCleanup: {},
  scriptExpire: {},
  showProperties: {},
});

export const isStorageView: (value: unknown) => value is StorageView = isExactShape({
  filter: isString,
}) as (value: unknown) => value is StorageView;
