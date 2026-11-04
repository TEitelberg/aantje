import type { Row } from '../drivers/driver';
import type {
  CatalogReader,
  ColumnStatistics,
  PartitionBucket,
  PartitioningInfo,
  PartitionStatistics,
  TableStatistics,
} from '../model';
import * as growthQueries from '../queries/growth';
import * as objectQueries from '../queries/objects';
import * as queries from '../queries/statistics';
import {
  PARTITION_LIMIT,
  PARTITION_READ_LIMIT,
  RANGE_ROW_LIMIT,
  comparePartitionValues,
  evenness,
  foldRange,
  growth,
  sizeHistogram,
} from '../statistics';
import { SMALL_FILE_BYTES } from '../thresholds';
import { columnPaths, flatten, readColumns } from './columns';
import { readInfo } from './core';
import { partitioningOf } from './details';
import { growthDeltasOf } from './growth';
import { toNumber, toTextOrNull } from './rows';
import type { Attempt, Run } from './rows';

interface Range {
  readonly min: string | null;
  readonly max: string | null;
}

// Ranges by column id; `partial` when they cover only part of the files.
interface Ranges {
  readonly byColumn: Map<number, Range>;
  readonly partial: boolean;
}

async function partitionStatistics(
  attempt: Attempt,
  tableId: number,
  snapshot: number,
  partitioning: PartitioningInfo,
  signal: AbortSignal | undefined,
): Promise<PartitionStatistics> {
  const keyCount = Math.min(partitioning.columns.length, queries.MAX_PARTITION_KEYS);
  const [rows, earlier] = await Promise.all([
    attempt(
      queries.partitionBuckets(tableId, snapshot, partitioning.id, keyCount, PARTITION_READ_LIMIT + 1),
      signal,
    ),
    attempt(queries.otherPartitionFiles(tableId, snapshot, partitioning.id), signal),
  ]);
  const buckets: PartitionBucket[] = (rows ?? []).slice(0, PARTITION_READ_LIMIT).map((row) => ({
    values: Array.from({ length: keyCount }, (_, key) => toTextOrNull(row[`key${key}`])),
    files: toNumber(row.file_count),
    sizeBytes: toNumber(row.size_bytes),
    rows: toNumber(row.row_count),
  }));
  // Engines order NULL differently and ties have no order, so sort here.
  buckets.sort((a, b) => b.sizeBytes - a.sizeBytes || comparePartitionValues(a.values, b.values));
  const rest = buckets.slice(PARTITION_LIMIT);
  const total = (key: 'files' | 'sizeBytes' | 'rows'): number =>
    rest.reduce((sum, bucket) => sum + bucket[key], 0);
  return {
    partitioning,
    partitions: buckets.slice(0, PARTITION_LIMIT),
    ...(rest.length > 0
      ? {
          rest: {
            partitions: rest.length,
            files: total('files'),
            sizeBytes: total('sizeBytes'),
            rows: total('rows'),
          },
        }
      : {}),
    evenness: evenness(buckets.map((bucket) => bucket.sizeBytes)),
    earlierFiles: earlier?.[0] ? toNumber(earlier[0].file_count) : 0,
    ...((rows?.length ?? 0) > PARTITION_READ_LIMIT ? { partial: true as const } : {}),
    ...(partitioning.columns.length > keyCount
      ? { keysLeftOut: partitioning.columns.length - keyCount }
      : {}),
  };
}

// DuckLake keeps whole-table ranges for the latest state only.
async function latestRanges(
  attempt: Attempt,
  tableId: number,
  signal: AbortSignal | undefined,
): Promise<Ranges> {
  const byColumn = new Map<number, Range>();
  for (const row of (await attempt(queries.tableColumnRanges(tableId), signal)) ?? []) {
    byColumn.set(toNumber(row.column_id), {
      min: toTextOrNull(row.min_value),
      max: toTextOrNull(row.max_value),
    });
  }
  return { byColumn, partial: false };
}

// At an older snapshot: ranges of the visible files, as many as `RANGE_ROW_LIMIT` allows.
async function fileRanges(
  attempt: Attempt,
  tableId: number,
  snapshot: number,
  flat: ReturnType<typeof flatten>,
  signal: AbortSignal | undefined,
): Promise<Ranges> {
  const rows =
    (await attempt(queries.fileColumnRanges(tableId, snapshot, RANGE_ROW_LIMIT + 1), signal)) ?? [];
  const perColumn = new Map<number, Range[]>();
  for (const row of rows.slice(0, RANGE_ROW_LIMIT)) {
    const id = toNumber(row.column_id);
    perColumn.set(id, [
      ...(perColumn.get(id) ?? []),
      { min: toTextOrNull(row.min_value), max: toTextOrNull(row.max_value) },
    ]);
  }
  const byColumn = new Map<number, Range>();
  for (const [id, files] of perColumn) {
    byColumn.set(id, foldRange(flat.find(({ column }) => column.id === id)?.column.type ?? '', files));
  }
  return { byColumn, partial: rows.length > RANGE_ROW_LIMIT };
}

function columnStatistics(
  flat: ReturnType<typeof flatten>,
  nulls: readonly Row[],
  ranges: ReadonlyMap<number, Range>,
): ColumnStatistics[] {
  const counts = new Map(nulls.map((row) => [toNumber(row.column_id), row]));
  return flat.map(({ column, path, exact }): ColumnStatistics => {
    const count = counts.get(column.id);
    // Files without counts leave the sums partial; below a parent that can be missing, the parent counts as NULL.
    const values =
      count && exact && toNumber(count.uncounted_files) === 0
        ? toNumber(count.value_count) + toNumber(count.null_count)
        : 0;
    return {
      id: column.id,
      path,
      type: column.type,
      nullable: column.nullable,
      nullRatio: count && values > 0 ? toNumber(count.null_count) / values : null,
      min: ranges.get(column.id)?.min ?? null,
      max: ranges.get(column.id)?.max ?? null,
    };
  });
}

type StatisticsReads = Pick<CatalogReader, 'tableStatistics'>;

/** Reads the files, partitions, columns and growth of a table. */
export function statisticsReads(run: Run, attempt: Attempt): StatisticsReads {
  return {
    async tableStatistics(tableId, snapshot, signal): Promise<TableStatistics> {
      // Two waves: independent figures first, then those that need the columns or partitioning.
      const [[summary], bins, partitionKeys, tree, nulls, info, deltas] = await Promise.all([
        run(queries.fileSummary(tableId, snapshot), signal),
        run(queries.fileSizeBins(tableId, snapshot), signal),
        attempt(objectQueries.partitionings(tableId, snapshot), signal),
        readColumns(run, tableId, snapshot, signal),
        attempt(queries.columnNulls(tableId, snapshot), signal),
        readInfo(run, signal),
        run(growthQueries.growthDeltas(tableId, snapshot), signal),
      ]);
      const flat = flatten(tree);
      const partitioning = partitioningOf(partitionKeys ?? [], columnPaths(tree));
      const [ranges, partitionStats] = await Promise.all([
        snapshot >= info.latestSnapshot
          ? latestRanges(attempt, tableId, signal)
          : fileRanges(attempt, tableId, snapshot, flat, signal),
        partitioning ? partitionStatistics(attempt, tableId, snapshot, partitioning, signal) : undefined,
      ]);
      const largest = toNumber(summary?.largest);
      const { points, merged } = growth(growthDeltasOf(deltas, tableId));
      return {
        snapshot,
        rows: toNumber(summary?.row_count),
        files: toNumber(summary?.file_count),
        deleteFiles: toNumber(summary?.delete_files),
        dataBytes: toNumber(summary?.data_bytes),
        deleteBytes: toNumber(summary?.delete_bytes),
        ...(toNumber(summary?.partial_files) > 0 ? { approximate: true as const } : {}),
        largestFileBytes: largest,
        smallFiles: toNumber(summary?.small_files),
        smallFileBytes: SMALL_FILE_BYTES,
        sizeHistogram: sizeHistogram(
          largest,
          bins.map((row) => ({
            bin: toNumber(row.bin),
            files: toNumber(row.file_count),
            sizeBytes: toNumber(row.size_bytes),
          })),
        ),
        ...(partitionStats ? { partitioning: partitionStats } : {}),
        columns: columnStatistics(flat, nulls ?? [], ranges.byColumn),
        ...(ranges.partial ? { columnsPartial: true as const } : {}),
        growth: points,
        ...(merged ? { growthMerged: true as const } : {}),
      };
    },
  };
}
