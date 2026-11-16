import type { CatalogReader, SnapshotId } from '../catalog/model';
import type { TableRef } from '../data/types';
import { AantjeError } from '../errors';
import { pickerLabel } from '../messages';
import { collator } from '../order';
import type { NodeRef, TreeNode } from '../tree/refs';
import { fileTypeOf, globGroups, KIND_LABEL } from './kinds';
import { importScript, proposedTableName } from './scripts';
import type { ImportMode, ImportSource } from './scripts';

// Script as Import into New Table... and Script as Insert into Existing Table... on a file or a folder of the Files
// folder: what to read, then where to put it, then a script that opens unsaved and bound to the connection. Nothing
// runs. Names from the storage and the catalog reach the pickers only through `pickerLabel`.

export interface PickChoice<T> {
  readonly label: string;
  readonly description?: string;
  readonly value: T;
}

/** The questions of the flow; the VS Code glue shows them. */
export interface ImportUi {
  pick<T>(
    title: string,
    placeholder: string,
    items: readonly PickChoice<T>[],
    active?: T,
  ): Promise<T | undefined>;
  input(title: string, prompt: string, value: string): Promise<string | undefined>;
  info(message: string): void;
}

export interface ImportEnv {
  /** The children of a folder node (one level of the storage, cached by the tree), the reader and newest snapshot. */
  readonly tree: {
    children(node: TreeNode): Promise<TreeNode[]>;
    reader(connectionId: string): CatalogReader | undefined;
    state(connectionId: string): { readonly latestSnapshot?: SnapshotId };
  };
  readonly ui: ImportUi;
  /** Opens the text as a new SQL document bound to the connection; it never runs it. */
  readonly openSql: (connectionId: string, text: string) => Promise<void>;
}

const NO_FILES =
  'This folder holds no CSV, Parquet or JSON files on its level. Excel files are imported one file at a time.';

/** What a node reads: the file itself, or the files of one kind on the level of a folder (asked when several). */
async function sourceOf(env: ImportEnv, node: TreeNode, title: string): Promise<ImportSource | undefined> {
  const { ref } = node;
  if (ref.kind === 'file') {
    const type = fileTypeOf(ref.entry.name);
    return type && { kind: type.kind, file: ref.entry.path };
  }
  if (ref.kind !== 'fileFolder') return undefined;
  const children = await env.tree.children(node);
  // A level that the storage refused or that is not listed says why, rather than that it holds no files.
  const failed = children.find(({ ref: child, icon }) => child.kind === 'message' && icon === 'error');
  if (failed) {
    throw new AantjeError('CONNECTION_FAILED', failed.label);
  }
  const files = children.flatMap(({ ref: child }) => (child.kind === 'file' ? [child.entry.name] : []));
  const groups = globGroups(files);
  if (groups.length === 0) {
    env.ui.info(NO_FILES);
    return undefined;
  }
  const group =
    groups.length === 1
      ? groups[0]
      : await env.ui.pick(
          title,
          'Which files of this folder? One table takes the files of one kind.',
          groups.map((item) => ({
            // A known ending in the letter case of the files; no name of a file.
            label: `*${item.suffix}`,
            description: `${item.count} ${item.count === 1 ? 'file' : 'files'} · ${KIND_LABEL[item.kind]}`,
            value: item,
          })),
        );
  return group && { kind: group.kind, folder: ref.place.path, suffix: group.suffix };
}

function nameOf(ref: NodeRef): string {
  if (ref.kind === 'file') return ref.entry.name;
  if (ref.kind === 'fileFolder')
    return (
      ref.place.path
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .at(-1) ?? ''
    );
  return '';
}

async function newTable(
  env: ImportEnv,
  reader: CatalogReader,
  snapshot: SnapshotId,
  proposal: string,
  title: string,
): Promise<TableRef | undefined> {
  const schemas = (await reader.schemas(snapshot)).toSorted((a, b) => collator.compare(a.name, b.name));
  const schema = await env.ui.pick(
    title,
    'Schema of the new table',
    schemas.map((item) => ({ label: pickerLabel(item.name), value: item.name })),
    schemas.some((item) => item.name === 'main') ? 'main' : undefined,
  );
  if (schema === undefined) return undefined;
  const table = await env.ui.input(title, 'Name of the new table', proposal);
  return table === undefined || table.trim() === '' ? undefined : { schema, table: table.trim() };
}

async function existingTable(
  env: ImportEnv,
  reader: CatalogReader,
  snapshot: SnapshotId,
  title: string,
): Promise<TableRef | undefined> {
  const tables = (await reader.entries(snapshot))
    .filter((entry) => entry.kind === 'table')
    .toSorted((a, b) => collator.compare(a.schemaName, b.schemaName) || collator.compare(a.name, b.name));
  if (tables.length === 0) {
    env.ui.info('The lake has no table to insert into.');
    return undefined;
  }
  return env.ui.pick(
    title,
    'Table the rows go into, matched by column name',
    tables.map((entry) => ({
      label: pickerLabel(`${entry.schemaName}.${entry.name}`),
      value: { schema: entry.schemaName, table: entry.name },
    })),
  );
}

/** Asks what to read and where it goes, then opens the script; returns whether a script was opened. */
export async function importFlow(env: ImportEnv, node: TreeNode, mode: ImportMode): Promise<boolean> {
  const { connectionId } = node.ref;
  const reader = env.tree.reader(connectionId);
  const snapshot = env.tree.state(connectionId).latestSnapshot;
  if (reader === undefined || snapshot === undefined) {
    env.ui.info('Connect to the catalog first to write an import script.');
    return false;
  }
  const title = mode === 'create' ? 'Import into New Table' : 'Insert into Existing Table';
  const source = await sourceOf(env, node, title);
  if (source === undefined) return false;
  const target =
    mode === 'create'
      ? await newTable(env, reader, snapshot, proposedTableName(nameOf(node.ref)), title)
      : await existingTable(env, reader, snapshot, title);
  if (target === undefined) return false;
  await env.openSql(connectionId, importScript(source, target, mode));
  return true;
}
