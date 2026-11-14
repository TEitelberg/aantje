import { posix } from 'node:path';
import { compareText } from '../order';

// The file names of Generate Scripts come from catalog names, which are data of whoever writes the catalog. Each name
// becomes one path segment that every common file system can hold, distinct from the others of its folder also where
// the file system ignores case, and every path stays below the folder that the user chose.

/** The file at the top of the folder that holds every statement in the working order. */
export const ALL_FILE = 'create-all.sql';

/** The folder of each kind of object below its schema folder. */
const KIND_FOLDERS = { table: 'tables', view: 'views', macro: 'macros' } as const;

export type FileKind = keyof typeof KIND_FOLDERS;

/** An object that gets a file of its own. `rank` orders objects of one name and kind (a scalar and a table macro). */
export interface FileObject {
  readonly kind: FileKind;
  readonly schemaName: string;
  readonly name: string;
  readonly rank: number;
}

// What a file name cannot hold on Windows, macOS or Linux, and what hides or reorders text: control and format
// characters, line and paragraph separators, and halves of a character (lone surrogates).
const UNSAFE = /[/\\:*?"<>|\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
// Windows reserves these names for devices, also with an extension and with spaces before it (`CON.sql`, `nul .x`).
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?=\s*(\.|$))/iu;
// Most file systems take 255 bytes per name; the rest is room for a suffix and the extension.
const MAX_BYTES = 120;

/** The longest start of the text that is at most `max` bytes in UTF-8, cut between characters. */
function truncated(text: string, max: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > max) break;
    end += character.length;
  }
  return text.slice(0, end);
}

/**
 * A catalog name as one path segment: the characters a file name cannot hold become `_`, and so do dots at the start
 * (no hidden file, no `.` or `..`) and dots and spaces at the end, which Windows drops. A reserved Windows name gets a
 * `_` behind it, a long name is cut and an empty one is `_`.
 */
export function safeName(name: string): string {
  const cut = truncated(name.normalize('NFC').replace(UNSAFE, '_'), MAX_BYTES)
    .replace(/^\.+/, (dots) => '_'.repeat(dots.length))
    .replace(/[. ]+$/, (tail) => '_'.repeat(tail.length));
  return (cut === '' ? '_' : cut).replace(RESERVED, '$1_');
}

/** Names as a file system that ignores case and the composition of characters compares them. */
export const fileKey = (name: string): string => name.normalize('NFC').toUpperCase().toLowerCase();

/** The first of `stem`, `stem~2`, `stem~3` … (with the extension) that the folder does not hold yet; it is taken then. */
function unique(taken: Set<string>, stem: string, extension: string): string {
  for (let number = 1; ; number++) {
    const name = `${number === 1 ? stem : `${stem}~${number}`}${extension}`;
    if (!taken.has(fileKey(name))) {
      taken.add(fileKey(name));
      return name;
    }
  }
}

const byName = (a: FileObject, b: FileObject): number =>
  compareText(a.schemaName, b.schemaName) || compareText(a.name, b.name) || a.rank - b.rank;

/**
 * The path of each object's file below the chosen folder: `<schema>/tables|views|macros/<name>.sql`. Two objects never
 * share a path, also on a file system that ignores case: the later one by name gets a suffix (`~2`). A schema folder
 * never takes the name of `create-all.sql`.
 */
export function filePaths<T extends FileObject>(objects: readonly T[]): Map<T, readonly string[]> {
  const sorted = objects.toSorted(byName);
  const rootNames = new Set([fileKey(ALL_FILE)]);
  const schemaFolders = new Map<string, string>();
  for (const { schemaName } of sorted) {
    if (!schemaFolders.has(schemaName)) {
      schemaFolders.set(schemaName, unique(rootNames, safeName(schemaName), ''));
    }
  }
  const folderNames = new Map<string, Set<string>>();
  const paths = new Map<T, readonly string[]>();
  for (const object of sorted) {
    const schema = schemaFolders.get(object.schemaName) ?? '_';
    const folder = `${schema}/${KIND_FOLDERS[object.kind]}`;
    const taken = folderNames.get(folder) ?? new Set<string>();
    folderNames.set(folder, taken);
    paths.set(object, [schema, KIND_FOLDERS[object.kind], unique(taken, safeName(object.name), '.sql')]);
  }
  return paths;
}

/** True when `path` lies below `folder` (both POSIX paths, as a file URI has them), not at it and not outside it. */
export function isInside(folder: string, path: string): boolean {
  const relative = posix.relative(posix.resolve('/', folder), posix.resolve('/', path));
  return relative !== '' && relative.split('/')[0] !== '..' && !posix.isAbsolute(relative);
}
