import {
  isArrayOf,
  isBoolean,
  isCount,
  isExactShape,
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
import type { ParquetData } from './model';

type ParquetMessage = { readonly type: 'parquet'; readonly data: ParquetData };

const isStats = isShape({
  min: isNullOr(isString),
  max: isNullOr(isString),
  nulls: isNullOr(isCount),
  distinct: isNullOr(isCount),
});

const isTarget = isShape({
  path: isString,
  lake: isOptional(
    isShape({
      tableId: isCount,
      table: isString,
      fileId: isCount,
      snapshot: isCount,
      beginSnapshot: isCount,
      rows: isNullOr(isCount),
      sizeBytes: isNullOr(isCount),
      encrypted: isBoolean,
      belowDataPath: isBoolean,
    }),
  ),
});

const isData = isShape({
  connection: isString,
  name: isString,
  state: isOneOf('read', 'encrypted', 'outside', 'failed'),
  error: isOptional(isString),
  target: isTarget,
  files: isOptional(
    isArrayOf(isShape({ group: isOneOf('largest', 'newest', 'smallest'), target: isTarget })),
  ),
  file: isOptional(
    isShape({
      sizeBytes: isNullOr(isCount),
      rows: isCount,
      rowGroups: isCount,
      createdBy: isNullOr(isString),
      formatVersion: isNullOr(isCount),
      encryption: isNullOr(isString),
      footerBytes: isNullOr(isCount),
    }),
  ),
  keyValues: isArrayOf(isShape({ key: isString, value: isString })),
  columns: isArrayOf(
    isShape({
      path: isString,
      physicalType: isNullOr(isString),
      logicalType: isNullOr(isString),
      fieldId: isNullOr(isCount),
      lakeColumn: isNullOr(isString),
      compression: isString,
      encodings: isString,
      dictionary: isBoolean,
      bloomFilter: isBoolean,
      compressedBytes: isCount,
      uncompressedBytes: isCount,
    }),
  ),
  rowGroups: isArrayOf(
    isShape({
      id: isCount,
      rows: isCount,
      compressedBytes: isNullOr(isCount),
      uncompressedBytes: isCount,
      stats: isArrayOf(isStats),
    }),
  ),
  probe: isOptional(
    isShape({ column: isCount, value: isString, excluded: isArrayOf(isCount), rowGroups: isCount }),
  ),
  probeError: isOptional(isString),
});

/** Guard for the messages the extension sends to the page. */
export function isParquetMessage(value: unknown): value is ParquetMessage {
  return isObject(value) && own(value, 'type') === 'parquet' && isData(own(value, 'data'));
}

export type ParquetAction = ActionMessage & {
  readonly action: 'bloomProbe' | 'copy' | 'openFile';
  /** The index of a column in `columns`: the one to probe, or the one whose row groups the copy lists. */
  readonly column?: number;
  /** The id of a data file of the drop-down, to inspect instead. */
  readonly file?: number;
};

/**
 * A probe names the index of a column, never a value: the extension asks for the value itself. Another data file is
 * named by its id, never by its path: the extension opens only a file that it listed.
 */
export const isParquetAction: (value: unknown) => value is ParquetAction = actionGuard({
  bloomProbe: { column: isCount },
  copy: { column: isCount },
  openFile: { file: isCount },
});

/** What Open as Markdown and Copy may name: the column whose row groups the document lists. */
export interface ParquetView {
  readonly column: number;
}

export const isParquetView: (value: unknown) => value is ParquetView = isExactShape({
  column: isCount,
}) as (value: unknown) => value is ParquetView;
