import { fileLocation, LEADING_BLANKS, NETWORK_HOST } from '../../catalog/locations';
import type { StoredPath } from '../../catalog/locations';
import type { StorageConfig } from '../../storage/config';
import { azureHostsOf, locate } from '../../storage/location';
import type { StorageLocation } from '../../storage/location';
import { dataPathQuery } from '../attach';
import type { TableRef } from '../types';
import { rangeFilesQuery, snapshotFilesQuery } from './queries';
import type { Rows } from './queries';

// A URL scheme at the start of a path: `scheme://`. A Windows drive (`c:/x`) has no `//`, so it never matches.
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;

// Where a file would be read from: this machine (`local`), the storage of the connection (`home`), or a server the
// catalog names (`origin`, lower case, for comparison and the message).
type Server = 'local' | 'home' | { readonly origin: string };

// Whether an object-store path lies on the service of the connection's storage: the S3 endpoint (any bucket there), the
// R2 account, the hosts of the Azure account (any container), OneLake. The service is the unit, not the bucket: what the
// connection's account may read is the storage's decision. Aliases of the same service (s3a, s3n; az, abfss) count. A
// connection without a storage of its own keeps the rule it always had: `s3://` goes to the configured endpoint.
function isHomeService(place: StorageLocation, storage: StorageConfig | undefined): boolean {
  switch (place.family) {
    case 's3':
      return (
        storage === undefined ||
        storage.kind === 'aws' ||
        (storage.kind === 's3' && storage.accountId === undefined)
      );
    case 'r2':
      return storage?.kind === 's3' && storage.accountId !== undefined;
    case 'azure':
      // The short form `az://container/...` has no host: its account is the one of the secret.
      return (
        storage?.kind === 'azure' &&
        (place.host === undefined || azureHostsOf(storage.account).includes(place.host))
      );
    case 'onelake':
      return storage?.kind === 'onelake';
    default:
      return false;
  }
}

// The host of a network path (`//host`, after backslashes became slashes); two separators with no host after them name
// this machine, not a server.
function networkServer(path: string): Server {
  const origin = new RegExp(`^${LEADING_BLANKS}(${NETWORK_HOST})`).exec(path)?.[1];
  return origin !== undefined && /[^/]$/.test(origin) ? { origin } : 'local';
}

// The server a file path resolves to; `path` is lower case with backslashes turned into slashes. A `file:` URL with a
// real authority is a network host (SMB/NTLM via the operating system) and is treated like a UNC path; an empty or
// `localhost` authority is this machine, unless the path after it is itself a UNC (`file:////host`).
function serverOf(path: string, storage: StorageConfig | undefined): Server {
  const scheme = SCHEME.exec(path)?.[0];
  if (scheme === undefined) {
    return networkServer(path);
  }
  const name = scheme.slice(0, -3);
  if (isHomeService(locate(path), storage)) {
    return 'home';
  }
  const rest = path.slice(scheme.length);
  if (name === 'file') {
    const authority = rest.split('/')[0] ?? '';
    return authority !== '' && authority !== 'localhost'
      ? { origin: `file://${authority}` }
      : networkServer(rest.slice(authority.length));
  }
  return { origin: `${name}://${rest.split('/')[0] ?? ''}` };
}

const normalise = (path: string): string => path.replaceAll('\\', '/').toLowerCase();

const storedPath = (path: unknown, relative: unknown): StoredPath => ({
  path: typeof path === 'string' ? path : '',
  // `path_is_relative` is a boolean on DuckDB metadata, an integer on SQLite/PostgreSQL.
  relative: relative === true || relative === 1 || relative === 1n || relative === '1',
});

// The absolute resolved paths of the table's data and delete files visible at the snapshot, from the engine's own
// resolver (which also applies absolute schema and table paths).
async function snapshotFilePaths(
  rows: Rows,
  table: TableRef,
  snapshot: number | undefined,
): Promise<string[]> {
  const rows_ = await rows(snapshotFilesQuery(table, snapshot));
  return rows_.flatMap(([f]) => (typeof f === 'string' ? [f] : []));
}

async function rangeFilePaths(
  rows: Rows,
  table: TableRef,
  at: string,
  range: { readonly from: number; readonly to: number },
  dataPath: string,
): Promise<string[]> {
  const result = await rows(rangeFilesQuery(table, at, range));
  return result.map((row) => {
    const [path, pathRelative, tablePath, tableRelative, schemaPath, schemaRelative] = row;
    return fileLocation(
      dataPath,
      storedPath(schemaPath, schemaRelative),
      storedPath(tablePath, tableRelative),
      storedPath(path, pathRelative),
    );
  });
}

// The stored data path of the catalog, '' when there is none.
export async function storedDataPath(rows: Rows): Promise<string> {
  const value = (await rows(dataPathQuery()))[0]?.[0];
  return typeof value === 'string' ? value : '';
}

// The servers, other than the home of the lake, that the table's data or delete files lie on. A catalog file path is a
// URL for DuckDB, which would request any `http(s)://`, `hf://`, `gs://` or `file://host` the catalog names, and the
// operating system contacts the host of a network path (`\\host`). Files on the storage service of the connection (its S3 endpoint,
// R2 account, Azure account or OneLake) are at home in any bucket or container. The data path of the catalog is the home: a lake on a share or a server is read, and the connection is
// the trust. For Show Changes the files are those the whole range can read.
export async function foreignOrigins(
  rows: Rows,
  table: TableRef,
  snapshot: number | undefined,
  at: string,
  range: { readonly from: number; readonly to: number } | undefined,
  base: string,
  storage?: StorageConfig,
): Promise<string[]> {
  // The table exists (the caller found it), so a failing listing is a real failure and is not swallowed.
  const paths = range
    ? await rangeFilePaths(rows, table, at, range, base)
    : await snapshotFilePaths(rows, table, snapshot);
  const home = serverOf(normalise(base), storage);
  const homeOrigin = typeof home === 'object' ? home.origin : undefined;
  return [
    ...new Set(
      paths.flatMap((path) => {
        const server = serverOf(normalise(path), storage);
        return typeof server === 'object' && server.origin !== homeOrigin ? [server.origin] : [];
      }),
    ),
  ];
}

export const listOrigins = (origins: readonly string[]): string =>
  origins
    .slice(0, 3)
    .map((origin) => JSON.stringify(origin.slice(0, 120)))
    .join(', ');
