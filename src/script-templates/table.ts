import { columnDefinition, qualifiedName, quoteIdentifier } from '../catalog/ddl';
import type { ColumnInfo, SnapshotId } from '../catalog/model';
import { columnFragments, commented, fromCatalog, isStatement } from '../ddl-script/check';
import { readCreatedTable } from '../ddl-script/read';
import { commentStatement, dropStatement } from '../ddl-script/statements';
import { tableDdl } from '../ddl-script/table-ddl';
import { alterOptionLines } from '../maintenance/options';
import { newestComment, newestNote, pinnedOf, selectStatement } from '../script';
import { addColumnBlock, columnBlocks } from './columns';
import { blocks, catalogOf, COMMENTED_OUT, RUN, withDrop } from './common';
import type { Ref, Tree } from './common';

/** The `SELECT` of a table; table folders without a query of their own use it too. */
export async function tableSelect(
  tree: Tree,
  ref: Pick<Ref<'table'>, 'connectionId' | 'schema' | 'table'>,
): Promise<string> {
  const { reader, snapshot } = catalogOf(tree, ref.connectionId, 'SELECT');
  const columns = await reader.columns(ref.table.id, snapshot);
  return selectStatement(
    ref.schema.name,
    ref.table.name,
    columns.map(({ name }) => name),
    pinnedOf(tree, ref.connectionId),
  );
}

/**
 * `CREATE TABLE`, followed by the partitioning, sort order and comments as commented-out statements: the DDL that
 * Generate Scripts writes live. Commented out, they need no note to read the sort expressions before running.
 */
export async function createTable(tree: Tree, ref: Ref<'table'>): Promise<string> {
  const { reader, snapshot } = catalogOf(tree, ref.connectionId, 'CREATE');
  const schemaName = ref.schema.name;
  const tableName = ref.table.name;
  const table = await readCreatedTable(
    reader,
    snapshot,
    { id: ref.table.id, schemaName, name: tableName, comment: ref.table.comment },
    reader.metadata(),
  );
  const { notes, create, followUps } = tableDdl(schemaName, table, fromCatalog);
  const restoring = followUps
    .filter(({ note }) => note !== 'sort')
    .map(({ text }) => (isStatement(text) ? commented(text) : text));
  return withDrop(
    [...newestNote(tree, ref.connectionId), ...notes],
    dropStatement('TABLE', schemaName, tableName),
    [
      create,
      ...(restoring.length > 0
        ? ['-- The partitioning, the sort order and the comments of the table', ...restoring]
        : []),
    ].join('\n'),
  );
}

/**
 * **Script as INSERT**: an insert writes to the newest snapshot, so the template has the name and the columns
 * of the table there; with an older snapshot pinned it says so, or that the table is no longer there.
 */
export async function insertTable(tree: Tree, ref: Ref<'table'>): Promise<string> {
  const { reader, snapshot } = catalogOf(tree, ref.connectionId, 'INSERT');
  const pinned = pinnedOf(tree, ref.connectionId);
  const newest = tree.state(ref.connectionId).latestSnapshot ?? snapshot;
  // A table keeps its id when it is renamed.
  const table =
    pinned === undefined
      ? ref.table
      : (await reader.tables(ref.schema.id, newest)).find(({ id }) => id === ref.table.id);
  if (!table) {
    return `-- The tree shows snapshot @${pinned}; the table is not in the newest snapshot @${newest}, so nothing can be inserted into it.`;
  }
  const note =
    pinned === undefined
      ? []
      : [
          `-- The tree shows snapshot @${pinned}; this statement acts on the newest state and has the columns of snapshot @${newest}.`,
        ];
  return insertTemplate(ref.schema.name, table.name, await reader.columns(table.id, newest), note);
}

/** One row to insert, with a `<placeholder>` per column that names it with its type, default and `NOT NULL`. */
function insertTemplate(
  schemaName: string,
  tableName: string,
  columns: readonly ColumnInfo[],
  notes: readonly string[] = [],
): string {
  const { notes: catalogNotes, statement } = fromCatalog(
    [
      `INSERT INTO ${qualifiedName(schemaName, tableName)} (${columns.map(({ name }) => quoteIdentifier(name)).join(', ')})`,
      'VALUES (',
      columns.map((column) => `  <${columnDefinition(column)}>`).join(',\n'),
      ');',
    ].join('\n'),
    columnFragments(columns),
  );
  return [
    `-- Inserts one row. Replace the <placeholders>; a column with a default can be left out of both lists. ${RUN}`,
    ...notes,
    ...catalogNotes,
    statement,
  ].join('\n');
}

export async function alterTable(tree: Tree, ref: Ref<'table'>): Promise<string> {
  const { reader, snapshot } = catalogOf(tree, ref.connectionId, 'ALTER');
  return alterTableTemplate(
    ref.schema.name,
    ref.table.name,
    await reader.columns(ref.table.id, snapshot),
    pinnedOf(tree, ref.connectionId),
  );
}

/** Template of **Script as ALTER**: every supported statement, commented out. Comment lines hold no catalog text. */
export function alterTableTemplate(
  schemaName: string,
  tableName: string,
  columns: readonly ColumnInfo[],
  pinned: SnapshotId | undefined,
): string {
  const table = qualifiedName(schemaName, tableName);
  const alter = (change: string): string => commented(`ALTER TABLE ${table} ${change};`);
  return blocks([
    [
      ...COMMENTED_OUT,
      '-- DuckLake can add, rename and drop columns and struct fields, change a column type (only widening, for example INTEGER to BIGINT), rename the table, and set the comment, the partitioning, the sort order and the options.',
      ...newestComment(pinned, { several: true }),
    ],
    addColumnBlock(schemaName, tableName),
    ['-- Rename the table', alter('RENAME TO <new_name>')],
    ['-- Comment on the table', commented(commentStatement('TABLE', [schemaName, tableName], '<comment>'))],
    ['-- Partitioning of new data', alter('SET PARTITIONED BY (<column>)'), alter('RESET PARTITIONED BY')],
    ['-- Sort order of new data', alter('SET SORTED BY (<column> ASC)'), alter('RESET SORTED BY')],
    [
      '-- Options of the table; RESET removes the override, so that the value of the schema, the lake or the default applies',
      ...alterOptionLines(table, columns),
    ],
    ...columnBlocks(schemaName, tableName, columns),
    ['-- Drop the table', commented(dropStatement('TABLE', schemaName, tableName))],
  ]);
}
