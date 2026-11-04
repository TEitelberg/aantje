import { quoteIdentifier, quoteLiteral } from '../catalog/ddl';
import { CHANGE_COLUMNS, PREVIEW_LIMIT } from './types';
import type { DataAccess, S3Credentials, S3Settings, TableRef } from './types';

const PG_SECRET = 'aantje_pg';
const S3_SECRET = 'aantje_s3';
const AZURE_SECRET = 'aantje_azure';
const QUACK_SECRET = 'aantje_quack';

/** Name under which the DuckLake is attached. */
export const LAKE = 'lake';

const METADATA_EXTENSIONS: Readonly<Record<DataAccess['profile']['kind'], string | undefined>> = {
  postgres: 'postgres',
  sqlite: 'sqlite',
  duckdb: undefined,
  quack: 'quack',
};

/**
 * SQL that prepares a fresh in-memory DuckDB: extensions, secrets, ATTACH and configuration lock. Passwords, tokens
 * and S3 keys appear only in `CREATE SECRET`. A `session` (SQL editor) attaches writable unless `readOnly`, unlocked.
 * With a `dataPath` the attach is allowed to create the catalog (a new lake) and stores that data path in it.
 */
export function setupStatements(
  access: DataAccess,
  session?: { readonly readOnly: boolean; readonly dataPath?: string },
  platform?: NodeJS.Platform,
): string[] {
  const { profile, s3, s3Credentials, azure } = access;
  const statements = ['INSTALL ducklake', 'LOAD ducklake'];
  const metadataExtension = METADATA_EXTENSIONS[profile.kind];
  if (metadataExtension) {
    statements.push(`INSTALL ${metadataExtension}`, `LOAD ${metadataExtension}`);
  }
  // A local lake needs no httpfs (offline extension directories may hold only ducklake and the metadata extension).
  // Only an endpoint or credentials (stored, or from the environment) make an S3 secret and load httpfs here; a region
  // or URL style alone does not, because the manifest has defaults for both and every connection would then load httpfs.
  // Without them ATTACH of a lake with an S3 data path autoloads httpfs before autoload is switched off. Quack sends
  // its requests through httpfs, so a Quack catalog always loads it.
  const s3Secret = s3SecretStatement(s3, s3Credentials);
  if (s3Secret || profile.kind === 'quack') {
    statements.push('INSTALL httpfs', 'LOAD httpfs');
  }
  // The extension is loaded before the autoload switches go off after the ATTACH, so it needs no allow-list entry.
  if (azure) {
    statements.push(...azureExtension(platform));
  }
  if (s3Secret) {
    statements.push(s3Secret);
  }
  if (azure) {
    statements.push(azureSecretStatement(azure.accountName, azure.accessToken));
  }

  // A writable ATTACH would turn any DuckDB file or PostgreSQL schema into a DuckLake.
  // Quack accepts READ_ONLY without enforcing it, and newer quack builds refuse it; its attach only must not create a
  // lake.
  const options =
    session?.dataPath !== undefined
      ? [`DATA_PATH ${quoteLiteral(session.dataPath)}`]
      : (session && !session.readOnly) || profile.kind === 'quack'
        ? ['CREATE_IF_NOT_EXISTS false']
        : ['READ_ONLY'];
  let target: string;
  if (profile.kind === 'postgres') {
    statements.push(postgresSecretStatement(profile, access.password));
    target = 'ducklake:postgres:';
    options.push(`META_SECRET ${quoteLiteral(PG_SECRET)}`);
    if (profile.metadataSchema !== undefined) {
      options.push(`METADATA_SCHEMA ${quoteLiteral(profile.metadataSchema)}`);
    }
  } else if (profile.kind === 'quack') {
    const quack = quackAttach(profile, access.password);
    statements.push(...quack.secret);
    target = quack.target;
    options.push(...quack.options);
  } else {
    target = profile.kind === 'sqlite' ? `ducklake:sqlite:${profile.path}` : `ducklake:${profile.path}`;
  }
  if (access.snapshot !== undefined && !session) {
    options.push(`SNAPSHOT_VERSION ${access.snapshot}`);
  }
  statements.push(
    `ATTACH ${quoteLiteral(target)} AS ${LAKE}${options.length > 0 ? ` (${options.join(', ')})` : ''}`,
    ...(session ? sessionSettings() : [...STOP_EXTENSIONS, 'SET lock_configuration = true']),
  );
  return statements;
}

/** Makes the lake the default catalog; fails when the lake has no schema `main`. */
export const USE_LAKE = `USE ${LAKE}`;

/** The first schema by name, the default schema of a session on a lake without `main`. */
export function firstSchemaQuery(): string {
  return `SELECT schema_name FROM duckdb_schemas() WHERE database_name = '${LAKE}' ORDER BY schema_name LIMIT 1`;
}

// After the ATTACH nothing installs or loads an extension, so the SQL of a view cannot pull in another core extension.
// Persistent secrets are switched off at instance creation (`instanceOptions`): DuckDB refuses it once a secret was
// used.
const STOP_EXTENSIONS = ['SET autoinstall_known_extensions = false', 'SET autoload_known_extensions = false'];

function sessionSettings(): string[] {
  return [
    USE_LAKE,
    "SET default_transaction_invalidation_policy = 'SYNTACTIC_ERRORS_DO_NOT_INVALIDATE'",
    ...STOP_EXTENSIONS,
  ];
}

/** One row more than the limit, so the caller can tell whether the table has more rows. */
export function previewQuery(table: TableRef): string {
  return `${selectAll(table)} LIMIT ${PREVIEW_LIMIT + 1}`;
}

/** Binds the relation without reading a row; the result still carries column names and types. */
export function columnsQuery(table: TableRef): string {
  return `${selectAll(table)} LIMIT 0`;
}

// The global `ducklake_*` functions take the lake by name. `lake.snapshots()` is looked up in the default schema of
// the lake, and a lake can lack `main` (DuckLake lets it be dropped).

/** The newest snapshot, also when the lake is attached at an older one. */
export function newestSnapshotQuery(): string {
  return `SELECT max(snapshot_id) FROM ducklake_snapshots('${LAKE}')`;
}

/** The stored data path; NULL when there is none. */
export function dataPathQuery(): string {
  return `SELECT value FROM ducklake_options('${LAKE}') WHERE option_name = 'data_path'`;
}

/** The first snapshot after `snapshot` the catalog still has (expired ones are gone), or NULL. */
export function nextSnapshotQuery(snapshot: number): string {
  return `SELECT min(snapshot_id) FROM ducklake_snapshots('${LAKE}') WHERE snapshot_id > ${snapshot}`;
}

/** The column names of `table_changes`, where DuckDB renames table columns that clash with the feed columns. */
export function changeColumnsQuery(table: TableRef, start: number, end: number): string {
  return `SELECT * FROM ${tableChanges(table, start, end)} LIMIT 0`;
}

/**
 * Changes of snapshots `start` to `end` (inclusive) by snapshot and row, pre-image first; one row over the limit like
 * `previewQuery`.
 */
export function changesQuery(
  table: TableRef,
  start: number,
  end: number,
  columns: readonly string[],
): string {
  return `SELECT * FROM ${realChanges(table, start, end, columns)} ORDER BY snapshot_id, rowid, CASE change_type WHEN 'update_postimage' THEN 1 ELSE 0 END LIMIT ${PREVIEW_LIMIT + 1}`;
}

/** Rows of each change type per snapshot of the range. */
export function changeCountsQuery(
  table: TableRef,
  start: number,
  end: number,
  columns: readonly string[],
): string {
  return `SELECT snapshot_id, change_type, count(*) FROM ${realChanges(table, start, end, columns)} GROUP BY snapshot_id, change_type`;
}

// `table_changes` without no-op updates: `ducklake_rewrite_data_files` rewrites a partly deleted file's rows under the
// same row ids, which reads as an update with equal images. An update row stays only when no other row shares snapshot,
// row id and values (NULLs, NaNs and nested values equal themselves). `columns` renames the result.
function realChanges(table: TableRef, start: number, end: number, columns: readonly string[]): string {
  const names = columns.map(quoteIdentifier);
  const source = `${tableChanges(table, start, end)} AS feed(${names.join(', ')})`;
  const kind = names[CHANGE_COLUMNS - 1] ?? '';
  const sameRow = names.filter((_, index) => index !== CHANGE_COLUMNS - 1).join(', ');
  const updates = `${kind} IN ('update_preimage', 'update_postimage')`;
  // The window covers updates only, which are few next to the inserts of a large range.
  return `(SELECT * FROM ${source} WHERE NOT (${updates}) UNION ALL SELECT * FROM ${source} WHERE ${updates} QUALIFY count(*) OVER (PARTITION BY ${sameRow}) = 1)`;
}

// `table_changes` looks the table up in the schema it is called in and fails on a qualified name, so the schema
// qualifies the function.
function tableChanges(table: TableRef, start: number, end: number): string {
  return `${LAKE}.${quoteIdentifier(table.schema)}.table_changes(${quoteLiteral(table.table)}, ${start}, ${end})`;
}

function selectAll(table: TableRef): string {
  return `SELECT * FROM ${LAKE}.${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)}`;
}

/**
 * The `azure` extension. Its default transport looks for the CA bundle only where Red Hat keeps it, so on Debian and
 * Ubuntu every request fails with "Problem with the SSL CA cert"; curl looks in the usual places. Windows keeps WinHTTP
 * and its trust store.
 */
function azureExtension(platform: NodeJS.Platform = process.platform): string[] {
  const load = ['INSTALL azure', 'LOAD azure'];
  return platform === 'linux' ? [...load, "SET azure_transport_option_type = 'curl'"] : load;
}

/** The secret of an Azure lake; the same statement replaces it when the token is renewed. */
export function azureSecretStatement(accountName: string, accessToken: string): string {
  return `CREATE OR REPLACE SECRET ${AZURE_SECRET} (TYPE azure, PROVIDER access_token, ACCESS_TOKEN ${quoteLiteral(accessToken)}, ACCOUNT_NAME ${quoteLiteral(accountName)})`;
}

/** The address of a Quack server for DuckDB; the explorer attaches it as is, the data engine behind `ducklake:`. */
export function quackUri(profile: { readonly host: string; readonly port: number }): string {
  return `quack:${profile.host}:${profile.port}`;
}

// A pinned fingerprint replaces the trust store for this server only; `ca_cert_file` would replace it for every HTTPS
// request of the engine.
function quackAttach(
  profile: Extract<DataAccess['profile'], { kind: 'quack' }>,
  token: string | undefined,
): { secret: string[]; target: string; options: string[] } {
  const uri = quackUri(profile);
  return {
    secret: token ? [quackSecretStatement(uri, token)] : [],
    target: `ducklake:${uri}`,
    // A pin needs TLS; quack refuses it together with META_DISABLE_SSL true.
    options: [
      `META_DISABLE_SSL ${!profile.ssl}`,
      ...(profile.ssl && profile.fingerprint !== undefined
        ? [`META_SSL_FINGERPRINT ${quoteLiteral(profile.fingerprint)}`]
        : []),
    ],
  };
}

/** The secret that carries the token of a Quack server; its scope keeps the token away from any other server. */
export function quackSecretStatement(uri: string, token: string): string {
  return `CREATE OR REPLACE TEMPORARY SECRET ${QUACK_SECRET} (TYPE quack, TOKEN ${quoteLiteral(token)}, SCOPE ${quoteLiteral(uri)})`;
}

/** The secret of the PostgreSQL catalog; the same statement replaces it when the Entra token is renewed. */
export function postgresSecretStatement(
  profile: Extract<DataAccess['profile'], { kind: 'postgres' }>,
  password: string | undefined,
): string {
  const fields = [
    'TYPE postgres',
    `HOST ${quoteLiteral(profile.host)}`,
    `PORT ${profile.port}`,
    `DATABASE ${quoteLiteral(profile.database)}`,
    `USER ${quoteLiteral(profile.user)}`,
    ...(password ? [`PASSWORD ${quoteLiteral(password)}`] : []),
    // Check the certificate against the system trust store; 'require' would only encrypt. Without a mode
    // DuckDB's PostgreSQL client falls back to unchecked cleartext, so always state the mode.
    ...(profile.ssl
      ? [`SSLMODE ${quoteLiteral('verify-full')}`, `SSLROOTCERT ${quoteLiteral('system')}`]
      : [`SSLMODE ${quoteLiteral('disable')}`]),
  ];
  return `CREATE OR REPLACE SECRET ${PG_SECRET} (${fields.join(', ')})`;
}

// Undefined without an endpoint and without credentials: DuckDB then uses its own defaults, or none for a public bucket.
// The region and the URL style only complete a secret that exists for one of those two reasons.
function s3SecretStatement(s3: S3Settings, credentials: S3Credentials | undefined): string | undefined {
  const endpoint = s3.endpoint?.trim() ?? '';
  if (!credentials && endpoint === '') {
    return undefined;
  }
  const fields = ['TYPE s3'];
  if (credentials) {
    fields.push(`KEY_ID ${quoteLiteral(credentials.keyId)}`, `SECRET ${quoteLiteral(credentials.secretKey)}`);
  }
  if (s3.region) {
    fields.push(`REGION ${quoteLiteral(s3.region)}`);
  }
  if (endpoint !== '') {
    const { host, useSsl } = splitEndpoint(endpoint);
    fields.push(`ENDPOINT ${quoteLiteral(host)}`);
    if (useSsl !== undefined) {
      fields.push(`USE_SSL ${useSsl}`);
    }
  }
  if (s3.urlStyle) {
    fields.push(`URL_STYLE ${quoteLiteral(s3.urlStyle)}`);
  }
  return `CREATE OR REPLACE SECRET ${S3_SECRET} (${fields.join(', ')})`;
}

// DuckDB wants the endpoint without a scheme; the scheme decides `USE_SSL`, else TLS applies.
function splitEndpoint(endpoint: string): { host: string; useSsl: boolean | undefined } {
  const match = /^(https?):\/\/(.*)$/i.exec(endpoint);
  const host = (match?.[2] ?? endpoint).replace(/\/+$/, '');
  return { host, useSsl: match ? match[1]?.toLowerCase() === 'https' : undefined };
}
