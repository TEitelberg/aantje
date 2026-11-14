import { qualifiedName, quoteIdentifier, quoteLiteral } from '../catalog/ddl';
import type { PartitionColumn, SnapshotId, SortExpression } from '../catalog/model';
import { commented } from './check';

// The small statements that Script as, Script as Update, Generate Scripts and the restore scripts share: drops, the
// partitioning and the sort order of a table, and comments. Names are quoted; catalog text is copied only where a
// statement takes an expression, and only when it cannot end the statement or open a comment.

export const dropStatement = (what: 'SCHEMA' | 'TABLE' | 'VIEW', ...name: string[]): string =>
  `DROP ${what} ${qualifiedName(...name)};`;

export const dropColumnStatement = (schemaName: string, tableName: string, path: readonly string[]): string =>
  `ALTER TABLE ${qualifiedName(schemaName, tableName)} DROP COLUMN ${path.map(quoteIdentifier).join('.')};`;

/** The note above the drops of a script and the form of each drop: live, or a comment while a tree is pinned. */
export interface Drops {
  /** Empty while the tree follows the newest snapshot. */
  readonly note: string[];
  readonly live: boolean;
  readonly statement: (text: string) => string;
}

/**
 * The drops of a script that names the objects as they are at the snapshot a tree shows: Script as DROP, and Script as
 * Update against a target. While the tree is pinned to a snapshot (`pinned`), an object may have been renamed since and
 * another may hold its name now, so each drop is a comment under a note then: a drop of the wrong object would lose its
 * data.
 */
export function dropsAtSnapshot(pinned: SnapshotId | undefined): Drops {
  return pinned === undefined
    ? { note: [], live: true, statement: (text) => text }
    : {
        note: [
          `-- The tree shows snapshot @${pinned}, but a statement acts on the newest state, where the name may belong to another object now.`,
          '-- Check the name at the newest snapshot before you remove the "-- ".',
        ],
        live: false,
        statement: commented,
      };
}

/** `COMMENT ON` a table, view or top-level column; the text as a literal, NULL for none. */
export const commentStatement = (
  what: 'TABLE' | 'VIEW' | 'COLUMN',
  name: readonly string[],
  text: string | null,
): string =>
  `COMMENT ON ${what} ${qualifiedName(...name)} IS ${text === null ? 'NULL' : quoteLiteral(text)};`;

// The time transforms that DuckLake takes, as it stores and as `SET PARTITIONED BY` writes them.
const TIME_TRANSFORMS = new Set([
  'year',
  'month',
  'day',
  'hour',
  'epoch_year',
  'epoch_month',
  'epoch_day',
  'epoch_hour',
]);

/** The key for `SET PARTITIONED BY`; undefined for a nested column or a transform that DuckLake does not take. */
export function partitionKey({ path, transform }: PartitionColumn): string | undefined {
  const [name, ...nested] = path;
  if (name === undefined || nested.length > 0) {
    return undefined;
  }
  const column = quoteIdentifier(name);
  const bucket = /^bucket\((\d+)\)$/.exec(transform);
  if (transform === 'identity') {
    return column;
  }
  if (TIME_TRANSFORMS.has(transform)) {
    return `${transform}(${column})`;
  }
  return bucket ? `bucket(${bucket[1]}, ${column})` : undefined;
}

// A Map, not an object: hostile catalog text must not match an object property.
const NULL_ORDERS: ReadonlyMap<string, string> = new Map([
  ['NULLS_FIRST', 'NULLS FIRST'],
  ['NULLS_LAST', 'NULLS LAST'],
]);

/** The key for `SET SORTED BY`; the catalog expression is copied only if it cannot end the statement or open a comment. */
export function sortKey({ expression, dialect, direction, nullOrder }: SortExpression): string | undefined {
  const nulls = NULL_ORDERS.get(nullOrder);
  const plain = !/[;\r\n]|--|\/\*/.test(expression);
  return dialect === 'duckdb' && plain && nulls && (direction === 'ASC' || direction === 'DESC')
    ? `${expression} ${direction} ${nulls}`
    : undefined;
}

export const SORT_NOTE = '-- The sort expressions come from the catalog: read them before running.';

export type LayoutKind = 'PARTITIONED' | 'SORTED';

/** `SET <what> BY (<keys>)`, or a comment saying why the layout cannot be written. */
export function setStatement(
  schemaName: string,
  tableName: string,
  what: LayoutKind,
  keys: readonly (string | undefined)[],
): string {
  return keys.length > 0 && keys.every((key) => key !== undefined)
    ? `ALTER TABLE ${qualifiedName(schemaName, tableName)} SET ${what} BY (${keys.join(', ')});`
    : `-- This ${what === 'PARTITIONED' ? 'partitioning' : 'sort order'} cannot be written as a statement (a nested column, or an expression or transform that is not plain).`;
}

export const resetStatement = (schemaName: string, tableName: string, what: LayoutKind): string =>
  `ALTER TABLE ${qualifiedName(schemaName, tableName)} RESET ${what} BY;`;
