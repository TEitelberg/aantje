import {
  isArrayOf,
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
import { isSnapshot } from '../snapshot-report/protocol';
import { actionGuard } from '../shell/protocol';
import { isReportScope } from '../shell/scope';
import type { GrowthActionRequest } from './actions';
import type { GrowthMarkdownView } from './markdown';
import { METRICS } from './model';
import type { GrowthData } from './model';

export type GrowthPageRequest = { readonly type: 'action' } & GrowthActionRequest;

type GrowthMessage = { readonly type: 'growth'; readonly data: GrowthData };

const isInteger = (value: unknown): boolean => isFiniteNumber(value) && Number.isInteger(value);
const isFlag = (value: unknown): boolean => typeof value === 'boolean';

const isChange = isShape({
  tableId: isCount,
  snapshot: isNullOr(isCount),
  rows: isInteger,
  sizeBytes: isInteger,
  files: isInteger,
  partialFiles: isInteger,
});

const isData = isShape({
  connection: isString,
  scope: isReportScope,
  focus: isNullOr(isCount),
  latest: isCount,
  snapshots: isArrayOf(isSnapshot),
  more: isFlag,
  read: isOptional(isCount),
  expired: isOptional(isFlag),
  tables: isArrayOf(isShape({ id: isCount, schema: isString, name: isString })),
  changes: isArrayOf(isChange),
  inlinedMore: isFlag,
  inlinedFailed: isFlag,
});

export function isGrowthMessage(value: unknown): value is GrowthMessage {
  return isObject(value) && own(value, 'type') === 'growth' && isData(own(value, 'data'));
}

/** A known action with exactly its fields; `planAction` checks that they name sent data. */
export const isGrowthAction = actionGuard({
  showCatalog: { snapshot: isCount },
  query: { snapshot: isCount, table: isCount },
}) as (value: unknown) => value is GrowthPageRequest;

/** The page's choices for Open as Markdown; the extension fits them to the data. */
export const isGrowthView: (value: unknown) => value is GrowthMarkdownView = isExactShape({
  table: isOptional(isCount),
  metric: isOneOf(...METRICS),
}) as (value: unknown) => value is GrowthMarkdownView;
