import { posix } from 'node:path';
import { fileKey, isInside } from './files';

// Writes the files of Generate Scripts below the folder that the user chose, through a port: the VS Code file system in
// the extension, Node's in the tests. Nothing is written through a symbolic link, and nothing at all while a path is
// taken by something that is not what the run writes there.

/** What a path holds; a symbolic link is `link`, whatever it points to. */
export type EntryKind = 'file' | 'directory' | 'link' | 'other';

/** The file system below the chosen folder; a path is a list of segments relative to it. */
export interface FolderPort {
  /** What is at the path; undefined when nothing is. */
  kind(path: readonly string[]): Promise<EntryKind | undefined>;
  list(path: readonly string[]): Promise<readonly (readonly [string, EntryKind])[]>;
  createDirectory(path: readonly string[]): Promise<void>;
  writeFile(path: readonly string[], content: Uint8Array): Promise<void>;
}

/** A file to write: its path below the folder and its text, with `\n` line ends. */
export interface PlannedFile {
  readonly path: readonly string[];
  readonly text: string;
}

export type WriteOutcome =
  | {
      readonly kind: 'written';
      readonly files: number;
      /** `.sql` files below the schema folders that no file of this run matches, as `a/tables/b.sql`, sorted. */
      readonly unmatched: readonly string[];
    }
  /** Files exist, and the user did not want them overwritten: nothing was written. */
  | { readonly kind: 'declined' }
  /** A path is a symbolic link, or holds a file where a folder belongs (or the other way round). */
  | { readonly kind: 'refused'; readonly path: string; readonly reason: 'link' | 'taken' };

// How deep the search for files that no object matches goes below a schema folder.
const MAX_DEPTH = 4;

const shown = (path: readonly string[]): string => path.join('/');

/** Every folder that the files need, parents first. */
function foldersOf(files: readonly PlannedFile[]): string[][] {
  const folders = new Map<string, string[]>();
  for (const { path } of files) {
    for (let length = 1; length < path.length; length++) {
      const folder = path.slice(0, length);
      folders.set(shown(folder), folder);
    }
  }
  return [...folders.values()].toSorted((a, b) => a.length - b.length);
}

type Problem = { readonly path: string; readonly reason: 'link' | 'taken' };

/** What is at a path that should hold a `want` or nothing: nothing yet, one already, or why it cannot be written. */
async function stateOf(
  port: FolderPort,
  path: readonly string[],
  want: 'file' | 'directory',
): Promise<'free' | 'exists' | Problem> {
  const kind = await port.kind(path);
  if (kind === undefined) return 'free';
  if (kind === want) return 'exists';
  return { path: shown(path), reason: kind === 'link' ? 'link' : 'taken' };
}

/** The `.sql` files below a folder, without following a symbolic link. */
async function sqlFilesBelow(port: FolderPort, folder: readonly string[], depth = 0): Promise<string[][]> {
  if (depth > MAX_DEPTH) return [];
  const found: string[][] = [];
  for (const [name, kind] of await port.list(folder)) {
    if (kind === 'directory') found.push(...(await sqlFilesBelow(port, [...folder, name], depth + 1)));
    else if (kind === 'file' && name.toLowerCase().endsWith('.sql')) found.push([...folder, name]);
  }
  return found;
}

/** The `.sql` files below the schema folders of the files that none of them matches. */
async function unmatchedFiles(port: FolderPort, files: readonly PlannedFile[]): Promise<string[]> {
  const written = new Set(files.map(({ path }) => path.map(fileKey).join('/')));
  const schemaFolders = [
    ...new Set(files.flatMap(({ path }) => (path.length > 1 && path[0] !== undefined ? [path[0]] : []))),
  ];
  const found = (await Promise.all(schemaFolders.map((folder) => sqlFilesBelow(port, [folder])))).flat();
  return found
    .filter((path) => !written.has(path.map(fileKey).join('/')))
    .map(shown)
    .toSorted();
}

/**
 * Writes the files: first every path is checked, and the run stops before writing anything when one is a symbolic
 * link or taken by the wrong kind of entry. When files exist, `overwrite` is asked once for all of them. Each path is
 * checked again right before it is created or written.
 */
export async function writeFiles(
  port: FolderPort,
  files: readonly PlannedFile[],
  overwrite: (existing: number, total: number) => Promise<boolean>,
): Promise<WriteOutcome> {
  const folders = foldersOf(files);
  let existing = 0;
  for (const [path, want] of [
    ...folders.map((folder) => [folder, 'directory'] as const),
    ...files.map(({ path: file }) => [file, 'file'] as const),
  ]) {
    const state = await stateOf(port, path, want);
    if (typeof state === 'object') return { kind: 'refused', ...state };
    if (state === 'exists' && want === 'file') existing++;
  }
  if (existing > 0 && !(await overwrite(existing, files.length))) return { kind: 'declined' };
  for (const folder of folders) {
    const state = await stateOf(port, folder, 'directory');
    if (typeof state === 'object') return { kind: 'refused', ...state };
    if (state === 'free') await port.createDirectory(folder);
  }
  const encoder = new TextEncoder();
  for (const { path, text } of files) {
    const state = await stateOf(port, path, 'file');
    if (typeof state === 'object') return { kind: 'refused', ...state };
    await port.writeFile(path, encoder.encode(text));
  }
  return { kind: 'written', files: files.length, unmatched: await unmatchedFiles(port, files) };
}

// The bits of VS Code's `FileType`: a symbolic link has its own bit, next to the kind of what it points to.
const FILE = 1;
const DIRECTORY = 2;
const SYMBOLIC_LINK = 64;

/** What an entry is by the `FileType` bits of VS Code's file system; a symbolic link is `link`, also a broken one. */
export function entryKind(type: number): EntryKind {
  if ((type & SYMBOLIC_LINK) !== 0) return 'link';
  if ((type & DIRECTORY) !== 0) return 'directory';
  return (type & FILE) !== 0 ? 'file' : 'other';
}

/** The calls of a file system by POSIX path, as VS Code's `workspace.fs` makes them, with `FileType` bits. */
export interface FileSystemCalls {
  stat(path: string): PromiseLike<{ readonly type: number }>;
  readDirectory(path: string): PromiseLike<readonly (readonly [string, number])[]>;
  createDirectory(path: string): PromiseLike<void>;
  writeFile(path: string, content: Uint8Array): PromiseLike<void>;
  /** True for the error of `stat` on a path where nothing is. */
  notFound(error: unknown): boolean;
}

/**
 * The folder at the POSIX path `root` through the file system; every path is checked to stay below it. A backslash
 * counts as a separator, as on Windows.
 */
export function folderPort(root: string, fs: FileSystemCalls): FolderPort {
  const pathOf = (path: readonly string[]): string => {
    const joined = posix.join(root, ...path.map((segment) => segment.replaceAll('\\', '/')));
    if (!isInside(root, joined)) {
      throw new Error(`Generate Scripts made a path outside the chosen folder: ${path.join('/')}`);
    }
    return joined;
  };
  return {
    async kind(path) {
      try {
        return entryKind((await fs.stat(pathOf(path))).type);
      } catch (error) {
        if (fs.notFound(error)) return undefined;
        throw error;
      }
    },
    async list(path) {
      const entries = await fs.readDirectory(pathOf(path));
      return entries.map(([name, type]) => [name, entryKind(type)] as const);
    },
    async createDirectory(path) {
      await fs.createDirectory(pathOf(path));
    },
    async writeFile(path, content) {
      await fs.writeFile(pathOf(path), content);
    },
  };
}
