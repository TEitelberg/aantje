import { join, sep } from 'node:path';
import { AantjeError } from '../errors';
import { collator } from '../order';
import { storedValueNames } from '../storage/config';
import type { ResolvedStorage, StoredValueName } from '../storage/config';
import { azureAccessOf } from './azure-auth';
import type { AzureAccess } from './azure-auth';
import { listBlobLevel, listDfsLevel } from './azure';
import { fetchesOwnToken } from './azure-token';
import type { Http, RawLevel } from './http';
import { listLocalLevel } from './local';
import { directoryKey, localPath, splitRemote } from './place';
import type { RemotePath } from './place';
import { listS3Level, s3TargetOf } from './s3';
import type { S3Keys } from './sigv4';

// One level of a root of the Files folder: the listing that fits the storage, then what the tree shows of it: the
// hidden directories left out, folders first, then files, each by name, at most `SHOWN` entries.

/** Most entries a folder shows; a message counts the rest. */
export const SHOWN = 1000;
/** Most entries a level reads to count them; beyond, the message says "more than". */
export const CEILING = 10_000;

/** An entry of a level as the tree shows it. */
export interface FileEntry {
  readonly name: string;
  /** The full path: the root and the key below it; a folder ends in `/` (on a disk, in its separator). */
  readonly path: string;
  readonly folder: boolean;
  readonly size?: number;
  readonly modified?: number;
}

export interface Level {
  /** Folders first, then files, by name; at most `SHOWN`. */
  readonly entries: readonly FileEntry[];
  /** Entries read but not shown. */
  readonly omitted: number;
  /** The listing stopped at `CEILING`: there are more than `omitted`. */
  readonly cut: boolean;
  /** The storage signs in with values that the connection does not have: nothing was asked, nothing is listed. */
  readonly signInMissing?: true;
}

export interface ListingDeps {
  readonly http: Http;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  /** The keys of an AWS credential chain, as the engine resolves them. */
  readonly chainKeys?: (storage: ResolvedStorage) => Promise<{ keys: S3Keys; region?: string } | undefined>;
  /** The Entra token of an Azure or OneLake service principal or credential chain, fetched by aantje. */
  readonly azureToken?: (storage: ResolvedStorage) => Promise<string>;
}

/** Which directories to leave out, as `directoryKey` writes them, and the Azure account of the short form. */
export interface Hidden {
  readonly keys: ReadonlySet<string>;
  readonly account?: string;
}

// The stored values a listing signs with. A session token is optional; a client secret fetches the token of a service
// principal.
const SIGNS_WITH: ReadonlySet<StoredValueName> = new Set([
  'keyId',
  'secretKey',
  'accountKey',
  'sasToken',
  'connectionString',
  'clientSecret',
]);

/**
 * Whether the connection's own storage signs in with stored values (keys, an account key, a SAS, a connection string,
 * a client secret) that the connection does not have: a request without them could only be refused. The global S3 settings without
 * keys are no such case: they list a public bucket unsigned.
 */
function lacksSignIn(storage: ResolvedStorage | undefined): boolean {
  if (storage === undefined || storage.legacy !== undefined) return false;
  const { config, values } = storage;
  return storedValueNames(config).some((name) => SIGNS_WITH.has(name) && !values[name]);
}

async function s3Keys(
  storage: ResolvedStorage,
  deps: ListingDeps,
): Promise<{ keys?: S3Keys; region?: string }> {
  const { config, values } = storage;
  if (config.kind === 'aws' && config.signIn === 'chain') {
    const resolved = await deps.chainKeys?.(storage);
    return resolved ?? {};
  }
  const { keyId, secretKey, sessionToken } = values;
  return keyId && secretKey ? { keys: { keyId, secretKey, ...(sessionToken ? { sessionToken } : {}) } } : {};
}

async function listS3(
  remote: RemotePath,
  storage: ResolvedStorage | undefined,
  deps: ListingDeps,
  signal: AbortSignal | undefined,
): Promise<RawLevel> {
  const config = storage?.config ?? { kind: 'aws' as const, signIn: 'keys' as const };
  if (config.kind !== 'aws' && config.kind !== 's3') {
    throw new AantjeError('CONNECTION_FAILED', 'The storage of this connection is no S3 storage.');
  }
  const { keys, region } = storage ? await s3Keys(storage, deps) : {};
  const target = s3TargetOf(config.region === undefined && region ? { ...config, region } : config, keys);
  return listS3Level(deps.http, target, remote.bucket, remote.key, CEILING, { ...deps, signal });
}

async function listAzure(
  remote: RemotePath,
  storage: ResolvedStorage | undefined,
  deps: ListingDeps,
  signal: AbortSignal | undefined,
): Promise<RawLevel> {
  // A service principal or a credential chain signs in with the token that aantje fetches for it.
  const token =
    storage && deps.azureToken && fetchesOwnToken(storage) ? await deps.azureToken(storage) : undefined;
  const access =
    storage &&
    azureAccessOf(
      token === undefined ? storage : { ...storage, values: { ...storage.values, accessToken: token } },
    );
  if (access === undefined) {
    throw new AantjeError(
      'CONNECTION_FAILED',
      'The storage of this connection is no Azure or OneLake storage.',
    );
  }
  if ('unsupported' in access) {
    throw new AantjeError('AUTH_FAILED', access.unsupported);
  }
  const options = { ...deps, signal };
  const { scheme } = remote.location;
  if (
    remote.location.family === 'onelake' ||
    scheme === 'abfss' ||
    scheme === 'abfs' ||
    access.blobHost === undefined
  ) {
    return listDfsLevel(deps.http, access, remote.bucket, remote.key.replace(/\/$/, ''), CEILING, options);
  }
  return listBlobLevel(
    deps.http,
    access as AzureAccess & { blobHost: string },
    remote.bucket,
    remote.key,
    CEILING,
    options,
  );
}

function byNameFoldersFirst(a: FileEntry, b: FileEntry): number {
  return (
    Number(b.folder) - Number(a.folder) || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1)
  );
}

/**
 * The entries of `directory` below `root`, listed with the access of the connection's storage. The caller has checked
 * that the root lies on that storage (`rootProblem`). A refusal of the storage throws with its words; a storage whose
 * sign-in values are missing is not asked (`signInMissing`).
 */
export async function listLevel(
  root: string,
  directory: string,
  storage: ResolvedStorage | undefined,
  hidden: Hidden,
  deps: ListingDeps,
  signal?: AbortSignal,
): Promise<Level> {
  const remote = splitRemote(directory);
  let entries: FileEntry[];
  let cut: boolean;
  if (remote) {
    if (lacksSignIn(storage)) return { entries: [], omitted: 0, cut: false, signInMissing: true };
    const raw =
      remote.location.family === 's3' || remote.location.family === 'r2'
        ? await listS3(remote, storage, deps, signal)
        : await listAzure(remote, storage, deps, signal);
    entries = raw.entries.map(({ key, ...entry }) => ({
      ...entry,
      name: key.startsWith(remote.key) ? key.slice(remote.key.length) : (key.split('/').at(-1) ?? key),
      path: `${remote.root}${key}${entry.folder ? '/' : ''}`,
    }));
    cut = raw.cut;
  } else {
    const folder = localPath(directory) ?? directory;
    const raw = await listLocalLevel(localPath(root) ?? root, folder, CEILING);
    entries = raw.entries.map(({ key, ...entry }) => ({
      ...entry,
      name: key,
      path: `${join(folder, key)}${entry.folder ? sep : ''}`,
    }));
    cut = raw.cut;
  }
  const visible = entries
    .filter((entry) => !entry.folder || !hidden.keys.has(directoryKey(entry.path, hidden.account) ?? ''))
    .toSorted(byNameFoldersFirst);
  return { entries: visible.slice(0, SHOWN), omitted: Math.max(0, visible.length - SHOWN), cut };
}
