import { foldIdentifier, qualifiedName, quoteIdentifier, quoteLiteral } from '../catalog/ddl';
import { escapeGlob } from '../data/store-sql';
import type { TableRef } from '../data/types';
import { withoutInvisible } from '../markdown';
import { fileTypeOf, READER } from './kinds';
import type { FileKind } from './kinds';

// The scripts of the Files folder: a file, or the files of one kind on the level of a folder or in its subfolders,
// into a new table or into a table of the lake. A path is data of whoever writes to the storage: it appears only as a
// quoted literal, with the glob characters of a single file escaped so that exactly that file is read; the key of a
// folder and a column only as quoted identifiers. No name appears in a comment.

export type ImportMode = 'create' | 'insert';

/** A level of subfolders between a folder and its files. */
export interface FolderLevel {
  /** The column that keeps the folder names of the level. */
  readonly column: string;
  /** The key of a level whose folders are named `key=value` (Hive partitions); none for plain names. */
  readonly key?: string;
}

export type ImportSource =
  | { readonly kind: FileKind; readonly file: string }
  | {
      readonly kind: FileKind;
      /** The folder whose level is read. */
      readonly folder: string;
      /** The end of the names the glob reads, as written (`.csv`, `.PARQUET`). */
      readonly suffix: string;
      /** The levels of subfolders that hold the files, outermost first; none reads the folder's own level. */
      readonly levels?: readonly FolderLevel[];
    };

/**
 * The part of the pattern for a level of subfolders: the folders of its key (`year=*`, the key escaped like a path), or
 * of a plain level every folder whose name does not start with `_` or `.` (`[!_.]` is one character that is neither,
 * as in DuckDB's GLOB). Spark and Hadoop keep metadata and writes in progress in such folders (`_delta_log`,
 * `_temporary`, `.spark-staging`): neither form reads them.
 */
function levelPattern({ key }: FolderLevel): string {
  return key === undefined ? '[!_.]*/' : `${escapeGlob(key)}=*/`;
}

/**
 * The path or pattern the reader gets: one file with its glob characters escaped, or `folder/*suffix` with the part of
 * each level of subfolders in front of `*suffix`.
 */
function sourcePattern(source: ImportSource): string {
  if ('file' in source) {
    return escapeGlob(source.file);
  }
  const folder = escapeGlob(source.folder);
  const levels = (source.levels ?? []).map(levelPattern).join('');
  return `${folder.endsWith('/') ? folder : `${folder}/`}${levels}*${escapeGlob(source.suffix)}`;
}

const EXCEL = ['INSTALL excel;', 'LOAD excel;', ''];

const GLOB_COMMENT = [
  '-- Reads all files of the pattern on this level of the folder.',
  '-- To include the files of the subfolders, write **/ in front of the * of the pattern.',
];

/** Whether DuckDB reads every level as Hive partitions: each named `key=value`, no two levels with the same key. */
function hiveOnly(levels: readonly FolderLevel[]): boolean {
  const keys = levels.flatMap(({ key }) => (key === undefined ? [] : [foldIdentifier(key)]));
  return keys.length === levels.length && new Set(keys).size === keys.length;
}

/**
 * The value of a level from the path of each file, counted from its end (the file name is the last part). A
 * `key=value` folder gives its value, decoded as DuckDB decodes a Hive folder.
 */
function pathValue(level: FolderLevel, fromEnd: number): string {
  const name = `parse_path(filename)[-${fromEnd}]`;
  return level.key === undefined ? name : `url_decode(regexp_replace(${name}, '^[^=]*=', ''))`;
}

/** The comment above the statement and the SELECT that reads the source. */
function readOf(source: ImportSource): { comment: readonly string[]; select: readonly string[] } {
  const reader = READER[source.kind];
  const pattern = quoteLiteral(sourcePattern(source));
  if ('file' in source) {
    return { comment: [], select: [`SELECT * FROM ${reader}(${pattern});`] };
  }
  const levels = source.levels ?? [];
  if (levels.length === 0) {
    return { comment: GLOB_COMMENT, select: [`SELECT * FROM ${reader}(${pattern}, union_by_name = true);`] };
  }
  const depth = levels.length === 1 ? 'one level' : `${levels.length} levels`;
  const below = `-- Reads all files of the pattern in the subfolders ${depth} down, but no folder whose name starts with _ or a dot.`;
  if (hiveOnly(levels)) {
    const renamed = levels.flatMap(({ key, column }) =>
      key === undefined || key === column ? [] : [`${quoteIdentifier(key)} AS ${quoteIdentifier(column)}`],
    );
    const columns = renamed.length === 0 ? '*' : `* RENAME (${renamed.join(', ')})`;
    return {
      comment: [
        below,
        '-- DuckDB makes the key of each level a column and types its values (hive_partitioning).',
      ],
      select: [
        `SELECT ${columns} FROM ${reader}(${pattern}, union_by_name = true, hive_partitioning = true);`,
      ],
    };
  }
  return {
    comment: [
      below,
      '-- The column of each level takes the folder names from the path of the file, as text.',
    ],
    select: [
      'SELECT',
      '  * EXCLUDE (filename),',
      ...levels.map(
        (level, index) =>
          `  ${pathValue(level, levels.length - index + 1)} AS ${quoteIdentifier(level.column)}${index === levels.length - 1 ? '' : ','}`,
      ),
      `FROM ${reader}(${pattern}, union_by_name = true, hive_partitioning = false, filename = true);`,
    ],
  };
}

/** The script that imports the source into a new table (`create`) or adds its rows to a table by name (`insert`). */
export function importScript(source: ImportSource, target: TableRef, mode: ImportMode): string {
  const { comment, select } = readOf(source);
  const table = qualifiedName(target.schema, target.table);
  return [
    ...(source.kind === 'xlsx' ? EXCEL : []),
    ...comment,
    mode === 'create' ? `CREATE TABLE ${table} AS` : `INSERT INTO ${table} BY NAME`,
    ...select,
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
