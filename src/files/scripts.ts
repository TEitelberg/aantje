import { qualifiedName, quoteLiteral } from '../catalog/ddl';
import { escapeGlob } from '../data/store-sql';
import type { TableRef } from '../data/types';
import { withoutInvisible } from '../markdown';
import { fileTypeOf, READER } from './kinds';
import type { FileKind } from './kinds';

// The scripts of the Files folder: a file, or the files of one kind on the level of a folder, into a new table or into
// a table of the lake. A path is data of whoever writes to the storage: it appears only as a quoted literal, with the
// glob characters of a single file escaped so that exactly that file is read. No name appears in a comment.

export type ImportMode = 'create' | 'insert';

export type ImportSource =
  | { readonly kind: FileKind; readonly file: string }
  | {
      readonly kind: FileKind;
      /** The folder whose level is read. */
      readonly folder: string;
      /** The end of the names the glob reads, as written (`.csv`, `.PARQUET`). */
      readonly suffix: string;
    };

/** The path or pattern the reader gets: one file with its glob characters escaped, or `folder/*suffix`. */
function sourcePattern(source: ImportSource): string {
  if ('file' in source) {
    return escapeGlob(source.file);
  }
  const folder = escapeGlob(source.folder);
  return `${folder.endsWith('/') ? folder : `${folder}/`}*${escapeGlob(source.suffix)}`;
}

const EXCEL = ['INSTALL excel;', 'LOAD excel;', ''];

const GLOB_COMMENT = [
  '-- Reads all files of the pattern on this level of the folder.',
  '-- To include the files of the subfolders, write **/ in front of the * of the pattern.',
];

/** The script that imports the source into a new table (`create`) or adds its rows to a table by name (`insert`). */
export function importScript(source: ImportSource, target: TableRef, mode: ImportMode): string {
  const folder = !('file' in source);
  const options = folder ? ', union_by_name = true' : '';
  const read = `SELECT * FROM ${READER[source.kind]}(${quoteLiteral(sourcePattern(source))}${options});`;
  const table = qualifiedName(target.schema, target.table);
  return [
    ...(source.kind === 'xlsx' ? EXCEL : []),
    ...(folder ? GLOB_COMMENT : []),
    mode === 'create' ? `CREATE TABLE ${table} AS` : `INSERT INTO ${table} BY NAME`,
    read,
    '',
  ].join('\n');
}

/** The table name proposed for a file (its name without the ending of its kind) or a folder; never empty. */
export function proposedTableName(name: string): string {
  const visible = withoutInvisible(name).replace(/[\\/]+$/, '');
  const type = fileTypeOf(visible);
  const base = (type === undefined ? visible : visible.slice(0, visible.length - type.suffix.length)).trim();
  return base === '' ? 'imported' : base;
}
