/** A stored path with the flag that says whether it is relative to the level above (`path_is_relative`). */
export interface StoredPath {
  readonly path: string;
  readonly relative: boolean;
}

/** Joins `base` and `relative` with exactly one `/`; an empty base returns `relative`. */
export function joinPath(base: string, relative: string): string {
  if (base === '') {
    return relative;
  }
  return `${base.endsWith('/') ? base : `${base}/`}${relative}`;
}

/** Blanks and NUL a path may start with; an engine or the operating system may skip them. Regular expression source. */
export const LEADING_BLANKS = String.raw`[\s\x00\xa0]*`;

/**
 * Regular expression source for the host part of a network path: Windows UNC `\\host\share`, `//host/share`,
 * `\\?\UNC\host`, `\\.\...`, `\\host@80\...`. Two separators of either kind start it. It has no scheme, so DuckDB hands
 * it to the operating system, which contacts the host (SMB, WebDAV). Where the operating system does not treat such a
 * path as a network path it names a local file, which is refused all the same: the rule does not depend on the
 * platform.
 */
export const NETWORK_HOST = String.raw`[\\/]{2}(?:[?.][\\/](?:[Uu][Nn][Cc][\\/])?)?[^\\/]*`;

const NETWORK_PATH = new RegExp(`^${LEADING_BLANKS}${NETWORK_HOST}`);

/** Whether `path` names a network host without a scheme. */
export function isNetworkPath(path: string): boolean {
  return NETWORK_PATH.test(path);
}

/**
 * Whether `path` lies below the lake's data path. A catalog can name any path or URL, so another scheme, another root,
 * a `..` segment or a control character does not qualify.
 */
export function isBelowDataPath(path: string, dataPath: string | null): boolean {
  if (dataPath === null || dataPath === '') return false;
  // eslint-disable-next-line no-control-regex -- a NUL or newline in a path is never a file of the lake
  if (/[\x00-\x1f]/.test(path)) return false;
  const slashes = (text: string): string => text.replaceAll('\\', '/');
  const root = slashes(dataPath);
  return (
    slashes(path).startsWith(root.endsWith('/') ? root : `${root}/`) &&
    !slashes(path).split('/').includes('..')
  );
}

function below(parent: string, stored: StoredPath): string {
  return stored.relative ? joinPath(parent, stored.path) : stored.path;
}

/** The directory of a schema, ending in `/`: data path and schema path, unless the schema path is marked absolute. */
export function schemaDirectory(dataPath: string, schema: StoredPath): string {
  return joinPath(below(dataPath, schema), '');
}

/** The directory of a table, ending in `/`: data path, schema path, table path, each unless marked absolute. */
export function tableDirectory(dataPath: string, schema: StoredPath, table: StoredPath): string {
  return joinPath(below(below(dataPath, schema), table), '');
}

/** Where DuckLake keeps a file, as `ducklake_list_files` reports it. */
export function fileLocation(
  dataPath: string,
  schema: StoredPath,
  table: StoredPath,
  file: StoredPath,
): string {
  return below(below(below(dataPath, schema), table), file);
}
