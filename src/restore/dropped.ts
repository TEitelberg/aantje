import { foldIdentifier, qualifiedName, quoteIdentifier } from '../catalog/ddl';
import type { DroppedObject, MacroInfo, ViewInfo } from '../catalog/model';
import { allNeeding, checkedScript } from '../ddl-script/check';
import type { CatalogCheck, Tokenize } from '../ddl-script/check';
import { macroLines, viewLines } from '../ddl-script/definitions';
import type { DefinitionOptions } from '../ddl-script/definitions';
import { commentName } from '../ddl-script/names';
import { pickerLabel } from '../messages';
import { createLines, tableDdl } from '../ddl-script/table-ddl';
import type { CreatedTable } from '../ddl-script/table-ddl';
import { atVersion } from '../script';
import { formatUtc } from '../snapshot';
import { NEW_ID, NOTHING_RUN, snapshotText } from './text';

// Restore Dropped Object: a table, view or macro of a schema that a snapshot which still exists can read, created again
// from what the catalog stored at that snapshot. The statements that copy catalog text go through `check`.

/** One row of the picker: the name, then the kind, the drop and the snapshot that the restore reads. */
export interface DroppedItem {
  readonly label: string;
  readonly description: string;
  readonly value: DroppedObject;
}

/** The rows of the picker, newest drop first, as `droppedObjects` reads them. */
export function droppedItems(objects: readonly DroppedObject[]): DroppedItem[] {
  return objects.map((object) => {
    const when = object.droppedTime === null ? `@${object.droppedAt}` : formatUtc(object.droppedTime);
    return {
      label: pickerLabel(object.name),
      description: `${object.kind} · dropped ${when} · snapshot ${object.lastSnapshot}`,
      value: object,
    };
  });
}

/** `name`, or `name_restored`, `name_restored_2`, ... when `taken` says the name is in use, as DuckDB compares names. */
export function restoredName(name: string, taken: ReadonlySet<string>): string {
  const free = (candidate: string): boolean => !taken.has(foldIdentifier(candidate));
  if (free(name)) return name;
  for (let count = 1; ; count++) {
    const candidate = count === 1 ? `${name}_restored` : `${name}_restored_${count}`;
    if (free(candidate)) return candidate;
  }
}

/** What the catalog stored for the object at the snapshot that the restore reads. */
export type DroppedDefinition =
  | { readonly kind: 'table'; readonly table: CreatedTable }
  | { readonly kind: 'view'; readonly view: ViewInfo }
  | { readonly kind: 'macro'; readonly macro: MacroInfo };

export interface DroppedRestore {
  readonly schemaName: string;
  readonly object: DroppedObject;
  readonly definition: DroppedDefinition;
  /** The name to create: the one it had, or `restoredName` of it when that is taken now. */
  readonly name: string;
}

function header({ schemaName, object, name }: DroppedRestore): string[] {
  const what = `the ${object.kind} ${commentName(schemaName, object.name)}`;
  const dropped = `dropped at ${snapshotText(object.droppedAt, object.droppedTime)}`;
  const from =
    object.kind === 'table'
      ? `with its rows of snapshot ${object.lastSnapshot}`
      : `as it was at snapshot ${object.lastSnapshot}`;
  return [
    `-- Restores ${what}, ${dropped}, ${from}. ${NOTHING_RUN}`,
    ...(name === object.name
      ? []
      : [
          `-- The name is taken now, so this creates ${commentName(schemaName, name)}; rename it once you have checked it.`,
        ]),
    NEW_ID,
  ];
}

// The table of Script as CREATE with its partitioning, sort order and comments, then its rows. A dropped table reads
// with AT (VERSION => n) at a snapshot where it existed, also when a newer table has taken its name.
function tableLines(
  { schemaName, object, name }: DroppedRestore,
  table: CreatedTable,
  check: CatalogCheck,
): string[] {
  const ddl = tableDdl(schemaName, { ...table, state: { ...table.state, name } }, check);
  const columns = table.state.columns.map(({ name: column }) => quoteIdentifier(column)).join(', ');
  const insert = `INSERT INTO ${qualifiedName(schemaName, name)} (${columns})\nSELECT ${columns} FROM ${qualifiedName(schemaName, object.name)}${atVersion(object.lastSnapshot)};`;
  // The rows need the table: when its CREATE TABLE stays a comment, so does the INSERT.
  return [...createLines(ddl), ...(ddl.live ? [insert] : allNeeding([insert]))];
}

function definitionLines(input: DroppedRestore, check: CatalogCheck): string[] {
  const { definition, schemaName, name } = input;
  // `CREATE`, not `OR REPLACE`: a view or macro of the name made meanwhile stays. The dropped one is not there, so the
  // note on another dialect says that its SQL is copied as stored. DuckLake keeps no comment of a macro.
  const options: DefinitionOptions = { head: 'create', note: 'copies', check };
  switch (definition.kind) {
    case 'table':
      return tableLines(input, definition.table, check);
    case 'view':
      return viewLines(schemaName, { ...definition.view, name }, options);
    case 'macro':
      return macroLines(schemaName, { ...definition.macro, name }, options);
  }
}

/** The script of Restore Dropped Object, in one transaction; DuckDB's tokenizer checks it, nothing runs. */
export function restoreDroppedScript(input: DroppedRestore, tokenize: Tokenize): Promise<string> {
  return checkedScript(
    (check) => [...header(input), '', 'BEGIN TRANSACTION;', ...definitionLines(input, check), 'COMMIT;'],
    tokenize,
  );
}
