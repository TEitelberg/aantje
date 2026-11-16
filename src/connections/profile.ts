import { AantjeError, isAantjeError } from '../errors';
import { isObject } from '../guards';
import { isRdsHost } from './rds-ca';
import {
  parseStorage,
  storageSettingEntry,
  validateAwsProfile,
  validateStorageAccountName,
  validateTenantId,
} from '../storage/config';
import type { AzureAccountRef, StorageConfig } from '../storage/config';

export type AzureAuthMode = 'password' | 'entra';

export type ConnectionKind = 'postgres' | 'sqlite' | 'duckdb' | 'quack';

interface ProfileBase {
  /** Stable; the password secret is stored under it. The setting may omit it (see `parseProfiles`). */
  readonly id: string;
  readonly name: string;
  /** The SQL editor opens read-only sessions; the explorer is always read-only. */
  readonly readOnly?: boolean;
}

export interface PostgresProfile extends ProfileBase {
  readonly kind: 'postgres';
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  /** Postgres schema holding the `ducklake_*` tables; defaults to the connection default (public). */
  readonly metadataSchema?: string;
  readonly ssl?: boolean;
  /** Storage account of an Azure lake; its data files are read with the Microsoft account the editor is signed in with. */
  readonly azureAccount?: string;
  /** Entra tenant to sign in to for the storage account; without it the sign-in uses the home tenant of the account. */
  readonly azureTenant?: string;
  /** How an Azure lake signs in to PostgreSQL: `entra` uses a token of the Microsoft account as the password, none stored. Absent means a password. */
  readonly azureAuth?: AzureAuthMode;
  /**
   * `iam`: a token that `awsProfile` signs is the password (IAM database authentication of Amazon RDS); none stored.
   * Never together with `azureAuth: "entra"`.
   */
  readonly awsAuth?: 'iam';
  /** The profile of the AWS configuration that signs the token of `awsAuth`; without it the profile of the storage. */
  readonly awsProfile?: string;
  /** Where the data files live and how to sign in there. Never together with `azureAccount`. */
  readonly storage?: StorageConfig;
  /** The roots of the Files folder, on the storage of the lake; without them the root follows from the data path. */
  readonly fileRoots?: readonly string[];
}

/** SQLite or DuckDB database file holding the `ducklake_*` tables. */
export interface FileProfile extends ProfileBase {
  readonly kind: 'sqlite' | 'duckdb';
  readonly path: string;
  /** Where the data files live and how to sign in there. */
  readonly storage?: StorageConfig;
  /** The roots of the Files folder, on the storage of the lake; without them the root follows from the data path. */
  readonly fileRoots?: readonly string[];
}

/**
 * A DuckDB server that serves the catalog over the Quack protocol; its token is stored like a PostgreSQL password. It
 * has no read-only switch: that switch only avoids the lock of a DuckDB file, and what a token may do is the server's
 * decision.
 */
export interface QuackProfile extends ProfileBase {
  readonly kind: 'quack';
  readonly host: string;
  readonly port: number;
  readonly ssl: boolean;
  /** SHA-256 fingerprint of the server certificate, pinned instead of the system trust store (`AB:CD:...`). */
  readonly fingerprint?: string;
  readonly readOnly?: never;
}

export type ConnectionProfile = PostgresProfile | FileProfile | QuackProfile;

/** Whether the profile keeps a secret in the secret storage: the password of PostgreSQL, the token of Quack. */
export function usesSecret(profile: ConnectionProfile): profile is PostgresProfile | QuackProfile {
  return profile.kind === 'postgres' || profile.kind === 'quack';
}

/** A PostgreSQL profile that signs in with an Entra token instead of a password. */
export type EntraProfile = PostgresProfile & { readonly azureAuth: 'entra' };

/**
 * The storage of a profile: its `storage`, or for the legacy `azureAccount` the Azure storage with the Entra sign-in it
 * always meant. The profile is never rewritten. Undefined for a profile that uses the global `aantje.s3.*` settings
 * and for Quack, whose server reads the data.
 */
export function effectiveStorage(profile: ConnectionProfile): StorageConfig | undefined {
  if (profile.kind === 'quack') {
    return undefined;
  }
  if (profile.storage !== undefined) {
    return profile.storage;
  }
  if (profile.kind === 'postgres' && profile.azureAccount !== undefined) {
    return {
      kind: 'azure',
      account: profile.azureAccount,
      signIn: 'entra',
      ...(profile.azureTenant === undefined ? {} : { tenant: profile.azureTenant }),
    };
  }
  return undefined;
}

/** Account and tenant of an Azure lake, from `storage` or from the legacy fields; undefined for any other profile. */
export function azureAccountOf(profile: ConnectionProfile): AzureAccountRef | undefined {
  const storage = effectiveStorage(profile);
  if (storage?.kind !== 'azure') {
    return undefined;
  }
  const tenant = storage.tenant ?? (profile.kind === 'postgres' ? profile.azureTenant : undefined);
  return { account: storage.account, ...(tenant === undefined ? {} : { tenant }) };
}

/** Whether the profile is an Azure DuckLake: a PostgreSQL catalog whose data lies in a storage account (either form). */
export function isAzureLake(profile: ConnectionProfile): boolean {
  return profile.kind === 'postgres' && effectiveStorage(profile)?.kind === 'azure';
}

/** Whether the profile is an AWS DuckLake: PostgreSQL on Amazon RDS with its data files in S3 (`storage.kind: aws`). */
export function isAwsLake(profile: ConnectionProfile): boolean {
  return profile.kind === 'postgres' && isRdsHost(profile.host) && effectiveStorage(profile)?.kind === 'aws';
}

/** Whether the profile signs in to PostgreSQL with an Entra token instead of a password; it then owns no secret. */
export function signsInWithEntra(profile: ConnectionProfile): profile is EntraProfile {
  return profile.kind === 'postgres' && profile.azureAuth === 'entra';
}

/** A PostgreSQL profile that signs in with a token of AWS IAM database authentication instead of a password. */
export type AwsIamProfile = PostgresProfile & { readonly awsAuth: 'iam' };

export function signsInWithAwsIam(profile: ConnectionProfile): profile is AwsIamProfile {
  return profile.kind === 'postgres' && profile.awsAuth === 'iam';
}

/** Whether the profile signs in with a token for every connection (Entra or AWS IAM); it then owns no password. */
export function signsInWithToken(profile: ConnectionProfile): profile is PostgresProfile {
  return signsInWithEntra(profile) || signsInWithAwsIam(profile);
}

/** What the secret of the profile is called in the user interface. */
export function secretLabel(profile: ConnectionProfile): 'token' | 'password' {
  return profile.kind === 'quack' ? 'token' : 'password';
}

/** The VS Code secret storage key of a profile's password or token. */
export function passwordSecretKey(profileId: string): string {
  return `aantje.connection.${profileId}.password`;
}

/**
 * The server a stored password belongs to: host, port, database and user (host and port for a Quack token). A
 * password is bound to this, so that it is never sent to another server after the host was edited, or after a new
 * entry reused an old one's id. File profiles have no password, so their target is empty.
 */
export function connectionTarget(profile: ConnectionProfile): string {
  switch (profile.kind) {
    case 'postgres':
      return JSON.stringify([profile.host, profile.port, profile.database, profile.user]);
    case 'quack':
      return JSON.stringify([profile.host, profile.port]);
    default:
      return '';
  }
}

/** The secret value stored for a password: the target it was given for, next to the password itself. */
export function passwordSecretValue(profile: ConnectionProfile, password: string): string {
  return JSON.stringify({ target: connectionTarget(profile), password });
}

/** The password of a stored secret, but only when it was stored for `profile`'s server; otherwise undefined. */
export function boundPassword(raw: string, profile: ConnectionProfile): string | undefined {
  try {
    const value = JSON.parse(raw) as { target?: unknown; password?: unknown };
    return typeof value.target === 'string' &&
      typeof value.password === 'string' &&
      value.target === connectionTarget(profile)
      ? value.password
      : undefined;
  } catch {
    // A value that is not the bound form (a secret from an older build, or a hand-tampered one) is treated as not
    // present: it is not sent, and the connect flow asks for the password.
    return undefined;
  }
}

/** What opens the catalog of a connection: everything but the name, so a rename keeps it and an edited path changes it. */
export function openingSignature(profile: ConnectionProfile): string {
  return JSON.stringify({ ...profile, name: '' });
}

export const DEFAULT_PORT = 5432;
export const DEFAULT_QUACK_PORT = 9494;

/** Whether the host is the local machine, so the connection does not leave it. */
export function isLoopbackHost(host: string): boolean {
  return /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(host.trim());
}

/** Whether the host is an Azure Database for PostgreSQL server, whose lake usually keeps its data files on Azure. */
export function isAzurePostgresHost(host: string): boolean {
  return /\.postgres\.database\.azure\.com$/i.test(host.trim());
}

/** TLS is the default for every host but the local machine; an entry or the wizard can turn it off. */
export function defaultSsl(host: string): boolean {
  return !isLoopbackHost(host);
}

type Details =
  Omit<PostgresProfile, 'id' | 'name'> | Omit<FileProfile, 'id' | 'name'> | Omit<QuackProfile, 'id' | 'name'>;

interface ParsedEntry {
  readonly profile?: ConnectionProfile;
  readonly problem?: string;
}

/**
 * Tolerantly reads the raw setting: unusable entries are skipped into `problems`; `port` defaults to 5432 (9494 for
 * Quack), `ssl` per `defaultSsl`.
 */
export function parseProfiles(raw: unknown): { profiles: ConnectionProfile[]; problems: string[] } {
  if (raw === undefined || raw === null) {
    return { profiles: [], problems: [] };
  }
  if (!Array.isArray(raw)) {
    return { profiles: [], problems: ['aantje.connections must be an array.'] };
  }
  const entries = parseEntries(raw);
  return {
    profiles: entries.flatMap(({ profile }) => (profile ? [profile] : [])),
    problems: entries.flatMap(({ problem }, index) =>
      problem === undefined ? [] : [`aantje.connections[${index}]: ${problem}`],
    ),
  };
}

/** Like `parseProfiles`, but index-aligned with `raw`, so the store finds a profile's raw entry. */
export function parseEntries(raw: readonly unknown[]): ParsedEntry[] {
  // Explicit ids win over derived ones, wherever the entry stands, even an unusable one.
  const reserved = explicitIds(raw);
  const accepted: ConnectionProfile[] = [];
  return raw.map((entry) => {
    try {
      const profile = parseEntry(entry, reserved, accepted);
      accepted.push(profile);
      return { profile };
    } catch (error) {
      if (!isAantjeError(error)) {
        throw error;
      }
      return { problem: error.userMessage };
    }
  });
}

/** An id for a new profile: its name slug, unique among the ids the raw setting uses. */
export function newProfileId(name: string, raw: readonly unknown[]): string {
  const taken = explicitIds(raw);
  for (const { profile } of parseEntries(raw)) {
    if (profile) {
      taken.add(profile.id);
    }
  }
  return uniqueId(name, taken);
}

/** Names are unique ignoring case and surrounding spaces; `exceptId` is the profile being edited. */
export function isNameTaken(
  name: string,
  profiles: readonly ConnectionProfile[],
  exceptId?: string,
): boolean {
  const key = (value: string): string => value.trim().toLowerCase();
  return profiles.some((profile) => profile.id !== exceptId && key(profile.name) === key(name));
}

// An explicit field list, not a spread: anything else the object carries at runtime (a password)
// must never reach the setting.
export function toSettingEntry(profile: ConnectionProfile): Record<string, unknown> {
  const { id, name, kind } = profile;
  const readOnly = profile.readOnly === undefined ? {} : { readOnly: profile.readOnly };
  if (profile.kind === 'quack') {
    return {
      id,
      name,
      kind,
      host: profile.host,
      port: profile.port,
      ssl: profile.ssl,
      ...(profile.fingerprint === undefined ? {} : { fingerprint: profile.fingerprint }),
    };
  }
  const storage = profile.storage === undefined ? {} : { storage: storageSettingEntry(profile.storage) };
  const fileRoots = profile.fileRoots === undefined ? {} : { fileRoots: [...profile.fileRoots] };
  if (profile.kind !== 'postgres') {
    return { id, name, kind, path: profile.path, ...storage, ...fileRoots, ...readOnly };
  }
  return {
    id,
    name,
    kind,
    host: profile.host,
    port: profile.port,
    database: profile.database,
    user: profile.user,
    ...(profile.metadataSchema === undefined ? {} : { metadataSchema: profile.metadataSchema }),
    ...(profile.azureAccount === undefined ? {} : { azureAccount: profile.azureAccount }),
    ...(profile.azureTenant === undefined ? {} : { azureTenant: profile.azureTenant }),
    ...(profile.azureAuth === undefined ? {} : { azureAuth: profile.azureAuth }),
    ...(profile.awsAuth === undefined ? {} : { awsAuth: profile.awsAuth }),
    ...(profile.awsProfile === undefined ? {} : { awsProfile: profile.awsProfile }),
    ...storage,
    ...fileRoots,
    ssl: profile.ssl ?? false,
    ...readOnly,
  };
}

/** Wizard input validators: an error message, or undefined when valid. */
export function validateRequired(label: string): (value: string) => string | undefined {
  return (value) => (value.trim() === '' ? `${label} must not be empty.` : undefined);
}

export function validateHost(value: string): string | undefined {
  const host = value.trim();
  if (/\s/.test(host)) {
    return 'Host must not contain spaces.';
  }
  if (host.includes('://')) {
    return 'Enter only the host name, not a URL.';
  }
  return validateRequired('Host')(host);
}

/** A Quack host as `validateHost`, but not `quack`: the client then reads the URI `quack:quack:<port>` wrongly. */
export function validateQuackHost(value: string): string | undefined {
  return value.trim().toLowerCase() === 'quack'
    ? 'The Quack client cannot reach a host named "quack" (it reads "quack:quack:<port>" wrongly). Use another name for the server, for example its IP address or a DNS alias.'
    : validateHost(value);
}

/** A SHA-256 fingerprint as 64 hex digits, with or without colons, in the form `AB:CD:...`; undefined when it is none. */
export function normalizeFingerprint(value: string): string | undefined {
  const digits = value.trim().replaceAll(':', '');
  return /^[0-9a-f]{64}$/i.test(digits) ? (digits.toUpperCase().match(/../g) ?? []).join(':') : undefined;
}

export function validatePort(value: string): string | undefined {
  const port = value.trim();
  return /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535
    ? undefined
    : 'Port must be a whole number between 1 and 65535.';
}

/** An optional storage account name: empty, or the 3 to 24 lowercase letters and digits that Azure allows. */
export function validateStorageAccount(value: string): string | undefined {
  return value.trim() === '' ? undefined : validateStorageAccountName(value);
}

/** An optional Entra tenant: empty, or its ID. */
export const validateTenant = validateTenantId;

export function validatePath(value: string): string | undefined {
  const path = value.trim();
  // Windows "Copy as path" wraps the path in quotes, which no file name can contain.
  return /^(".*"|'.*')$/.test(path) ? 'Remove the quotes around the path.' : validateRequired('Path')(path);
}

function parseEntry(
  entry: unknown,
  reserved: Set<string>,
  accepted: readonly ConnectionProfile[],
): ConnectionProfile {
  if (!isObject(entry)) {
    throw invalid('The entry must be an object.');
  }
  const name = text(entry, 'name', validateRequired('Name'));
  const details = parseDetails(entry);
  const explicitId = entry.id === undefined ? undefined : text(entry, 'id', validateRequired('Id'));
  if (isNameTaken(name, accepted)) {
    throw invalid(`The name "${name}" is already used by another connection.`);
  }
  if (explicitId !== undefined && accepted.some((profile) => profile.id === explicitId)) {
    throw invalid(`The id "${explicitId}" is already used by another connection.`);
  }
  if (details.kind === 'quack' && entry.readOnly !== undefined) {
    throw invalid(
      '"readOnly" does not apply to "quack": a Quack server has no file lock to avoid, and what the token may do is decided by the server.',
    );
  }
  const readOnly = entry.readOnly === undefined ? {} : { readOnly: parseReadOnly(entry.readOnly) };
  // Derived last: an entry rejected above must not use up a slug.
  const id = explicitId ?? uniqueId(name, reserved);
  return details.kind === 'quack' ? { id, name, ...details } : { id, name, ...details, ...readOnly };
}

function parseDetails(entry: Record<string, unknown>): Details {
  const { kind } = entry;
  if (kind === 'sqlite' || kind === 'duckdb') {
    return {
      kind,
      path: text(entry, 'path', validatePath),
      ...(entry.storage === undefined ? {} : { storage: parseStorage(entry.storage) }),
      ...fileRootsOf(entry),
    };
  }
  if (kind === 'quack') {
    if (entry.storage !== undefined) {
      throw invalid('"storage" does not apply to "quack": the Quack server reads the data files.');
    }
    if (entry.fileRoots !== undefined) {
      throw invalid('"fileRoots" does not apply to "quack": the Quack server reads the files, not aantje.');
    }
    return parseQuack(entry);
  }
  if (kind !== 'postgres') {
    throw invalid('"kind" must be "postgres", "sqlite", "duckdb" or "quack".');
  }
  if (entry.storage !== undefined && entry.azureAccount !== undefined) {
    throw invalid('"storage" replaces "azureAccount": use one of them.');
  }
  const host = text(entry, 'host', validateHost);
  return {
    kind,
    host,
    port: parsePort(entry.port, DEFAULT_PORT),
    database: text(entry, 'database', validateRequired('Database')),
    user: text(entry, 'user', validateRequired('User')),
    ssl: parseSsl(entry.ssl, host),
    ...(entry.metadataSchema === undefined
      ? {}
      : { metadataSchema: text(entry, 'metadataSchema', validateRequired('Metadata schema')) }),
    ...(entry.azureAccount === undefined
      ? {}
      : { azureAccount: text(entry, 'azureAccount', validateRequired('Azure account')) }),
    ...(entry.azureTenant === undefined
      ? {}
      : { azureTenant: text(entry, 'azureTenant', validateRequired('Azure tenant')) }),
    ...(entry.azureAuth === undefined ? {} : { azureAuth: parseAzureAuth(entry.azureAuth) }),
    ...parseAwsAuth(entry),
    ...(entry.storage === undefined ? {} : { storage: parseStorage(entry.storage) }),
    ...fileRootsOf(entry),
  };
}

// A root is a path of the storage; a control character in it is never one. An empty list means the default root.
function fileRootsOf(entry: Record<string, unknown>): { fileRoots?: readonly string[] } {
  const raw = entry.fileRoots;
  if (raw === undefined) {
    return {};
  }
  if (!Array.isArray(raw) || raw.some((root) => typeof root !== 'string')) {
    throw invalid('"fileRoots" must be a list of paths.');
  }
  const roots = (raw as string[]).map((root) => root.trim());
  // oxlint-disable-next-line no-control-regex -- a path of a storage holds no control character
  if (roots.some((root) => root === '' || /[\x00-\x1f\x7f]/.test(root))) {
    throw invalid('"fileRoots" must hold paths that are not empty and contain no control characters.');
  }
  return roots.length === 0 ? {} : { fileRoots: roots };
}

function parseQuack(entry: Record<string, unknown>): Omit<QuackProfile, 'id' | 'name'> {
  const host = text(entry, 'host', validateQuackHost);
  const ssl = parseSsl(entry.ssl, host);
  if (entry.fingerprint === undefined) {
    return { kind: 'quack', host, port: parsePort(entry.port, DEFAULT_QUACK_PORT), ssl };
  }
  const fingerprint = normalizeFingerprint(text(entry, 'fingerprint', validateRequired('Fingerprint')));
  if (fingerprint === undefined) {
    throw invalid('"fingerprint" must be a SHA-256 fingerprint: 64 hex digits, with or without colons.');
  }
  if (!ssl) {
    throw invalid('"fingerprint" pins a TLS certificate, so it needs "ssl": true.');
  }
  return { kind: 'quack', host, port: parsePort(entry.port, DEFAULT_QUACK_PORT), ssl, fingerprint };
}

function parsePort(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number') {
    throw invalid('"port" must be a number.');
  }
  const message = validatePort(String(value));
  if (message) {
    throw invalid(message);
  }
  return value;
}

function parseSsl(value: unknown, host: string): boolean {
  if (value === undefined) {
    return defaultSsl(host);
  }
  // Not coerced: the text "true" silently meaning "no TLS" is worse than a rejected entry.
  if (typeof value !== 'boolean') {
    throw invalid('"ssl" must be true or false.');
  }
  return value;
}

function parseAzureAuth(value: unknown): AzureAuthMode {
  if (value !== 'password' && value !== 'entra') {
    throw invalid('"azureAuth" must be "password" or "entra".');
  }
  return value;
}

function parseAwsAuth(entry: Record<string, unknown>): { awsAuth?: 'iam'; awsProfile?: string } {
  if (entry.awsAuth !== undefined && entry.awsAuth !== 'iam') {
    throw invalid('"awsAuth" must be "iam" (or absent for a password).');
  }
  if (entry.awsAuth === 'iam' && entry.azureAuth === 'entra') {
    throw invalid('"awsAuth" and "azureAuth": "entra" exclude each other: a connection signs in one way.');
  }
  return {
    ...(entry.awsAuth === 'iam' ? { awsAuth: 'iam' as const } : {}),
    ...(entry.awsProfile === undefined ? {} : { awsProfile: text(entry, 'awsProfile', validateAwsProfile) }),
  };
}

function parseReadOnly(value: unknown): boolean {
  // Not coerced: the text "false" silently meaning "read-only" or "writable" is worse than a rejected entry.
  if (typeof value !== 'boolean') {
    throw invalid('"readOnly" must be true or false.');
  }
  return value;
}

function text(
  entry: Record<string, unknown>,
  key: string,
  validate: (value: string) => string | undefined,
): string {
  const value = entry[key];
  if (value === undefined) {
    throw invalid(`"${key}" is required.`);
  }
  if (typeof value !== 'string') {
    throw invalid(`"${key}" must be a string.`);
  }
  const message = validate(value);
  if (message) {
    throw invalid(message);
  }
  return value.trim();
}

function explicitIds(raw: readonly unknown[]): Set<string> {
  return new Set(
    raw.flatMap((entry) =>
      isObject(entry) && typeof entry.id === 'string' && entry.id.trim() !== '' ? [entry.id.trim()] : [],
    ),
  );
}

function uniqueId(name: string, taken: Set<string>): string {
  const base = slug(name);
  let id = base;
  for (let suffix = 2; taken.has(id); suffix++) {
    id = `${base}-${suffix}`;
  }
  taken.add(id);
  return id;
}

function slug(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return base === '' ? 'connection' : base;
}

function invalid(message: string): AantjeError {
  return new AantjeError('INVALID_PROFILE', message);
}
