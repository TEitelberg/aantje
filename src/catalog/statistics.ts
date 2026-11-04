import type { Evenness, FileSizeBin, GrowthPoint } from './model';
import { compareText } from '../order';
import { SIZE_BINS } from './queries/statistics';
import { toIsoUtc } from './timestamp';

/** Partitions the statistics name; the others are summed as the rest. */
export const PARTITION_LIMIT = 50;

/** Most partitions read; a table with more gets evenness figures for its largest only. */
export const PARTITION_READ_LIMIT = 10_000;

/** Most statistics rows (one per column and data file) compared to find a minimum and maximum. */
export const RANGE_ROW_LIMIT = 50_000;

/** Most points of the growth chart. */
export const GROWTH_POINT_LIMIT = 500;

/**
 * Coefficient of variation and Gini coefficient of the partition sizes; null below two partitions or when all are
 * empty.
 */
export function evenness(sizes: readonly number[]): Evenness | null {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (sizes.length < 2 || total === 0) {
    return null;
  }
  const count = sizes.length;
  const mean = total / count;
  const variance = sizes.reduce((sum, size) => sum + (size - mean) ** 2, 0) / count;
  // Gini over the sizes in ascending order: 2 * sum(rank * size) / (n * total) - (n + 1) / n
  const weighted = sizes.toSorted((a, b) => a - b).reduce((sum, size, index) => sum + (index + 1) * size, 0);
  return {
    coefficientOfVariation: Math.sqrt(variance) / mean,
    gini: (2 * weighted) / (count * total) - (count + 1) / count,
  };
}

/** The size histogram from the rows of `queries.fileSizeBins`, with empty bins filled in. */
export function sizeHistogram(
  largest: number,
  found: readonly { readonly bin: number; readonly files: number; readonly sizeBytes: number }[],
): FileSizeBin[] {
  if (found.length === 0) {
    return [];
  }
  // Bin k holds files of at least largest / 2^(SIZE_BINS - k) bytes, the query's integer test as a size.
  const from = (bin: number): number => (bin === 0 ? 0 : Math.ceil(largest / 2 ** (SIZE_BINS - bin)));
  return Array.from({ length: SIZE_BINS }, (_, bin) => {
    const hit = found.find((candidate) => candidate.bin === bin);
    return {
      fromBytes: from(bin),
      toBytes: bin === SIZE_BINS - 1 ? largest : from(bin + 1),
      files: hit?.files ?? 0,
      sizeBytes: hit?.sizeBytes ?? 0,
    };
  });
}

export interface GrowthDelta {
  readonly snapshot: number;
  readonly time: string | null;
  readonly files: number;
  readonly sizeBytes: number;
  readonly compaction: boolean;
}

/**
 * The state after each snapshot. More than `limit` snapshots merge in runs into the run's last state; a run with a
 * compaction counts as one.
 */
export function growth(
  deltas: readonly GrowthDelta[],
  limit = GROWTH_POINT_LIMIT,
): { readonly points: GrowthPoint[]; readonly merged: boolean } {
  let files = 0;
  let sizeBytes = 0;
  const states = deltas.map((delta) => {
    files += delta.files;
    sizeBytes += delta.sizeBytes;
    return { snapshot: delta.snapshot, time: delta.time, files, sizeBytes, compaction: delta.compaction };
  });
  if (states.length <= limit) {
    return { points: states, merged: false };
  }
  const run = Math.ceil(states.length / limit);
  const points = Array.from({ length: Math.ceil(states.length / run) }, (_, index) => {
    const group = states.slice(index * run, (index + 1) * run);
    return { ...(group.at(-1) as GrowthPoint), compaction: group.some((state) => state.compaction) };
  });
  return { points, merged: true };
}

type Compare = (a: string, b: string) => number;

const compareNumbers = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);
const compareBigInts = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

// DuckDB orders text by UTF-8 bytes, which differs from UTF-16 order beyond U+FFFF.
const compareBytes: Compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

const compareIntegers: Compare = (a, b) => compareBigInts(BigInt(a), BigInt(b));

// DuckLake writes the infinities as `inf`; `nan` has no place in an order and throws.
function float(text: string): number {
  const infinite = /^(-?)inf(?:inity)?$/i.exec(text);
  const value = infinite ? (infinite[1] ? -Infinity : Infinity) : Number(text);
  if (Number.isNaN(value)) {
    throw new Error(`"${text}" is not a number.`);
  }
  return value;
}

const compareFloats: Compare = (a, b) => compareNumbers(float(a), float(b));

// Decimals have a point and as many digits as the scale says ("-12.50").
const compareDecimals: Compare = (a, b) => {
  const scaled = (text: string): [bigint, number] => {
    const [whole = '', fraction = ''] = text.split('.');
    return [BigInt(`${whole}${fraction}`), fraction.length];
  };
  const [left, leftScale] = scaled(a);
  const [right, rightScale] = scaled(b);
  const scale = Math.max(leftScale, rightScale);
  return compareBigInts(left * 10n ** BigInt(scale - leftScale), right * 10n ** BigInt(scale - rightScale));
};

// DuckLake writes infinite timestamps as `infinity` and `-infinity`.
const instant = (text: string): number =>
  text === 'infinity' ? Infinity : text === '-infinity' ? -Infinity : Date.parse(toIsoUtc(text));

// Compared as instants to the millisecond; the text breaks a tie.
const compareInstants: Compare = (a, b) => compareNumbers(instant(a), instant(b)) || compareText(a, b);

// Undefined for types without a natural text order: blobs, intervals, nested types.
function comparatorOf(type: string): Compare | undefined {
  if (/^u?int(8|16|32|64|128)$/.test(type)) {
    return compareIntegers;
  }
  if (/^float(32|64)$/.test(type)) {
    return compareFloats;
  }
  if (/^decimal\(/.test(type)) {
    return compareDecimals;
  }
  if (type === 'timestamptz') {
    return compareInstants;
  }
  if (/^(date|time|timestamp(_s|_ms|_ns)?|boolean|uuid)$/.test(type)) {
    return compareText;
  }
  return type === 'varchar' || type === 'json' ? compareBytes : undefined;
}

/** Partition values in key order; NULL sorts after every text. */
export function comparePartitionValues(a: readonly (string | null)[], b: readonly (string | null)[]): number {
  for (let key = 0; key < a.length; key++) {
    const left = a[key] ?? null;
    const right = b[key] ?? null;
    if (left !== right) {
      return left === null ? 1 : right === null ? -1 : compareText(left, right);
    }
  }
  return 0;
}
/** The smallest minimum and largest maximum of a column's file statistics; incomparable values are skipped. */
export function foldRange(
  type: string,
  files: readonly { readonly min: string | null; readonly max: string | null }[],
): { readonly min: string | null; readonly max: string | null } {
  const compare = comparatorOf(type);
  if (!compare) {
    return { min: null, max: null };
  }
  const pick = (values: readonly (string | null)[], sign: 1 | -1): string | null => {
    let best: string | null = null;
    for (const value of values) {
      if (value === null) {
        continue;
      }
      try {
        // Comparing a value with itself throws for text that is no value of the type, even the first.
        compare(value, value);
        if (best === null || compare(value, best) * sign < 0) {
          best = value;
        }
      } catch {
        // Not a value of this type; skip it.
      }
    }
    return best;
  };
  return {
    min: pick(
      files.map((file) => file.min),
      1,
    ),
    max: pick(
      files.map((file) => file.max),
      -1,
    ),
  };
}
