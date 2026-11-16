import { foldIdentifier, sqlType } from '../catalog/ddl';
import type { ColumnInfo } from '../catalog/model';
import type { RowKind } from '../data/types';

/** One side of a compare: a table of a connection at the snapshot its tree shows. */
export interface CompareSide {
  readonly connectionId: string;
  readonly connectionName: string;
  readonly schema: string;
  readonly table: string;
  readonly snapshot: number;
}

/** A column that both tables have, matched by name the way DuckDB compares names. */
export interface MatchedColumn {
  /** The name in the source; the grid and the script use it. */
  readonly source: string;
  readonly target: string;
  /** SQL types, as `CAST` takes them. */
  readonly sourceType: string;
  readonly targetType: string;
}

/** Which columns are compared, and which are left out and why. */
export interface ColumnPlan {
  /** In the order of the source. */
  readonly compared: readonly MatchedColumn[];
  readonly onlyInSource: readonly string[];
  readonly onlyInTarget: readonly string[];
  /** Both tables have them, but the type of the target does not cast to the type of the source. */
  readonly notCast: readonly MatchedColumn[];
}

/** The columns of both tables by name: A to Z match in either case, other letters only themselves. */
export function matchColumns(
  source: readonly ColumnInfo[],
  target: readonly ColumnInfo[],
): { matched: MatchedColumn[]; onlyInSource: string[]; onlyInTarget: string[] } {
  const targets = new Map(target.map((column) => [foldIdentifier(column.name), column]));
  const matched: MatchedColumn[] = [];
  const onlyInSource: string[] = [];
  for (const column of source) {
    const other = targets.get(foldIdentifier(column.name));
    if (other) {
      matched.push({
        source: column.name,
        target: other.name,
        sourceType: sqlType(column),
        targetType: sqlType(other),
      });
    } else {
      onlyInSource.push(column.name);
    }
  }
  const found = new Set(matched.map((column) => foldIdentifier(column.target)));
  const onlyInTarget = target.filter((column) => !found.has(foldIdentifier(column.name))).map((c) => c.name);
  return { matched, onlyInSource, onlyInTarget };
}

export type ColumnMatch = ReturnType<typeof matchColumns>;

/**
 * Whether the SQL type of a column can go into a statement: words, numbers, spaces, `,()[]` and quoted names. The type
 * comes from the catalog, which may be hostile; a text with `;`, a comment or a string is never used in a cast. A doubled
 * quote inside a quoted name matches as two quoted parts in a row, so the pattern never backtracks.
 */
export const isSafeType = (type: string): boolean => /^(?:[\w ,()[\]]|"[^"]*")+$/.test(type);

/** Whether the target's column is read through a cast to the type of the source. */
export const isCast = (column: MatchedColumn): boolean => column.sourceType !== column.targetType;

/** The plan of the compare: the matched columns whose types cast are compared, the others are listed. */
export function planColumns(match: ColumnMatch, casts: (column: MatchedColumn) => boolean): ColumnPlan {
  return {
    compared: match.matched.filter((column) => !isCast(column) || casts(column)),
    notCast: match.matched.filter((column) => isCast(column) && !casts(column)),
    onlyInSource: match.onlyInSource,
    onlyInTarget: match.onlyInTarget,
  };
}

/**
 * The key the picker proposes, as names of the source: the remembered one, else the columns named `id` or ending in
 * `_id`. A remembered column that the tables no longer share is dropped.
 */
export function proposedKey(
  compared: readonly MatchedColumn[],
  remembered: readonly string[] | undefined,
): string[] {
  const names = compared.map((column) => column.source);
  if (remembered !== undefined) {
    const kept = new Set(remembered.map(foldIdentifier));
    return names.filter((name) => kept.has(foldIdentifier(name)));
  }
  return names.filter((name) => /^id$|_id$/.test(foldIdentifier(name)));
}

export interface CompareCounts {
  readonly onlyInSource: number;
  readonly onlyInTarget: number;
  /** With a key only: rows of the same key whose other columns differ. */
  readonly different: number;
  readonly equal: number;
}

export const differences = (counts: CompareCounts): number =>
  counts.onlyInSource + counts.onlyInTarget + counts.different;

/** The rows of the grid for all differences: one per row of one side, two for a row that differs. */
export const gridRowCount = (counts: CompareCounts): number =>
  counts.onlyInSource + counts.onlyInTarget + 2 * counts.different;

const rows = (count: number): string => `${count} ${count === 1 ? 'row' : 'rows'}`;

/** `2 rows only in the source, 1 only in the target, 3 differ, 120 equal`. */
export function countsText(counts: CompareCounts, keyed: boolean): string {
  return [
    `${rows(counts.onlyInSource)} only in the source`,
    `${counts.onlyInTarget} only in the target`,
    ...(keyed ? [`${counts.different} ${counts.different === 1 ? 'differs' : 'differ'}`] : []),
    `${counts.equal} equal`,
  ].join(', ');
}

/** `key "id", "region"` or `whole rows`. */
export const keyText = (key: readonly string[]): string =>
  key.length === 0 ? 'whole rows' : `key ${key.map((name) => JSON.stringify(name)).join(', ')}`;

/**
 * What a compare of whole rows means for the rows on both sides: a row that changed is one row only in the source and
 * one only in the target. Empty when the compare had a key or found no row on one of the sides.
 */
export function pairingNote(counts: CompareCounts, key: readonly string[]): string {
  return key.length === 0 && counts.onlyInSource > 0 && counts.onlyInTarget > 0
    ? 'Without a key, a row that changed shows as one row only in the source and one only in the target; key columns pair them.'
    : '';
}

/** Why a key cannot be used: it repeats; a column that tells the versions of a row apart would make it a key. */
export function repeatedKeyText(key: readonly string[], source: number, target: number): string {
  return `The ${keyText(key)} does not identify a row: ${source} keys repeat in the source and ${target} in the target. Add a column that tells the versions of a row apart, such as a time stamp, to the key, or compare the whole rows.`;
}

/** The columns that were not compared, for the message; empty when all were. */
export function leftOutText(plan: ColumnPlan): string {
  const names = (list: readonly string[]): string => list.map((name) => JSON.stringify(name)).join(', ');
  return [
    ...(plan.onlyInSource.length > 0 ? [`only in the source: ${names(plan.onlyInSource)}`] : []),
    ...(plan.onlyInTarget.length > 0 ? [`only in the target: ${names(plan.onlyInTarget)}`] : []),
    ...(plan.notCast.length > 0
      ? [
          `of a type that does not cast to the source's: ${plan.notCast.map((c) => `${JSON.stringify(c.source)} (${c.targetType} to ${c.sourceType})`).join(', ')}`,
        ]
      : []),
  ].join('; ');
}

/** `lake · staging.orders @56`. */
export const sideText = (side: CompareSide): string =>
  `${side.connectionName} · ${side.schema}.${side.table} @${side.snapshot}`;

/** The line above the grid: the counts, the key, and how many rows are shown when the grid is cut. */
export function summaryLine(counts: CompareCounts, key: readonly string[], shown: number): string {
  const all = gridRowCount(counts);
  return [
    countsText(counts, key.length > 0),
    keyText(key),
    ...(shown < all ? [`showing the first ${shown} of ${all} rows`] : []),
  ].join(' · ');
}

/** The leading columns of the grid of a compare: the number of the difference, what it is, and the side of the row. */
export const META_COLUMNS = ['#', 'difference', 'side'] as const;

export const DIFFERENCE = {
  onlyInSource: 'only in the source',
  onlyInTarget: 'only in the target',
  different: 'differs',
} as const;

/**
 * The kind of a grid row, from the point of view of Script as Update, which makes the target like the source: a row
 * only in the source is inserted, one only in the target deleted, and of a row that differs the target's version is
 * the one before, the source's the one after.
 */
export function rowKindOf(difference: unknown, side: unknown): RowKind | undefined {
  switch (difference) {
    case DIFFERENCE.onlyInSource:
      return 'insert';
    case DIFFERENCE.onlyInTarget:
      return 'delete';
    case DIFFERENCE.different:
      return side === 'target' ? 'update-before' : 'update-after';
    default:
      return undefined;
  }
}
