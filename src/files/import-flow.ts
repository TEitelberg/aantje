import { sameIdentifier } from '../catalog/ddl';
import type { CatalogReader, SnapshotId } from '../catalog/model';
import type { TableRef } from '../data/types';
import { AantjeError } from '../errors';
import { withoutInvisible } from '../markdown';
import { pickerLabel } from '../messages';
import { collator } from '../order';
import type { NodeRef, TreeNode } from '../tree/refs';
import { fileTypeOf, globGroups, KIND_LABEL } from './kinds';
import type { SuffixGroup } from './kinds';
import { importScript, proposedTableName } from './scripts';
import type { FolderLevel, ImportMode, ImportSource } from './scripts';

// Script as Import into New Table... and Script as Insert into Existing Table... on a file or a folder of the Files
// folder: what to read, then where to put it, then a script that opens unsaved and bound to the connection. Nothing
// runs. Names from the storage and the catalog reach the pickers only through `pickerLabel`. A folder whose files lie
// in subfolders (Hive partitions such as `year=2026/month=09/`) is read whole, the folder names as columns.

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
  /** `validate` says why a value cannot be taken, or nothing; the glue shows it while the user types. */
  input(
    title: string,
    prompt: string,
    value: string,
    validate?: (value: string) => string | undefined,
  ): Promise<string | undefined>;
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

/** Most levels of subfolders that the import goes down to find the files of a folder. */
const DEEPEST = 8;

const NONE_BELOW = `No CSV, Parquet or JSON files on the level of this folder or in its first subfolders, down to ${DEEPEST} levels. Excel files are imported one file at a time.`;

/** The children of a folder; a level that the storage refused or that is not listed throws with the reason. */
async function listed(env: ImportEnv, node: TreeNode): Promise<TreeNode[]> {
  const children = await env.tree.children(node);
  // The reason rather than that the level holds no files. The message that counts the entries a level does not show
  // is no failure: the level counts with what it shows.
  const failed = children.find(({ ref: child, icon }) => child.kind === 'message' && icon === 'error');
  if (failed) {
    throw new AantjeError('CONNECTION_FAILED', failed.label);
  }
  return children;
}

const fileNames = (children: readonly TreeNode[]): string[] =>
  children.flatMap(({ ref }) => (ref.kind === 'file' ? [ref.entry.name] : []));

/**
 * The subfolders that may hold data. By the convention of Spark and Hadoop a folder whose name starts with `_` or `.`
 * holds metadata or a write in progress (`_delta_log`, `_temporary`, `.spark-staging`): the walk never goes into it,
 * and it does not decide whether a level is Hive.
 */
const subfolders = (children: readonly TreeNode[]): TreeNode[] =>
  children.filter(({ ref }) => ref.kind === 'fileFolder' && !/^[_.]/.test(nameOf(ref)));

/**
 * The kind to read: the only one, or the one the user picks. Below a folder the count would be the one of a single
 * subfolder, so the kind goes without it.
 */
function groupOf(
  env: ImportEnv,
  title: string,
  groups: readonly SuffixGroup[],
  below: boolean,
): Promise<SuffixGroup | undefined> {
  if (groups.length === 1) return Promise.resolve(groups[0]);
  return env.ui.pick(
    title,
    `Which files ${below ? 'below' : 'of'} this folder? One table takes the files of one kind.`,
    groups.map((item) => ({
      // A known ending in the letter case of the files; no name of a file.
      label: `*${item.suffix}`,
      description: below
        ? KIND_LABEL[item.kind]
        : `${item.count} ${item.count === 1 ? 'file' : 'files'} · ${KIND_LABEL[item.kind]}`,
      value: item,
    })),
  );
}

/** A level of subfolders on the way to the files. */
interface FoundLevel {
  /** The name of the subfolder that the walk went into, to show. */
  readonly example: string;
  /** The key, when every subfolder listed on the level (but those of metadata) is named `key=value` with it (Hive). */
  readonly key?: string;
}

/** The key of a Hive folder name (`year` of `year=2026`); none for a plain name. */
function hiveKey(name: string): string | undefined {
  const at = name.indexOf('=');
  return at > 0 ? name.slice(0, at) : undefined;
}

function levelOf(folders: readonly TreeNode[]): FoundLevel {
  const names = folders.map(({ ref }) => nameOf(ref));
  const keys = new Set(names.map(hiveKey));
  const [key] = keys;
  return { example: names[0] ?? '', ...(keys.size === 1 && key !== undefined ? { key } : {}) };
}

/**
 * Goes down the first subfolder of each level that may hold data, with the tree's listing, until a level holds files
 * of a kind that one glob reads; at most `DEEPEST` levels. Returns the levels on the way and the kinds of the files
 * found. It lists one path, not every folder of a large lake: the script's glob reads the other subfolders of the same
 * depth.
 */
async function filesBelow(
  env: ImportEnv,
  children: readonly TreeNode[],
): Promise<{ levels: FoundLevel[]; groups: SuffixGroup[] } | undefined> {
  const levels: FoundLevel[] = [];
  let level = children;
  while (levels.length < DEEPEST) {
    const folders = subfolders(level);
    const [first] = folders;
    if (first === undefined) return undefined;
    levels.push(levelOf(folders));
    level = await listed(env, first);
    const groups = globGroups(fileNames(level));
    if (groups.length > 0) return { levels, groups };
  }
  return undefined;
}

/** The proposed columns: the key of a Hive level, `folder` for a plain one (numbered when there are several). */
function proposals(levels: readonly FoundLevel[]): string[] {
  const plain = levels.filter(({ key }) => key === undefined).length;
  let number = 0;
  return levels.map(({ key }) => {
    if (key !== undefined) return withoutInvisible(key);
    number += 1;
    return plain === 1 ? 'folder' : `folder_${number}`;
  });
}

/** Why a name cannot be the column of the next level: an earlier level keeps its folder names there. */
function takenBy(chosen: readonly FolderLevel[], name: string): string | undefined {
  const other = chosen.findIndex(({ column }) => sameIdentifier(column, name.trim()));
  return other < 0 ? undefined : `Level ${other + 1} keeps its folder names in this column already.`;
}

/** Asks for the column of each level. Escape or an empty name cancels; the column of an earlier level is refused. */
async function columnsOf(
  env: ImportEnv,
  title: string,
  levels: readonly FoundLevel[],
): Promise<FolderLevel[] | undefined> {
  const proposed = proposals(levels);
  const chosen: FolderLevel[] = [];
  for (const [index, level] of levels.entries()) {
    const earlier = [...chosen];
    const answer = await env.ui.input(
      title,
      `Column for the folder names of level ${index + 1}, such as ${pickerLabel(level.example)}`,
      proposed[index] ?? '',
      (name) => takenBy(earlier, name),
    );
    if (answer === undefined || answer.trim() === '') return undefined;
    // The editor refuses such a name while the user types; an answer that still takes it ends the flow.
    const refused = takenBy(earlier, answer);
    if (refused !== undefined) {
      env.ui.info(refused);
      return undefined;
    }
    chosen.push({ column: answer.trim(), ...(level.key === undefined ? {} : { key: level.key }) });
  }
  return chosen;
}

/**
 * The files below a folder whose own level holds none: the levels of subfolders that hold them, the question whether
 * to read them all, the kind when there are several, and the column of each level.
 */
async function sourceBelow(
  env: ImportEnv,
  folder: string,
  children: readonly TreeNode[],
  title: string,
): Promise<ImportSource | undefined> {
  const found = await filesBelow(env, children);
  if (found === undefined) {
    env.ui.info(NONE_BELOW);
    return undefined;
  }
  const { levels, groups } = found;
  const depth = levels.length === 1 ? 'one level' : `${levels.length} levels`;
  const all = await env.ui.pick(
    title,
    `The files lie in subfolders, ${depth} down. Import all files below this folder?`,
    [
      {
        label: 'Import all files below this folder',
        description: levels.map(({ example }) => pickerLabel(example)).join(' / '),
        value: true,
      },
    ],
  );
  if (all !== true) return undefined;
  const group = await groupOf(env, title, groups, true);
  if (group === undefined) return undefined;
  const columns = await columnsOf(env, title, levels);
  return columns && { kind: group.kind, folder, suffix: group.suffix, levels: columns };
}

/**
 * What a node reads: the file itself, or the files of one kind on the level of a folder (asked when several). A folder
 * whose level holds no such files but subfolders reads the files below them.
 */
async function sourceOf(env: ImportEnv, node: TreeNode, title: string): Promise<ImportSource | undefined> {
  const { ref } = node;
  if (ref.kind === 'file') {
    const type = fileTypeOf(ref.entry.name);
    return type && { kind: type.kind, file: ref.entry.path };
  }
  if (ref.kind !== 'fileFolder') return undefined;
  const children = await listed(env, node);
  const groups = globGroups(fileNames(children));
  if (groups.length > 0) {
    const group = await groupOf(env, title, groups, false);
    return group && { kind: group.kind, folder: ref.place.path, suffix: group.suffix };
  }
  if (subfolders(children).length > 0) return sourceBelow(env, ref.place.path, children, title);
  env.ui.info(NO_FILES);
  return undefined;
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
