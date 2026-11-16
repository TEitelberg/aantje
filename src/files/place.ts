import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorageConfig } from '../storage/config';
import { isHomeService } from '../data/guard/file-origins';
import { locate } from '../storage/location';
import type { StorageLocation } from '../storage/location';

// Where the roots of the Files folder are and what a path is on its storage: the bucket, container or workspace and
// the key below it. Pure: it reads text and touches neither the disk nor the network. Paths come from the catalog and
// from the profile, so a root is only listed on the storage of the connection.

/** The storages the Files folder lists. */
export type ListedFamily = 'local' | 's3' | 'r2' | 'azure' | 'onelake';

/** A path on an object store, split into its root (bucket, container, workspace) and the key below it. */
export interface RemotePath {
  readonly location: StorageLocation & { readonly family: Exclude<ListedFamily, 'local'> };
  /** The root in the form `locate` writes it, ending in `/`. */
  readonly root: string;
  /** The bucket, container or workspace. */
  readonly bucket: string;
  /** The key below the root: `''` for the root itself, a folder ends in `/`. */
  readonly key: string;
}

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is;

/** The parts of a path on S3, R2, Azure or OneLake; undefined for a local path, another scheme or a path without bucket. */
export function splitRemote(path: string): RemotePath | undefined {
  const match = SCHEME.exec(path.trim());
  const location = locate(path);
  const { family, bucket } = location;
  if (
    !match ||
    bucket === undefined ||
    (family !== 's3' && family !== 'r2' && family !== 'azure' && family !== 'onelake')
  ) {
    return undefined;
  }
  const segments = (match[2] ?? '').split('/');
  // `az://host/container/key` names the host first; the other forms start with the bucket or `container@host`.
  const named =
    family !== 's3' && family !== 'r2' && !(segments[0] ?? '').includes('@') && location.host !== undefined;
  const key = segments.slice(named ? 2 : 1).join('/');
  return { location: { ...location, family }, root: location.root, bucket, key };
}

/** A local path of the disk: a `file:` URL becomes a path; undefined when it cannot. */
export function localPath(path: string): string | undefined {
  const text = path.trim();
  if (/^file:/i.test(text)) {
    try {
      return fileURLToPath(text);
    } catch {
      return undefined;
    }
  }
  return text === '' || SCHEME.test(text) ? undefined : text;
}

/** The family a path is listed as; undefined for a storage that the Files folder does not list (GCS, HTTP, ...). */
export function familyOf(path: string): ListedFamily | undefined {
  if (splitRemote(path)) return splitRemote(path)?.location.family;
  return localPath(path) === undefined ? undefined : 'local';
}

/**
 * The root of the Files folder without `fileRoots`: the bucket, container or OneLake workspace of the data path, or for
 * a local data path the folder above it. Undefined when the data path is on a storage the folder does not list.
 */
export function defaultRoot(dataPath: string): string | undefined {
  const remote = splitRemote(dataPath);
  if (remote) return remote.root;
  const local = localPath(dataPath);
  return local === undefined ? undefined : dirname(resolve(local.replace(/[\\/]+$/, '') || sep));
}

/**
 * Why a root cannot be listed with this connection, or undefined when it can. A root lies on the storage of the lake:
 * a local root next to a local data path; any other on the service of the connection's storage (the S3 endpoint, the
 * R2 account, the Azure storage account, OneLake), in any bucket or container. Another storage needs a connection of
 * its own. Whether the account may list it is the storage's decision.
 */
export function rootProblem(
  root: string,
  dataPath: string | null,
  storage: StorageConfig | undefined,
): string | undefined {
  const family = familyOf(root);
  const lake = dataPath === null || dataPath.trim() === '' ? undefined : familyOf(dataPath);
  const other =
    'A root of the Files folder lies on the storage of the lake; another storage needs a connection of its own.';
  if (family === undefined) {
    return 'aantje lists files on a local disk, on S3 and S3-compatible stores, on Azure and on OneLake only.';
  }
  if (family === 'local') {
    if (lake !== undefined && lake !== 'local') return other;
    return isAbsolute(localPath(root) ?? '') ? undefined : 'Write a local root as an absolute path.';
  }
  const remote = splitRemote(root);
  return remote && isHomeService(remote.location, storage) ? undefined : other;
}

/** A directory as a root lists it: an object-store path ends in `/`, a local one in the separator of the disk. */
export function asDirectory(path: string): string {
  const remote = splitRemote(path);
  if (remote) return `${remote.root}${remote.key}${remote.key === '' || remote.key.endsWith('/') ? '' : '/'}`;
  const local = localPath(path) ?? path;
  return local.endsWith('/') || local.endsWith(sep) ? local : `${local}${sep}`;
}

/**
 * A key for comparing directories whatever their spelling: the scheme alias (`s3a`, `az`), the form of an Azure path,
 * `file:` URLs, separators and, on Windows, the letter case of a local path. `account` names the account of the short
 * form `az://container/...`. Undefined for a path the Files folder does not list.
 */
export function directoryKey(
  path: string,
  account?: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const remote = splitRemote(path);
  if (remote) {
    const { family, account: named } = remote.location;
    const owner = family === 'azure' ? (named ?? account?.toLowerCase() ?? '') : '';
    const key = remote.key === '' || remote.key.endsWith('/') ? remote.key : `${remote.key}/`;
    return JSON.stringify([family, owner, remote.bucket, key]);
  }
  const local = localPath(path);
  if (local === undefined) return undefined;
  const normal = `${resolve(local).replaceAll('\\', '/').replace(/\/+$/, '')}/`;
  return JSON.stringify([
    'local',
    platform === 'win32' || platform === 'darwin' ? normal.toLowerCase() : normal,
  ]);
}
