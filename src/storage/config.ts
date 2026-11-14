import { AantjeError } from '../errors';
import { isObject } from '../guards';

// The storage of a connection: where the data files of its lake live and how aantje signs in there. One connection is
// one lake, one storage and one access. The configuration holds no secret; keys, tokens and passwords live in the
// secret storage (`secrets.ts`) and come back as `StorageValues`.

export type AwsSignIn = 'keys' | 'chain';
export type AzureSignIn = 'entra' | 'connectionString' | 'accountKey' | 'sas' | 'servicePrincipal' | 'chain';
export type OneLakeSignIn = 'entra' | 'servicePrincipal' | 'chain';

/** Amazon S3 itself: the endpoint follows from the region. */
export interface AwsStorage {
  readonly kind: 'aws';
  readonly region?: string;
  readonly signIn: AwsSignIn;
  /** Credential chain only: the providers to try, e.g. `sso;env`. */
  readonly chain?: string;
  /** Credential chain only: the profile of the AWS configuration. */
  readonly awsProfile?: string;
}

/**
 * An S3-compatible store: an `endpoint` (MinIO, RustFS, Wasabi) or the `accountId` of Cloudflare R2, which becomes the
 * secret type `r2`. A connection that uses the global `aantje.s3.*` settings has neither (see `legacy` in
 * `ResolvedStorage`); a profile always names one.
 */
export interface S3Storage {
  readonly kind: 's3';
  readonly endpoint?: string;
  readonly accountId?: string;
  readonly region?: string;
  readonly urlStyle?: 'path' | 'vhost';
  readonly signIn: 'keys';
}

/** Azure Data Lake Storage Gen2 or Blob storage of one storage account. */
export interface AzureStorage {
  readonly kind: 'azure';
  readonly account: string;
  readonly tenant?: string;
  readonly signIn: AzureSignIn;
  readonly clientId?: string;
  readonly certificatePath?: string;
  readonly chain?: string;
}

/** Microsoft Fabric OneLake, `abfss://<workspace>@onelake.dfs.fabric.microsoft.com/...`. */
export interface OneLakeStorage {
  readonly kind: 'onelake';
  readonly tenant?: string;
  readonly signIn: OneLakeSignIn;
  readonly clientId?: string;
  readonly certificatePath?: string;
  readonly chain?: string;
}

export type StorageConfig = AwsStorage | S3Storage | AzureStorage | OneLakeStorage;
export type StorageKind = StorageConfig['kind'];

/** Host of OneLake (the DFS endpoint). */
export const ONELAKE_HOST = 'onelake.dfs.fabric.microsoft.com';

/** The secrets of a storage, by name. Only the first group is kept in the secret storage; a token is fetched on use. */
export const STORED_VALUE_NAMES = [
  'keyId',
  'secretKey',
  'sessionToken',
  'connectionString',
  'accountKey',
  'sasToken',
  'clientSecret',
] as const;
export type StoredValueName = (typeof STORED_VALUE_NAMES)[number];

export type StorageValues = Readonly<Partial<Record<StoredValueName | 'accessToken', string>>>;

/** A storage as the engine uses it: the configuration, its secrets, and how to renew a token. */
export interface ResolvedStorage {
  readonly config: StorageConfig;
  readonly values: StorageValues;
  /** A fresh Entra access token; a long session calls it before the old one runs out (Azure and OneLake). */
  readonly refresh?: () => Promise<string>;
  /** Set when the connection has no `storage` of its own: where the storage came from. Decides the secret's name. */
  readonly legacy?: 'settings' | 'azureAccount';
}

// Which fields each kind knows; anything else in an entry is refused by name, so a secret a user pasted into the
// settings is not silently ignored (and the value is never shown in the message).
const FIELDS: Readonly<Record<StorageKind, readonly string[]>> = {
  aws: ['kind', 'region', 'signIn', 'chain', 'awsProfile'],
  s3: ['kind', 'endpoint', 'accountId', 'region', 'urlStyle', 'signIn'],
  azure: ['kind', 'account', 'tenant', 'signIn', 'clientId', 'certificatePath', 'chain'],
  onelake: ['kind', 'tenant', 'signIn', 'clientId', 'certificatePath', 'chain'],
};

const AWS_SIGN_INS: readonly string[] = ['keys', 'chain'];
const AZURE_SIGN_INS: readonly string[] = [
  'entra',
  'connectionString',
  'accountKey',
  'sas',
  'servicePrincipal',
  'chain',
];
const ONELAKE_SIGN_INS: readonly string[] = ['entra', 'servicePrincipal', 'chain'];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A required storage account name: the 3 to 24 lowercase letters and digits that Azure allows. */
export function validateStorageAccountName(value: string): string | undefined {
  return /^[a-z0-9]{3,24}$/.test(value.trim())
    ? undefined
    : 'A storage account name has 3 to 24 lowercase letters and digits.';
}

/** An optional Entra tenant: empty, or its ID. */
export function validateTenantId(value: string): string | undefined {
  const tenant = value.trim();
  return tenant === '' || GUID.test(tenant)
    ? undefined
    : 'Enter the directory (tenant) ID, a GUID, or leave it empty.';
}

/** An S3 endpoint: `host`, `host:port` or `http(s)://host:port`, no path (the bucket belongs in the data path). */
export function validateS3Endpoint(value: string): string | undefined {
  return /^(https?:\/\/)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?\/?$/i.test(value.trim())
    ? undefined
    : 'Enter the address of the S3 API as host:port or http(s)://host:port, without a path.';
}

/** The ID of a Cloudflare account, the 32 hex digits in the R2 endpoint. */
export function validateR2AccountId(value: string): string | undefined {
  return /^[0-9a-f]{32}$/i.test(value.trim())
    ? undefined
    : 'A Cloudflare account ID has 32 hexadecimal digits.';
}

export function validateAwsRegion(value: string): string | undefined {
  return /^[a-z0-9-]{2,32}$/i.test(value.trim()) ? undefined : 'A region is a name such as eu-central-1.';
}

/** The providers of a credential chain: names separated by `;`. */
export function validateChain(value: string): string | undefined {
  return /^[a-z0-9_]+(;[a-z0-9_]+)*$/i.test(value.trim())
    ? undefined
    : 'Enter provider names separated by semicolons, for example sso;env.';
}

export function validateAwsProfile(value: string): string | undefined {
  return /^[A-Za-z0-9_.@ -]{1,128}$/.test(value.trim()) ? undefined : 'Enter the name of an AWS profile.';
}

export function validateClientId(value: string): string | undefined {
  return GUID.test(value.trim()) ? undefined : 'The client ID of an app registration is a GUID.';
}

export function validateCertificatePath(value: string): string | undefined {
  const path = value.trim();
  // A quoted path is what "Copy as path" yields; no file name contains a quote.
  return path === '' || /^(".*"|'.*')$/.test(path) || /[\r\n\0]/.test(path)
    ? 'Enter the path of the certificate file, without quotes.'
    : undefined;
}

/**
 * Reads the `storage` of a profile entry. Throws an `INVALID_PROFILE` error that names the field and never shows a
 * value, so `parseProfiles` skips the entry into its problem list.
 */
export function parseStorage(raw: unknown): StorageConfig {
  if (!isObject(raw)) {
    throw invalid('"storage" must be an object.');
  }
  const kind = raw.kind;
  if (kind !== 'aws' && kind !== 's3' && kind !== 'azure' && kind !== 'onelake') {
    throw invalid('"storage.kind" must be "aws", "s3", "azure" or "onelake".');
  }
  const unknown = Object.keys(raw).find((key) => !FIELDS[kind].includes(key));
  if (unknown !== undefined) {
    throw invalid(
      `"storage.${unknown.slice(0, 40)}" does not exist for the kind "${kind}". The settings hold no secret: keys and tokens are kept in the secret storage.`,
    );
  }
  switch (kind) {
    case 'aws':
      return parseAws(raw);
    case 's3':
      return parseS3(raw);
    case 'azure':
      return parseAzure(raw);
    case 'onelake':
      return parseOneLake(raw);
  }
}

function parseAws(raw: Record<string, unknown>): AwsStorage {
  const signIn = oneOf(raw, 'signIn', AWS_SIGN_INS) as AwsSignIn;
  const chain = optional(raw, 'chain', validateChain);
  const awsProfile = optional(raw, 'awsProfile', validateAwsProfile);
  if (signIn !== 'chain' && (chain !== undefined || awsProfile !== undefined)) {
    throw invalid('"storage.chain" and "storage.awsProfile" belong to "signIn": "chain".');
  }
  const region = optional(raw, 'region', validateAwsRegion);
  return {
    kind: 'aws',
    signIn,
    ...(region === undefined ? {} : { region }),
    ...(chain === undefined ? {} : { chain }),
    ...(awsProfile === undefined ? {} : { awsProfile }),
  };
}

function parseS3(raw: Record<string, unknown>): S3Storage {
  oneOf(raw, 'signIn', ['keys']);
  const endpoint = optional(raw, 'endpoint', validateS3Endpoint);
  const accountId = optional(raw, 'accountId', validateR2AccountId);
  if ((endpoint === undefined) === (accountId === undefined)) {
    throw invalid(
      '"storage" needs exactly one of "endpoint" (S3-compatible store) and "accountId" (Cloudflare R2).',
    );
  }
  const region = optional(raw, 'region', validateAwsRegion);
  const urlStyle =
    raw.urlStyle === undefined ? undefined : (oneOf(raw, 'urlStyle', ['path', 'vhost']) as 'path' | 'vhost');
  if (urlStyle !== undefined && endpoint === undefined) {
    throw invalid('"storage.urlStyle" does not apply to R2, which always uses path style.');
  }
  return {
    kind: 's3',
    signIn: 'keys',
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(region === undefined ? {} : { region }),
    ...(urlStyle === undefined ? {} : { urlStyle }),
  };
}

function parseAzure(raw: Record<string, unknown>): AzureStorage {
  const account = required(raw, 'account', validateStorageAccountName);
  const signIn = oneOf(raw, 'signIn', AZURE_SIGN_INS) as AzureSignIn;
  return { kind: 'azure', account, signIn, ...principal(raw, signIn) };
}

function parseOneLake(raw: Record<string, unknown>): OneLakeStorage {
  const signIn = oneOf(raw, 'signIn', ONELAKE_SIGN_INS) as OneLakeSignIn;
  return { kind: 'onelake', signIn, ...principal(raw, signIn) };
}

// The Entra-related fields shared by Azure and OneLake, and which sign-in each belongs to.
function principal(
  raw: Record<string, unknown>,
  signIn: string,
): { tenant?: string; clientId?: string; certificatePath?: string; chain?: string } {
  const tenant = optional(raw, 'tenant', validateTenantId, true);
  const clientId = optional(raw, 'clientId', validateClientId);
  const certificatePath = optional(raw, 'certificatePath', validateCertificatePath);
  const chain = optional(raw, 'chain', validateChain);
  if (signIn === 'servicePrincipal') {
    if (tenant === undefined || clientId === undefined) {
      throw invalid('"storage.tenant" and "storage.clientId" are required for "signIn": "servicePrincipal".');
    }
  } else if (clientId !== undefined || certificatePath !== undefined) {
    throw invalid('"storage.clientId" and "storage.certificatePath" belong to "signIn": "servicePrincipal".');
  }
  if (signIn !== 'chain' && chain !== undefined) {
    throw invalid('"storage.chain" belongs to "signIn": "chain".');
  }
  return {
    ...(tenant === undefined ? {} : { tenant }),
    ...(clientId === undefined ? {} : { clientId }),
    ...(certificatePath === undefined ? {} : { certificatePath }),
    ...(chain === undefined ? {} : { chain }),
  };
}

/** The entry for `aantje.connections`: an explicit field list, so nothing else a runtime object carries reaches it. */
export function storageSettingEntry(storage: StorageConfig): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  for (const field of FIELDS[storage.kind]) {
    const value = (storage as unknown as Record<string, unknown>)[field];
    if (value !== undefined) {
      entry[field] = value;
    }
  }
  return entry;
}

/**
 * What the secrets of a storage are bound to: the service they are sent to and the sign-in they belong to. A secret
 * stored for another target is not used and not sent (like a password and its server); a changed sign-in drops them.
 */
export function storageTarget(storage: StorageConfig): string {
  switch (storage.kind) {
    case 'aws':
      return JSON.stringify(['aws', storage.signIn, storage.awsProfile ?? '']);
    case 's3':
      return JSON.stringify(['s3', storage.endpoint ?? '', storage.accountId ?? '']);
    case 'azure':
      return JSON.stringify([
        'azure',
        storage.account,
        storage.signIn,
        storage.tenant ?? '',
        storage.clientId ?? '',
      ]);
    case 'onelake':
      return JSON.stringify(['onelake', storage.signIn, storage.tenant ?? '', storage.clientId ?? '']);
  }
}

/** Account and tenant of an Azure or OneLake storage; the same helper for the new form and the legacy profile fields. */
export interface AzureAccountRef {
  readonly account: string;
  readonly tenant?: string;
}

/** The sign-in values a storage needs from the user and keeps in the secret storage, in the order a wizard asks. */
export function storedValueNames(storage: StorageConfig): readonly StoredValueName[] {
  switch (storage.kind) {
    case 'aws':
      return storage.signIn === 'keys' ? ['keyId', 'secretKey', 'sessionToken'] : [];
    case 's3':
      return ['keyId', 'secretKey'];
    case 'azure':
      switch (storage.signIn) {
        case 'connectionString':
          return ['connectionString'];
        case 'accountKey':
          return ['accountKey'];
        case 'sas':
          return ['sasToken'];
        case 'servicePrincipal':
          return storage.certificatePath === undefined ? ['clientSecret'] : [];
        default:
          return [];
      }
    case 'onelake':
      return storage.signIn === 'servicePrincipal' && storage.certificatePath === undefined
        ? ['clientSecret']
        : [];
  }
}

function invalid(message: string): AantjeError {
  return new AantjeError('INVALID_PROFILE', message);
}

function oneOf(raw: Record<string, unknown>, key: string, allowed: readonly string[]): string {
  const value = raw[key];
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw invalid(`"storage.${key}" must be ${allowed.map((item) => `"${item}"`).join(', ')}.`);
  }
  return value;
}

function required(
  raw: Record<string, unknown>,
  key: string,
  validate: (value: string) => string | undefined,
): string {
  if (raw[key] === undefined) {
    throw invalid(`"storage.${key}" is required.`);
  }
  return optional(raw, key, validate) as string;
}

function optional(
  raw: Record<string, unknown>,
  key: string,
  validate: (value: string) => string | undefined,
  allowEmpty = false,
): string | undefined {
  const value = raw[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalid(`"storage.${key}" must be a string.`);
  }
  const message = validate(value);
  if (message && !(allowEmpty && value.trim() === '')) {
    throw invalid(`"storage.${key}": ${message}`);
  }
  return value.trim() === '' ? undefined : value.trim();
}
