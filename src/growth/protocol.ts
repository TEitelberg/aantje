import {
  isArrayOf,
  isBoolean,
  isCount,
  isExactShape,
  isFiniteNumber,
  isNullOr,
  isObject,
  isOneOf,
  isOptional,
  isShape,
  isString,
  own,
} from '../guards';
import type { Test } from '../guards';
import { actionGuard } from '../shell/protocol';
import { SCOPED_WINDOW_FIELDS } from '../snapshot-changes/protocol';
import type { GrowthActionId, GrowthActionRequest } from './actions';
import type { GrowthMarkdownView } from './markdown';
import { METRICS } from './model';
import type { GrowthData } from './model';

export type GrowthPageRequest = { readonly type: 'action' } & GrowthActionRequest;

type GrowthMessage = { readonly type: 'growth'; readonly data: GrowthData };

const isInteger = (value: unknown): boolean => isFiniteNumber(value) && Number.isInteger(value);

const isChange = isShape({
  tableId: isCount,
  snapshot: isNullOr(isCount),
  rows: isInteger,
  sizeBytes: isInteger,
  files: isInteger,
  partialFiles: isInteger,
});

const isData = isShape({
  ...SCOPED_WINDOW_FIELDS,
  focus: isNullOr(isCount),
  expired: isOptional(isBoolean),
  tables: isArrayOf(isShape({ id: isCount, schema: isString, name: isString })),
  changes: isArrayOf(isChange),
  inlinedMore: isBoolean,
  inlinedFailed: isBoolean,
});

export function isGrowthMessage(value: unknown): value is GrowthMessage {
  return isObject(value) && own(value, 'type') === 'growth' && isData(own(value, 'data'));
}

const ACTION_FIELDS: Readonly<Record<GrowthActionId, Readonly<Record<string, Test>>>> = {
  showCatalog: { snapshot: isCount },
  query: { snapshot: isCount, table: isCount },
};

/** A known action with exactly its fields; `planAction` checks that they name sent data. */
export const isGrowthAction = actionGuard(ACTION_FIELDS) as (value: unknown) => value is GrowthPageRequest;

/** The page's choices for Open as Markdown; the extension fits them to the data. */
export const isGrowthView: (value: unknown) => value is GrowthMarkdownView = isExactShape({
  table: isOptional(isCount),
  metric: isOneOf(...METRICS),
}) as (value: unknown) => value is GrowthMarkdownView;
