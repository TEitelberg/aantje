import { qualifiedName } from '../catalog/ddl';
import type { TagsInfo } from '../catalog/model';
import { commented } from '../ddl-script/check';
import {
  commentStatement,
  partitionKey,
  resetStatement,
  setStatement,
  SORT_NOTE,
  sortKey,
} from '../ddl-script/statements';
import type { LayoutKind } from '../ddl-script/statements';
import { newestNote } from '../script';
import { COMMENTED_OUT, DROPS_COMMENTED_OUT, dropsAt, RUN, withDrop } from './common';
import type { Folder, Tree } from './common';

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
        notes: [SORT_NOTE],
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
  const drops = dropsAt(tree, ref.connectionId);
  return [
    `-- Removes the ${what === 'PARTITIONED' ? 'partitioning' : 'sort order'} of the table: new data is written without it. ${RUN}`,
    ...drops.note,
    drops.statement(resetStatement(ref.schema.name, ref.table.name, what)),
  ].join('\n');
}

// DuckLake cannot comment a nested field, so only top-level columns appear.
function commentStatements(
  schemaName: string,
  tableName: string,
  tags: TagsInfo,
  text: string | null,
): string[] {
  const columns = [
    ...new Set(tags.columns.filter(({ path }) => path.length === 1).map(({ path }) => path[0])),
  ];
  return [
    commentStatement('TABLE', [schemaName, tableName], text),
    ...columns.flatMap((name) =>
      name === undefined ? [] : [commentStatement('COLUMN', [schemaName, tableName, name], text)],
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
    ...commentStatements(ref.schema.name, ref.table.name, ref.tags, '<comment>').map(commented),
  ].join('\n');
}

export function dropTags(tree: Tree, ref: Folder<'tags'>): string {
  return [
    ...DROPS_COMMENTED_OUT,
    TAGS_NOTE,
    '-- NULL removes a comment; the other tags stay.',
    ...dropsAt(tree, ref.connectionId).note,
    '',
    ...commentStatements(ref.schema.name, ref.table.name, ref.tags, null).map(commented),
  ].join('\n');
}
