import { ONELAKE_HOST } from './config';

// One classifier for data paths. The guard, the health check and the Azure code each used to carry their own reading of
// `s3://` and `abfss://`; they all use `locate` now.

export type StorageFamily = 'local' | 's3' | 'r2' | 'azure' | 'onelake' | 'other';

export interface StorageLocation {
  readonly family: StorageFamily;
  /** The scheme as written, lower case; empty for a path without one. */
  readonly scheme: string;
  /** Bucket, Azure container, OneLake workspace. Absent for local paths and for a path that has none. */
  readonly bucket?: string;
  /** Azure: the storage account, when the path names its host. */
  readonly account?: string;
  /** Azure and OneLake: the host as written, lower case. Absent for the short form `az://container/...`. */
  readonly host?: string;
  /** The bucket, container or workspace as a path prefix ending in `/`; empty for local paths. */
  readonly root: string;
  /** The root under every scheme of the same service (`s3`, `s3a`, `s3n`; `abfss`, `abfs`, `az`, `azure`). */
  readonly aliases: readonly string[];
}

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is;

const S3_SCHEMES: readonly string[] = ['s3', 's3a', 's3n'];
const AZURE_SCHEMES: readonly string[] = ['abfss', 'abfs', 'az', 'azure'];

const AZURE_HOST = /^([a-z0-9]{3,24})\.(dfs|blob)\.core\.windows\.net$/i;
const ONELAKE_HOSTS: readonly string[] = [ONELAKE_HOST, 'onelake.blob.fabric.microsoft.com'];

/** The hosts a storage account answers on; a path that names another host is not that account's. */
export function azureHostsOf(account: string): string[] {
  const name = account.toLowerCase();
  return [`${name}.dfs.core.windows.net`, `${name}.blob.core.windows.net`];
}

/** Whether the host is one of OneLake's. */
export function isOneLakeHost(host: string): boolean {
  return ONELAKE_HOSTS.includes(host.toLowerCase());
}

const LOCAL: StorageLocation = { family: 'local', scheme: '', root: '', aliases: [] };

/**
 * Classifies a data path: S3 (and `s3a`, `s3n`), Cloudflare R2, Azure (`abfss`, `abfs`, `az`, `azure`, in the short form
 * `az://container/...` and the forms that name the account host), OneLake, another URL scheme, or a local path. Blanks
 * around the path are ignored. It reads the text only and touches no network; a hostile catalog can name any path, so
 * the host is kept as written for the caller to compare.
 */
export function locate(path: string): StorageLocation {
  const match = SCHEME.exec(path.trim());
  if (!match) {
    return LOCAL;
  }
  const scheme = (match[1] ?? '').toLowerCase();
  const rest = match[2] ?? '';
  if (scheme === 'file') {
    return { ...LOCAL, family: 'local', scheme };
  }
  if (S3_SCHEMES.includes(scheme)) {
    return bucketPath('s3', scheme, rest, S3_SCHEMES);
  }
  if (scheme === 'r2') {
    return bucketPath('r2', scheme, rest, ['r2']);
  }
  if (AZURE_SCHEMES.includes(scheme)) {
    return azurePath(scheme, rest);
  }
  const authority = rest.split('/')[0] ?? '';
  return {
    family: 'other',
    scheme,
    ...(authority === '' ? {} : { host: authority.toLowerCase() }),
    root: `${scheme}://${authority}/`,
    aliases: [],
  };
}

function bucketPath(
  family: 's3' | 'r2',
  scheme: string,
  rest: string,
  schemes: readonly string[],
): StorageLocation {
  const bucket = rest.split('/')[0] ?? '';
  return {
    family,
    scheme,
    ...(bucket === '' ? {} : { bucket }),
    root: `${scheme}://${bucket}/`,
    aliases: schemes.map((alias) => `${alias}://${bucket}/`),
  };
}

// `abfss://container@host/path`, `az://host/container/path` and the short `az://container/path`, whose account comes
// from the secret.
function azurePath(scheme: string, rest: string): StorageLocation {
  const [authority = '', ...segments] = rest.split('/');
  const at = authority.lastIndexOf('@');
  const container = at >= 0 ? authority.slice(0, at) : undefined;
  const hostPart = (at >= 0 ? authority.slice(at + 1) : authority).toLowerCase();
  // Without `@` the authority is the host when it is a name with dots, else the container of the short form.
  const named = at >= 0 || hostPart.includes('.');
  const host = named ? hostPart : undefined;
  const bucket = at >= 0 ? container : named ? segments[0] : authority;
  const family = host !== undefined && isOneLakeHost(host) ? 'onelake' : 'azure';
  const account = host === undefined ? undefined : AZURE_HOST.exec(host)?.[1]?.toLowerCase();
  const prefix = (alias: string): string =>
    at >= 0
      ? `${alias}://${container}@${hostPart}/`
      : named
        ? `${alias}://${hostPart}/${bucket ?? ''}/`
        : `${alias}://${authority}/`;
  return {
    family,
    scheme,
    ...(bucket === undefined || bucket === '' ? {} : { bucket }),
    ...(account === undefined ? {} : { account }),
    ...(host === undefined ? {} : { host }),
    root: prefix(scheme),
    aliases: AZURE_SCHEMES.map(prefix),
  };
}
