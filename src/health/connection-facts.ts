import type { StorageKind } from '../storage/config';
import { locate } from '../storage/location';
import type { StorageFamily } from '../storage/location';
import type { S3Settings } from '../data/types';
import type { ConnectionAction } from './model';

/** Where the sign-in of the storage comes from: the connection's own values, the machine's stored S3 keys, or the environment. */
export type SignInSource = 'connection' | 'stored' | 'environment';

/** The storage of the connection as the checks know it: kinds and names, never a key, token or password. */
export interface StorageFacts {
  readonly kind: StorageKind;
  readonly signIn: string;
  readonly endpoint?: string;
  readonly accountId?: string;
  readonly account?: string;
  readonly tenant?: string;
  /** Set when the connection has no `storage` of its own: its settings came from `aantje.s3.*` or `azureAccount`. */
  readonly legacy?: 'settings' | 'azureAccount';
}

/** What the connection checks know about the setup. */
export interface ConnectionFacts {
  /** The catalog's `data_path`; null when there is none. */
  readonly dataPath: string | null;
  /** The storage of the connection; absent when it has none (then the machine's S3 settings apply). */
  readonly storage?: StorageFacts;
  readonly s3: S3Settings;
  /** Undefined when there is no sign-in. */
  readonly credentials: SignInSource | undefined;
  /** When the SAS of the storage runs out (milliseconds since 1970), if it has one and says so. */
  readonly signInExpires?: number;
  /** The extension host environment; only S3 endpoint variables are read. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The connection has a storage of its own (or the legacy Azure account), not the machine's S3 settings. */
export const ownsStorage = (facts: ConnectionFacts): boolean =>
  facts.storage !== undefined && facts.storage.legacy !== 'settings';

export const FAMILY_LABEL: Readonly<Record<StorageFamily, string>> = {
  local: 'a local folder',
  s3: 'S3',
  r2: 'Cloudflare R2',
  azure: 'Azure storage',
  onelake: 'OneLake',
  other: 'another store',
};

export const KIND_LABEL: Readonly<Record<StorageKind, string>> = {
  aws: 'Amazon S3',
  s3: 'S3-compatible storage',
  azure: 'Azure storage',
  onelake: 'OneLake',
};

// The kinds of storage that can serve a data path of each family; others are not checked.
export const FAMILY_KINDS: Readonly<Partial<Record<StorageFamily, readonly StorageKind[]>>> = {
  s3: ['aws', 's3'],
  r2: ['s3'],
  azure: ['azure'],
  onelake: ['onelake'],
};

export const familyOf = (dataPath: string | null): StorageFamily =>
  dataPath === null ? 'local' : locate(dataPath).family;

// The fix of a finding lives at the connection when it owns a storage, or when its data path is no S3 path: the
// machine's S3 settings cannot help there.
export const viaConnection = (facts: ConnectionFacts): boolean =>
  ownsStorage(facts) || familyOf(facts.dataPath) !== 's3';

export const CONNECTION_FIX: readonly ConnectionAction[] = ['editConnection'];
export const SIGN_IN_FIX: readonly ConnectionAction[] = ['setStorageSignIn', 'editConnection'];
