import {
  isArrayOf,
  isBoolean,
  isCount,
  isFiniteNumber,
  isNullOr,
  isObject,
  isOptional,
  isShape,
  isString,
  isTrue,
} from '../guards';
import { isGrowthPoint } from '../shell/file-growth';
import type { StatisticsData } from './model';

export type StatisticsMessage = { readonly type: 'statistics'; readonly data: StatisticsData };

const isBin = isShape({ fromBytes: isCount, toBytes: isCount, files: isCount, sizeBytes: isCount });
const isBucket = isShape({
  values: isArrayOf(isNullOr(isString)),
  files: isCount,
  sizeBytes: isCount,
  rows: isCount,
});
const isPartitioning = isShape({
  partitioning: isShape({
    id: isCount,
    beginSnapshot: isCount,
    endSnapshot: isNullOr(isCount),
    columns: isArrayOf(isShape({ columnId: isCount, path: isArrayOf(isString), transform: isString })),
  }),
  partitions: isArrayOf(isBucket),
  rest: isOptional(isShape({ partitions: isCount, files: isCount, sizeBytes: isCount, rows: isCount })),
  evenness: isNullOr(isShape({ coefficientOfVariation: isFiniteNumber, gini: isFiniteNumber })),
  earlierFiles: isCount,
  partial: isOptional(isTrue),
  keysLeftOut: isOptional(isCount),
  unread: isOptional(isTrue),
});
const isColumn = isShape({
  id: isCount,
  path: isArrayOf(isString),
  type: isString,
  nullable: isBoolean,
  nullRatio: isNullOr((value) => isFiniteNumber(value) && (value as number) >= 0 && (value as number) <= 1),
  min: isNullOr(isString),
  max: isNullOr(isString),
});
const isStatistics = isShape({
  snapshot: isCount,
  rows: isCount,
  files: isCount,
  deleteFiles: isCount,
  dataBytes: isCount,
  deleteBytes: isCount,
  approximate: isOptional(isTrue),
  largestFileBytes: isCount,
  smallFiles: isCount,
  smallFileBytes: isCount,
  sizeHistogram: isArrayOf(isBin),
  partitioning: isOptional(isPartitioning),
  columns: isArrayOf(isColumn),
  columnsPartial: isOptional(isTrue),
  columnsUnread: isOptional(isTrue),
  growth: isArrayOf(isGrowthPoint),
  growthMerged: isOptional(isTrue),
});

/** Guard for the messages the extension sends to the page. */
export function isStatisticsMessage(value: unknown): value is StatisticsMessage {
  return (
    isObject(value) &&
    value.type === 'statistics' &&
    isShape({ table: isString, connection: isString, statistics: isStatistics })(value.data)
  );
}
