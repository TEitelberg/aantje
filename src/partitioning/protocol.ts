import {
  isArrayOf,
  isCount,
  isFiniteNumber,
  isNullOr,
  isObject,
  isOptional,
  isShape,
  isString,
  own,
} from '../guards';
import { actionGuard } from '../shell/protocol';
import type { ActionMessage } from '../shell/protocol';
import type { PartitionData } from './model';

type PartitionMessage = { readonly type: 'partitioning'; readonly data: PartitionData };

const isUse = isShape({ queries: isCount, equality: isCount, range: isCount, join: isCount, other: isCount });

const isData = isShape({
  connection: isString,
  table: isShape({
    id: isCount,
    schemaId: isCount,
    schema: isString,
    name: isString,
    snapshot: isCount,
    rows: isCount,
    sizeBytes: isCount,
    files: isCount,
  }),
  current: isShape({ partitioning: isNullOr(isString), sortOrder: isNullOr(isString) }),
  targetFileBytes: isCount,
  history: isShape({ statements: isCount, queries: isCount, tableQueries: isCount }),
  filters: isArrayOf(isShape({ column: isString, use: isUse })),
  measures: isArrayOf(isShape({ column: isString, type: isString, distinct: isCount, nulls: isCount })),
  candidates: isArrayOf(
    isShape({
      column: isString,
      transform: isString,
      keys: isArrayOf(isString),
      partitions: isCount,
      rowsPerPartition: isFiniteNumber,
      bytesPerPartition: isFiniteNumber,
      filesPerPartition: isCount,
      fileBytes: isFiniteNumber,
      largestShare: isOptional(isFiniteNumber),
      reasons: isArrayOf(isString),
      risks: isArrayOf(isString),
      score: isFiniteNumber,
    }),
  ),
  sortOrder: isOptional(isShape({ column: isString, reason: isString })),
  measureError: isOptional(isString),
});

/** Guard for the messages the extension sends to the page. */
export function isPartitionMessage(value: unknown): value is PartitionMessage {
  return isObject(value) && own(value, 'type') === 'partitioning' && isData(own(value, 'data'));
}

export type PartitionAction = ActionMessage & {
  readonly action: 'openScript' | 'sortScript' | 'showStatistics';
  /** The index of a candidate in `candidates`. */
  readonly candidate?: number;
};

/** The page names a candidate by its index, never keys or SQL; the extension writes the script from its own data. */
export const isPartitionAction: (value: unknown) => value is PartitionAction = actionGuard({
  openScript: { candidate: isCount },
  sortScript: {},
  showStatistics: {},
});
