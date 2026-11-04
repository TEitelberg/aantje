import { shownSnapshot } from '../actions';
import { qualifiedName, quoteIdentifier } from '../catalog/ddl';
import type { SchemaInfo } from '../catalog/model';
import { commented, newestNote, pinnedOf, selectList } from '../script';
import type { ScriptSource } from '../script';
import type { CatalogTree } from '../tree/model';
import type { NodeRef } from '../tree/refs';
import { connectionClosed } from '../messages';

export type Tree = Pick<CatalogTree, 'reader' | 'state'> & ScriptSource;
export type Ref<K extends NodeRef['kind']> = Extract<NodeRef, { kind: K }>;
export type Folder<F extends Extract<NodeRef, { kind: 'folder' }>['folder']> = Extract<
  NodeRef,
  { kind: 'folder'; folder: F }
>;

const LIST_LIMIT = 20;

export const RUN = 'Run it in a read/write SQL session.';
const DROP_FIRST = '-- To drop it before it is created again, remove the "-- " of the next line.';
export const TEMPLATE_HEADER =
  '-- The statements run as they are in a read/write SQL session; replace the names and the definitions.';
export const COMMENTED_OUT = [
  '-- Every statement in this script is commented out, so running it changes nothing.',
  '-- Remove the "-- " in front of the statements you want, replace the <placeholders> and run them in a read/write SQL session.',
];
export const DROPS_COMMENTED_OUT = [
  '-- Every statement in this script is commented out, so running it changes nothing.',
  '-- Remove the "-- " in front of the drops you want and run them in a read/write SQL session.',
];

export const blocks = (list: readonly (readonly string[])[]): string =>
  list.map((block) => block.join('\n')).join('\n\n');

/** The reader and the shown snapshot a script reads from; throws when the connection is closed. */
export function catalogOf(tree: Tree, connectionId: string, what: string) {
  const reader = tree.reader(connectionId);
  const snapshot = shownSnapshot(tree.state(connectionId));
  if (!reader || snapshot === undefined) {
    throw connectionClosed(`script the ${what}`);
  }
  return { reader, snapshot };
}

/** The items up to the list limit plus a comment counting the rest. */
export function limited<T>(items: readonly T[]): { shown: readonly T[]; more: string[] } {
  return {
    shown: items.slice(0, LIST_LIMIT),
    more: items.length > LIST_LIMIT ? [`-- ${items.length - LIST_LIMIT} more are not listed.`] : [],
  };
}

export const dropStatement = (what: 'SCHEMA' | 'TABLE' | 'VIEW', ...name: string[]): string =>
  `DROP ${what} ${qualifiedName(...name)};`;

export const dropColumnStatement = (schemaName: string, tableName: string, path: readonly string[]): string =>
  `ALTER TABLE ${qualifiedName(schemaName, tableName)} DROP COLUMN ${path.map(quoteIdentifier).join('.')};`;

/** A create script with the matching drop above it, commented out. */
export const withDrop = (preface: readonly string[], drop: string, create: string): string =>
  [...preface, DROP_FIRST, commented(drop), create].join('\n');

/** A live drop statement under a one-line description. */
export const dropScript = (what: string, tree: Tree, connectionId: string, statement: string): string =>
  [`-- Drops the ${what}. ${RUN}`, ...newestNote(tree, connectionId), statement].join('\n');

/** A script of commented-out drops, one per object. */
export function dropList(
  tree: Tree,
  connectionId: string,
  statements: readonly string[],
  empty: string,
  extra: readonly string[] = [],
): string {
  if (statements.length === 0) {
    return empty;
  }
  const { shown, more } = limited(statements);
  return [
    ...DROPS_COMMENTED_OUT,
    ...newestNote(tree, connectionId, { several: true }),
    ...extra,
    '',
    ...shown.map(commented),
    ...more,
  ].join('\n');
}

/** One query per table or view of a schema. */
export function selectScript(
  tree: Tree,
  ref: { readonly connectionId: string; readonly schema: SchemaInfo },
  names: readonly string[],
  text: { readonly intro: string; readonly empty: string },
): string {
  if (names.length === 0) {
    return text.empty;
  }
  const { shown, more } = limited(names);
  return [
    text.intro,
    '',
    selectList(ref.schema.name, shown, pinnedOf(tree, ref.connectionId)),
    ...(more.length > 0 ? ['', ...more] : []),
  ].join('\n');
}
