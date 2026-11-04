import { qualifiedName, quoteIdentifier } from '../catalog/ddl';
import type { PartitionColumn, SortExpression, TagsInfo } from '../catalog/model';
import { commented, newestNote } from '../script';
import { COMMENTED_OUT, DROPS_COMMENTED_OUT, RUN, withDrop } from './common';
import type { Folder, Tree } from './common';

const TIME_TRANSFORMS = new Set(['year', 'month', 'day', 'hour']);

/** The key for `SET PARTITIONED BY`; undefined for a nested column or an unknown transform. */
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

type LayoutKind = 'PARTITIONED' | 'SORTED';

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

function resetStatement(schemaName: string, tableName: string, what: LayoutKind): string {
  return `ALTER TABLE ${qualifiedName(schemaName, tableName)} RESET ${what} BY;`;
}

type Layout = Folder<'partitioning'> | Folder<'sortOrder'>;

function layoutOf(ref: Layout): { what: LayoutKind; set: string; notes: string[] } {
  const schemaName = ref.schema.name;
  const tableName = ref.table.name;
  return ref.folder === 'partitioning'
    ? {
        what: 'PARTITIONED',
        set: setStatement(schemaName, tableName, 'PARTITIONED', ref.partitioning.columns.map(partitionKey)),
        notes: [],
      }
    : {
        what: 'SORTED',
        set: setStatement(schemaName, tableName, 'SORTED', ref.sortOrder.expressions.map(sortKey)),
        notes: ['-- The sort expressions come from the catalog: read them before running.'],
      };
}

export function createLayout(tree: Tree, ref: Layout): string {
  const { what, set, notes } = layoutOf(ref);
  return withDrop(
    [...(set.startsWith('--') ? [] : notes), ...newestNote(tree, ref.connectionId)],
    resetStatement(ref.schema.name, ref.table.name, what),
    set,
  );
}

export function alterLayout(tree: Tree, ref: Layout): string {
  const { what } = layoutOf(ref);
  const table = qualifiedName(ref.schema.name, ref.table.name);
  const [setting, example] =
    what === 'PARTITIONED'
      ? [
          'partitioning. New data is written partitioned by the key; the files that exist keep their layout. The transforms are identity, year, month, day, hour and bucket(N, column).',
          'SET PARTITIONED BY (year(<column>), <column>)',
        ]
      : [
          'sort order. New data is written sorted by the key; the files that exist keep their layout.',
          'SET SORTED BY (<column> ASC NULLS FIRST, <column> DESC NULLS LAST)',
        ];
  return [
    ...COMMENTED_OUT,
    `-- Sets the ${setting}`,
    ...newestNote(tree, ref.connectionId, { several: true }),
    '',
    commented(`ALTER TABLE ${table} ${example};`),
    '-- Removes it',
    commented(resetStatement(ref.schema.name, ref.table.name, what)),
  ].join('\n');
}

export function dropLayout(tree: Tree, ref: Layout): string {
  const { what } = layoutOf(ref);
  return [
    `-- Removes the ${what === 'PARTITIONED' ? 'partitioning' : 'sort order'} of the table: new data is written without it. ${RUN}`,
    ...newestNote(tree, ref.connectionId),
    resetStatement(ref.schema.name, ref.table.name, what),
  ].join('\n');
}

// DuckLake cannot comment a nested field, so only top-level columns appear.
function commentStatements(schemaName: string, tableName: string, tags: TagsInfo, text: string): string[] {
  const columns = [
    ...new Set(tags.columns.filter(({ path }) => path.length === 1).map(({ path }) => path[0])),
  ];
  return [
    `COMMENT ON TABLE ${qualifiedName(schemaName, tableName)} IS ${text};`,
    ...columns.flatMap((name) =>
      name === undefined
        ? []
        : [`COMMENT ON COLUMN ${qualifiedName(schemaName, tableName, name)} IS ${text};`],
    ),
  ];
}

const TAGS_NOTE =
  '-- DuckLake has no SQL statement for tags other than the comment. COMMENT ON sets the comment of the table and of a column; the other tags can only be changed in the catalog.';

export function alterTags(tree: Tree, ref: Folder<'tags'>): string {
  return [
    ...COMMENTED_OUT,
    TAGS_NOTE,
    ...newestNote(tree, ref.connectionId, { several: true }),
    '',
    ...commentStatements(ref.schema.name, ref.table.name, ref.tags, "'<comment>'").map(commented),
  ].join('\n');
}

export function dropTags(tree: Tree, ref: Folder<'tags'>): string {
  return [
    ...DROPS_COMMENTED_OUT,
    TAGS_NOTE,
    '-- NULL removes a comment; the other tags stay.',
    ...newestNote(tree, ref.connectionId, { several: true }),
    '',
    ...commentStatements(ref.schema.name, ref.table.name, ref.tags, 'NULL').map(commented),
  ].join('\n');
}
