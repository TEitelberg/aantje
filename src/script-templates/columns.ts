import { addColumnDdl, qualifiedName, quoteIdentifier } from '../catalog/ddl';
import type { ColumnInfo } from '../catalog/model';
import { PREVIEW_LIMIT } from '../data/types';
import { columnFragments, commented, fromCatalog } from '../ddl-script/check';
import { commentStatement, dropColumnStatement } from '../ddl-script/statements';
import { atVersion, newestNote, pinnedOf, timeTravelNote } from '../script';
import { catalogOf, COMMENTED_OUT, withDrop } from './common';
import type { Ref, Tree } from './common';

const MEMBER_NOTE =
  '-- The element of a list and the key and value of a map are no named columns: change the column that holds them, or the fields of a struct inside them.';

function chain(columns: readonly ColumnInfo[], path: readonly string[]): ColumnInfo[] {
  const found: ColumnInfo[] = [];
  let level = columns;
  for (const name of path) {
    const next = level.find((column) => column.name === name);
    if (!next) {
      break;
    }
    found.push(next);
    level = next.children;
  }
  return found;
}

// DuckLake changes the type and the comment of top-level columns only, not of struct fields.
function columnStatements(
  schemaName: string,
  tableName: string,
  path: readonly string[],
  column: ColumnInfo,
  named: boolean,
): string[] {
  const alter = (change: string): string =>
    commented(`ALTER TABLE ${qualifiedName(schemaName, tableName)} ${change};`);
  // List elements and map keys and values have no name to rename or drop; structs inside them use `element`, `key`, `value`.
  const fields = (at: string, parent: ColumnInfo): string[] => {
    switch (parent.type) {
      case 'struct':
        return [
          alter(`ADD COLUMN ${at}.<new_field> <type>`),
          ...parent.children.flatMap((field) => {
            const fieldPath = `${at}.${quoteIdentifier(field.name)}`;
            return [
              alter(`RENAME COLUMN ${fieldPath} TO <new_name>`),
              alter(`DROP COLUMN ${fieldPath}`),
              ...fields(fieldPath, field),
            ];
          }),
        ];
      case 'list':
      case 'map':
        return parent.children.flatMap((child) => fields(`${at}.${quoteIdentifier(child.name)}`, child));
      default:
        return [];
    }
  };
  const dotted = path.map(quoteIdentifier).join('.');
  const topLevel = path.length === 1;
  return [
    ...(named
      ? [
          alter(`RENAME COLUMN ${dotted} TO <new_name>`),
          ...(topLevel ? [alter(`ALTER COLUMN ${dotted} SET DATA TYPE <new_type>`)] : []),
          alter(`DROP COLUMN ${dotted}`),
          ...(topLevel
            ? [commented(commentStatement('COLUMN', [schemaName, tableName, ...path], '<comment>'))]
            : []),
        ]
      : []),
    ...fields(dotted, column),
  ];
}

export function columnBlocks(
  schemaName: string,
  tableName: string,
  columns: readonly ColumnInfo[],
): string[][] {
  return columns.map((column, index) => [
    `-- Column ${index + 1} of ${columns.length}`,
    ...columnStatements(schemaName, tableName, [column.name], column, true),
  ]);
}

export const addColumnBlock = (schemaName: string, tableName: string): string[] => [
  '-- Add a column',
  commented(`ALTER TABLE ${qualifiedName(schemaName, tableName)} ADD COLUMN <new_column> <type>;`),
];

// A SELECT reaches struct fields, but not into a list or a map.
function selectablePath(columns: readonly ColumnInfo[], path: readonly string[]): string[] {
  const found = chain(columns, path);
  if (found.length < path.length) {
    return [...path];
  }
  const reachable: string[] = [];
  for (const column of found) {
    reachable.push(column.name);
    if (column.type !== 'struct') {
      break;
    }
  }
  return reachable;
}

export async function selectColumn(tree: Tree, ref: Ref<'column'>): Promise<string> {
  const { reader, snapshot } = catalogOf(tree, ref.connectionId, 'SELECT');
  const columns = await reader.columns(ref.table.id, snapshot);
  const path = selectablePath(columns, ref.path);
  const pinned = pinnedOf(tree, ref.connectionId);
  return [
    ...(path.length < ref.path.length
      ? [
          '-- The element of a list and the key and value of a map cannot be selected by name; this selects the column that holds it.',
        ]
      : []),
    ...timeTravelNote(pinned),
    `SELECT ${path.map(quoteIdentifier).join('.')}`,
    `FROM ${qualifiedName(ref.schema.name, ref.table.name)}${atVersion(pinned)}`,
    `LIMIT ${PREVIEW_LIMIT};`,
  ].join('\n');
}

export function createColumn(tree: Tree, ref: Ref<'column'>): string {
  const { statements, notes } = addColumnDdl(ref.schema.name, ref.table.name, ref.path, ref.column);
  const added = fromCatalog(statements.join('\n'), columnFragments([ref.column]));
  return withDrop(
    [...newestNote(tree, ref.connectionId), ...notes, ...added.notes],
    dropColumnStatement(ref.schema.name, ref.table.name, ref.path),
    added.statement,
  );
}

export function alterColumn(tree: Tree, ref: Ref<'column'>): string {
  const statements = columnStatements(
    ref.schema.name,
    ref.table.name,
    ref.path,
    ref.column,
    ref.member !== true,
  );
  return [
    ...COMMENTED_OUT,
    ...newestNote(tree, ref.connectionId, { several: true }),
    '',
    ...(statements.length > 0 ? statements : [MEMBER_NOTE]),
  ].join('\n');
}
