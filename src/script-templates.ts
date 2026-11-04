import { dropMacroDdl, qualifiedName } from './catalog/ddl';
import { isMainSchema } from './catalog/model';
import { commented, macroScript, newestNote, pinnedOf, selectStatement, viewScript } from './script';
import {
  alterColumn,
  columnBlocks,
  addColumnBlock,
  createColumn,
  selectColumn,
} from './script-templates/columns';
import {
  blocks,
  catalogOf,
  COMMENTED_OUT,
  dropColumnStatement,
  dropList,
  dropScript,
  dropStatement,
  RUN,
  selectScript,
  TEMPLATE_HEADER,
  withDrop,
} from './script-templates/common';
import type { Folder, Ref, Tree } from './script-templates/common';
import { alterLayout, alterTags, createLayout, dropLayout, dropTags } from './script-templates/layout';
import {
  selectCatalog,
  selectChange,
  selectHistory,
  selectSnapshot,
  selectSnapshots,
  selectStatistics,
} from './script-templates/lake-queries';
import { selectMacro, selectMacros } from './script-templates/macros';
import {
  columnBlock,
  defaultSchema,
  macroTemplate,
  scalarMacroBlock,
  schemaBlock,
  tableBlock,
  tableMacroBlock,
  viewBlock,
} from './script-templates/new-objects';
import { alterTable, createTable, insertTable, tableSelect } from './script-templates/table';
import { byName } from './tree/model';
import type { ChangedTable, NodeRef } from './tree/refs';

/** The five entries of the **Script as** submenu; only a table has INSERT. */
export type ScriptVerb = 'select' | 'insert' | 'create' | 'alter' | 'drop';

type Made = string | Promise<string>;
type Verbs<R> = { readonly [V in ScriptVerb]?: (tree: Tree, ref: R) => Made };

// Node kinds that have scripts, keyed by the `contextValue` of their tree nodes.
interface Refs {
  readonly 'connection.connected': Ref<'connection'>;
  readonly schema: Ref<'schema'>;
  readonly 'folder.tables': Folder<'tables'>;
  readonly 'folder.views': Folder<'views'>;
  readonly 'folder.macros': Folder<'macros'>;
  readonly table: Ref<'table'>;
  readonly view: Ref<'view'>;
  readonly macro: Ref<'macro'>;
  readonly 'folder.columns': Folder<'columns'>;
  readonly column: Ref<'column'>;
  readonly 'column.member': Ref<'column'>;
  readonly 'folder.viewColumns': Folder<'viewColumns'>;
  readonly viewColumn: Ref<'viewColumn'>;
  readonly 'folder.partitioning': Folder<'partitioning'>;
  readonly 'folder.sortOrder': Folder<'sortOrder'>;
  readonly 'folder.tags': Folder<'tags'>;
  readonly 'folder.statistics': Folder<'statistics'>;
  readonly 'folder.history': Folder<'history'>;
  readonly 'folder.snapshots': Folder<'snapshots'>;
  readonly snapshot: Ref<'snapshot'>;
  readonly 'detail.table': Ref<'detail'> & { readonly change: ChangedTable };
}

export type ScriptKind = keyof Refs;

const MAIN_STAYS = 'aantje writes no DROP of the schema main: it is the default schema of the lake.';

/** The generators of the **Script as** entries of each node kind. */
export const SCRIPTS: { readonly [K in ScriptKind]: Verbs<Refs[K]> } = {
  'connection.connected': {
    select: selectCatalog,
    async create(tree, ref) {
      const { reader, snapshot } = catalogOf(tree, ref.connectionId, 'CREATE');
      const schema = defaultSchema(await reader.schemas(snapshot));
      return blocks([
        [
          TEMPLATE_HEADER,
          '-- The first block creates a schema; the other blocks create their objects in the schema that their statements name.',
        ],
        schemaBlock(),
        tableBlock(schema),
        viewBlock(schema),
        scalarMacroBlock(schema),
        tableMacroBlock(schema),
      ]);
    },
    async drop(tree, ref) {
      const { reader, snapshot } = catalogOf(tree, ref.connectionId, 'DROP');
      const schemas = (await reader.schemas(snapshot)).toSorted(byName);
      const droppable = schemas.filter(({ name }) => !isMainSchema(name));
      const keepsMain = droppable.length < schemas.length;
      return dropList(
        tree,
        ref.connectionId,
        droppable.map(({ name }) => dropStatement('SCHEMA', name)),
        keepsMain ? `-- The catalog has no schema but main. ${MAIN_STAYS}` : '-- The catalog has no schemas.',
        [
          '-- A schema must be empty to be dropped; add CASCADE to drop what it holds, too.',
          ...(keepsMain ? [`-- ${MAIN_STAYS}`] : []),
        ],
      );
    },
  },
  schema: {
    async select(tree, ref) {
      const { reader, snapshot } = catalogOf(tree, ref.connectionId, 'SELECT');
      const [tables, views] = await Promise.all([
        reader.tables(ref.schema.id, snapshot),
        reader.views(ref.schema.id, snapshot),
      ]);
      return selectScript(
        tree,
        ref,
        [...tables.toSorted(byName), ...views.toSorted(byName)].map(({ name }) => name),
        {
          intro: '-- A query over each table, then each view of this schema.',
          empty: '-- This schema has no tables or views.',
        },
      );
    },
    create: (_tree, ref) =>
      blocks([
        [TEMPLATE_HEADER],
        tableBlock(ref.schema.name),
        viewBlock(ref.schema.name),
        scalarMacroBlock(ref.schema.name),
        tableMacroBlock(ref.schema.name),
      ]),
    // The menu shows the entry disabled on main; a call by command still gets no DROP of it.
    drop: (tree, ref) =>
      isMainSchema(ref.schema.name)
        ? `-- ${MAIN_STAYS}`
        : [
            `-- Drops the schema. It must be empty: DuckLake refuses otherwise. ${RUN}`,
            ...newestNote(tree, ref.connectionId, { several: true }),
            dropStatement('SCHEMA', ref.schema.name),
            '-- Drops the schema and everything in it',
            commented(`DROP SCHEMA ${qualifiedName(ref.schema.name)} CASCADE;`),
          ].join('\n'),
  },
  'folder.tables': {
    select: (tree, ref) =>
      selectScript(
        tree,
        ref,
        ref.tables.map(({ name }) => name),
        { intro: '-- A query over each table of this schema.', empty: '-- This schema has no tables.' },
      ),
    create: (_tree, ref) => blocks([[TEMPLATE_HEADER], tableBlock(ref.schema.name)]),
    drop: (tree, ref) =>
      dropList(
        tree,
        ref.connectionId,
        ref.tables.map(({ name }) => dropStatement('TABLE', ref.schema.name, name)),
        '-- This schema has no tables.',
      ),
  },
  'folder.views': {
    select: (tree, ref) =>
      selectScript(
        tree,
        ref,
        ref.views.map(({ name }) => name),
        { intro: '-- A query over each view of this schema.', empty: '-- This schema has no views.' },
      ),
    create: (_tree, ref) => blocks([[TEMPLATE_HEADER], viewBlock(ref.schema.name)]),
    drop: (tree, ref) =>
      dropList(
        tree,
        ref.connectionId,
        ref.views.map(({ name }) => dropStatement('VIEW', ref.schema.name, name)),
        '-- This schema has no views.',
      ),
  },
  'folder.macros': {
    select: selectMacros,
    create: (_tree, ref) => macroTemplate(ref.schema.name),
    drop: (tree, ref) =>
      dropList(
        tree,
        ref.connectionId,
        ref.macros.map((macro) => dropMacroDdl(ref.schema.name, macro)),
        '-- This schema has no macros.',
      ),
  },
  table: {
    select: tableSelect,
    insert: insertTable,
    create: createTable,
    alter: alterTable,
    drop: (tree, ref) =>
      dropScript('table', tree, ref.connectionId, dropStatement('TABLE', ref.schema.name, ref.table.name)),
  },
  view: {
    select: (tree, ref) =>
      selectStatement(ref.schema.name, ref.view.name, undefined, pinnedOf(tree, ref.connectionId)),
    create(tree, ref) {
      const { notes, statement } = viewScript(ref.schema.name, ref.view, 'create');
      return withDrop(
        [...notes, ...newestNote(tree, ref.connectionId)],
        dropStatement('VIEW', ref.schema.name, ref.view.name),
        statement,
      );
    },
    alter(tree, ref) {
      const view = qualifiedName(ref.schema.name, ref.view.name);
      const { notes, statement } = viewScript(ref.schema.name, ref.view, 'alter');
      return [
        '-- Edit the query, then run the statement in a read/write SQL session to replace the view.',
        ...notes,
        ...newestNote(tree, ref.connectionId),
        statement,
        '-- Rename the view',
        commented(`ALTER VIEW ${view} RENAME TO <new_name>;`),
        '-- Comment on the view',
        commented(`COMMENT ON VIEW ${view} IS '<comment>';`),
        '-- Drop the view',
        commented(dropStatement('VIEW', ref.schema.name, ref.view.name)),
      ].join('\n');
    },
    drop: (tree, ref) =>
      dropScript('view', tree, ref.connectionId, dropStatement('VIEW', ref.schema.name, ref.view.name)),
  },
  macro: {
    select: selectMacro,
    create(tree, ref) {
      const { notes, statement } = macroScript(ref.schema.name, ref.macro);
      return withDrop(
        [...notes, ...newestNote(tree, ref.connectionId)],
        dropMacroDdl(ref.schema.name, ref.macro),
        statement,
      );
    },
    alter(tree, ref) {
      const { notes, statement } = macroScript(ref.schema.name, ref.macro);
      return [
        '-- Edit the macro, then run the statement in a read/write SQL session to replace it. The statement holds all its overloads.',
        ...notes,
        ...newestNote(tree, ref.connectionId),
        statement,
        '-- Drop the macro',
        commented(dropMacroDdl(ref.schema.name, ref.macro)),
      ].join('\n');
    },
    drop: (tree, ref) =>
      dropScript(
        `${ref.macro.kind} macro with all its overloads`,
        tree,
        ref.connectionId,
        dropMacroDdl(ref.schema.name, ref.macro),
      ),
  },
  'folder.columns': {
    select: (tree, ref) =>
      selectStatement(
        ref.schema.name,
        ref.table.name,
        ref.columns.map(({ name }) => name),
        pinnedOf(tree, ref.connectionId),
      ),
    create: (_tree, ref) => blocks([[TEMPLATE_HEADER], columnBlock(ref.schema.name, ref.table.name)]),
    alter: (tree, ref) =>
      blocks([
        [...COMMENTED_OUT, ...newestNote(tree, ref.connectionId, { several: true })],
        addColumnBlock(ref.schema.name, ref.table.name),
        ...columnBlocks(ref.schema.name, ref.table.name, ref.columns),
      ]),
    drop: (tree, ref) =>
      dropList(
        tree,
        ref.connectionId,
        ref.columns.map(({ name }) => dropColumnStatement(ref.schema.name, ref.table.name, [name])),
        '-- This table has no columns.',
      ),
  },
  column: {
    select: selectColumn,
    create: createColumn,
    alter: alterColumn,
    drop: (tree, ref) =>
      dropScript(
        'column',
        tree,
        ref.connectionId,
        dropColumnStatement(ref.schema.name, ref.table.name, ref.path),
      ),
  },
  // List elements and map keys and values have no name to create or drop.
  'column.member': { select: selectColumn, alter: alterColumn },
  'folder.viewColumns': {
    select: (tree, ref) =>
      selectStatement(ref.schema.name, ref.view.name, undefined, pinnedOf(tree, ref.connectionId)),
  },
  viewColumn: {
    select: (tree, ref) =>
      selectStatement(ref.schema.name, ref.view.name, [ref.column.name], pinnedOf(tree, ref.connectionId)),
  },
  'folder.partitioning': { select: tableSelect, create: createLayout, alter: alterLayout, drop: dropLayout },
  'folder.sortOrder': { select: tableSelect, create: createLayout, alter: alterLayout, drop: dropLayout },
  'folder.tags': { select: tableSelect, alter: alterTags, drop: dropTags },
  'folder.statistics': { select: selectStatistics },
  'folder.history': { select: selectHistory },
  'folder.snapshots': { select: selectSnapshots },
  snapshot: { select: (_tree, ref) => selectSnapshot(ref) },
  'detail.table': { select: (_tree, ref) => selectChange(ref) },
};

/** The `contextValue` the tree gives the node, when its kind has scripts. */
export function scriptKindOf(ref: NodeRef): ScriptKind | undefined {
  switch (ref.kind) {
    case 'connection':
      return 'connection.connected';
    case 'column':
      return ref.member ? 'column.member' : 'column';
    case 'folder':
      return `folder.${ref.folder}`;
    case 'detail':
      return ref.change ? 'detail.table' : undefined;
    case 'message':
      return undefined;
    default:
      return ref.kind;
  }
}

/** The text of a **Script as** entry; undefined when the node kind has no such entry. */
export function scriptOf(verb: ScriptVerb, tree: Tree, ref: NodeRef): Made | undefined {
  const kind = scriptKindOf(ref);
  // `scriptKindOf` ties the kind to the ref, so the generator gets the ref it was written for.
  const make = kind && (SCRIPTS[kind] as Verbs<NodeRef>)[verb];
  return make ? make(tree, ref) : undefined;
}
