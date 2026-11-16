import {
  isArrayOf,
  isBoolean,
  isCount,
  isFiniteNumber,
  isNullOr,
  isObject,
  isOneOf,
  isOptional,
  isShape,
  isString,
  own,
} from '../guards';
import { actionGuard } from '../shell/protocol';
import type { ActionMessage } from '../shell/protocol';
import { ICEBERG_ACTIONS } from './model';
import type { IcebergActionId, IcebergData } from './model';

type IcebergMessage = { readonly type: 'iceberg'; readonly data: IcebergData };

const PROBLEMS = [
  'lake-dropped',
  'iceberg-missing',
  'iceberg-replaced',
  'iceberg-ahead',
  'lake-newer',
  'not-checked',
] as const;

const isRow = isShape({
  schema: isString,
  table: isString,
  problems: isArrayOf(isOneOf(...PROBLEMS)),
  copiedSnapshot: isFiniteNumber,
  snapshotsBehind: isCount,
  lakeChangedAt: isNullOr(isString),
  icebergRemembered: isNullOr(isString),
  icebergCurrent: isNullOr(isString),
  rows: isNullOr(isCount),
  converted: isArrayOf(isString),
  checkError: isNullOr(isString),
  iceberg: isOptional(isString),
});

const isData = isShape({
  connection: isString,
  target: isShape({ id: isString, name: isString, warehouse: isString, endpoint: isString }),
  inSync: isBoolean,
  newest: isFiniteNumber,
  checkedAt: isString,
  copiedAt: isString,
  icebergError: isNullOr(isString),
  tables: isArrayOf(isRow),
  added: isArrayOf(isShape({ schema: isString, table: isString })),
  actions: isArrayOf(isOneOf(...ICEBERG_ACTIONS)),
});

/** Guard for the messages the extension sends to the page. */
export function isIcebergMessage(value: unknown): value is IcebergMessage {
  return isObject(value) && own(value, 'type') === 'iceberg' && isData(own(value, 'data'));
}

export type IcebergAction = ActionMessage & { readonly action: IcebergActionId };

/** A known action with no field; the extension checks that it was offered. */
export const isIcebergAction: (value: unknown) => value is IcebergAction = actionGuard({
  copyAgain: {},
  forget: {},
});
