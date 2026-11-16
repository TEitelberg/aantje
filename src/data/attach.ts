import { quoteIdentifier, quoteLiteral } from '../catalog/ddl';
import { rdsCaPathFor } from '../connections/rds-ca';
import { quackSecretStatement, quackUri } from '../duckdb/quack';
import { storageExtensions, storageSecretName, storageSecretStatement } from '../storage/statements';
import { CHANGE_COLUMNS, PREVIEW_LIMIT } from './types';
import type { DataAccess, TableRef } from './types';

const PG_SECRET = 'aantje_pg';

const NO_EXTRA = { extensions: [], attach: [] };

/** Name under which the DuckLake is attached. */
export const LAKE = 'lake';

const METADATA_EXTENSIONS: Readonly<Record<DataAccess['profile']['kind'], string | undefined>> = {
  postgres: 'postgres',
  sqlite: 'sqlite',
  duckdb: undefined,
  quack: 'quack',
};

/**
 * A further lake of an engine: a read-only attach under its own alias, with secrets of its own names, so that it
 * replaces none of the first lake's. Its storage secret is limited to the data path of the lake (`scope`), so that
 * neither lake's credentials go to the other's storage; without a data path the lake has no files to read, and its
 * storage gets no secret.
 */
export interface AttachedLake {
  readonly access: DataAccess;
  /** The catalog name in the engine: a plain lower-case identifier, not `lake`. */
  readonly alias: string;
  /** The data path of the lake, from its catalog. */
  readonly scope: string | null;
  /** Attaches at the snapshot of `access` (a read); a session reads the snapshot it names with `AT (VERSION => n)`. */
  readonly atSnapshot: boolean;
}

/**
 * SQL that prepares a fresh in-memory DuckDB: extensions, secrets, ATTACH and configuration lock. Passwords, tokens
 * and S3 keys appear only in `CREATE SECRET`. A `session` (SQL editor) attaches writable unless `readOnly`, unlocked.
 * With a `dataPath` the attach is allowed to create the catalog (a new lake) and stores that data path in it. `also`
 * attaches further lakes read-only (`AttachedLake`).
 */
export function setupStatements(
  access: DataAccess,
  session?: { readonly readOnly: boolean; readonly dataPath?: string },
  platform?: NodeJS.Platform,
  /** A second catalog: its extensions load before the lake is attached, its secret and ATTACH come right after it. */
  extra: { readonly extensions: readonly string[]; readonly attach: readonly string[] } = NO_EXTRA,
  also: readonly AttachedLake[] = [],
): string[] {
  const { profile } = access;
  // A writable ATTACH would turn any DuckDB file or PostgreSQL schema into a DuckLake.
  const mode =
    session?.dataPath !== undefined
      ? [`DATA_PATH ${quoteLiteral(session.dataPath)}`]
      : (session && !session.readOnly) || profile.kind === 'quack'
        ? ['CREATE_IF_NOT_EXISTS false']
        : ['READ_ONLY'];
  return [
    ...unique([access, ...also.map((lake) => lake.access)].flatMap((lake) => lakeExtensions(lake, platform))),
    ...extra.extensions,
    ...lakeAttach(access, {
      alias: LAKE,
      mode,
      snapshot: session ? undefined : access.snapshot,
      storageSecret: access.storage === undefined ? undefined : storageSecretName(access.storage),
      scope: undefined,
      pgSecret: PG_SECRET,
      quackSecret: undefined,
    }),
    ...extra.attach,
    ...also.flatMap(attachedLake),
    ...(session ? sessionSettings() : [...STOP_EXTENSIONS, 'SET lock_configuration = true']),
  ];
}

/**
 * The setup of a read-only engine with several lakes and none called `lake`: every lake under its alias at its
 * snapshot, its secrets named after it and its storage secret limited to its data path, then the configuration lock.
 */
export function lakesSetup(lakes: readonly AttachedLake[], platform?: NodeJS.Platform): string[] {
  return [
    ...unique(lakes.flatMap((lake) => lakeExtensions(lake.access, platform))),
    ...lakes.flatMap(attachedLake),
    ...STOP_EXTENSIONS,
    'SET lock_configuration = true',
  ];
}

// The extensions a lake needs. A local lake needs no httpfs (offline extension directories may hold only ducklake and
// the metadata extension), so a connection without a storage loads nothing for it. Without an S3 secret, ATTACH of a
// lake with an S3 data path autoloads httpfs before autoload is switched off. Quack sends its requests through httpfs,
// so a Quack catalog always loads it. The extensions load before the autoload switches go off after the ATTACH, so they
// need no allow-list entry.
function lakeExtensions(access: DataAccess, platform: NodeJS.Platform | undefined): string[] {
  const { profile, storage } = access;
  const statements = ['INSTALL ducklake', 'LOAD ducklake'];
  const metadataExtension = METADATA_EXTENSIONS[profile.kind];
  if (metadataExtension) {
    statements.push(`INSTALL ${metadataExtension}`, `LOAD ${metadataExtension}`);
  }
  const extensions = storageExtensions(storage, platform);
  if (profile.kind === 'quack' && !extensions.includes('LOAD httpfs')) {
    statements.push('INSTALL httpfs', 'LOAD httpfs');
  }
  return [...statements, ...extensions];
}

const unique = (statements: readonly string[]): string[] => [...new Set(statements)];

function attachedLake(lake: AttachedLake): string[] {
  const { access, alias } = lake;
  return lakeAttach(access, {
    alias,
    // Quack accepts READ_ONLY without enforcing it, and newer quack builds refuse it; its attach only must not create a
    // lake.
    mode: access.profile.kind === 'quack' ? ['CREATE_IF_NOT_EXISTS false'] : ['READ_ONLY'],
    snapshot: lake.atSnapshot ? access.snapshot : undefined,
    storageSecret: lake.scope === null ? undefined : `aantje_storage_${alias}`,
    scope: lake.scope ?? undefined,
    pgSecret: `aantje_pg_${alias}`,
    quackSecret: `aantje_quack_${alias}`,
  });
}

/** How one lake is attached: its alias, the mode options, the snapshot, the names (and scope) of its secrets. */
interface AttachPlan {
  readonly alias: string;
  readonly mode: readonly string[];
  readonly snapshot: number | undefined;
  /** Undefined: the storage gets no secret. */
  readonly storageSecret: string | undefined;
  readonly scope: string | undefined;
  readonly pgSecret: string;
  /** Undefined: the default name. */
  readonly quackSecret: string | undefined;
}

// The secrets of the lake, then its ATTACH.
function lakeAttach(access: DataAccess, plan: AttachPlan): string[] {
  const { profile, storage } = access;
  const statements: string[] = [];
  const secret =
    storage === undefined || plan.storageSecret === undefined
      ? undefined
      : storageSecretStatement(storage, plan.storageSecret, plan.scope);
  if (secret) {
    statements.push(secret);
  }
  const options = [...plan.mode];
  let target: string;
  if (profile.kind === 'postgres') {
    statements.push(postgresSecretStatement(profile, access.password, plan.pgSecret));
    target = 'ducklake:postgres:';
    options.push(`META_SECRET ${quoteLiteral(plan.pgSecret)}`);
    if (profile.metadataSchema !== undefined) {
      options.push(`METADATA_SCHEMA ${quoteLiteral(profile.metadataSchema)}`);
    }
  } else if (profile.kind === 'quack') {
    const quack = quackAttach(profile, access.password, plan.quackSecret);
    statements.push(...quack.secret);
    target = quack.target;
    options.push(...quack.options);
  } else {
    target = profile.kind === 'sqlite' ? `ducklake:sqlite:${profile.path}` : `ducklake:${profile.path}`;
  }
  if (plan.snapshot !== undefined) {
    options.push(`SNAPSHOT_VERSION ${plan.snapshot}`);
  }
  statements.push(
    `ATTACH ${quoteLiteral(target)} AS ${plan.alias}${options.length > 0 ? ` (${options.join(', ')})` : ''}`,
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
export function newestSnapshotQuery(alias: string = LAKE): string {
  return `SELECT max(snapshot_id) FROM ducklake_snapshots('${alias}')`;
}

/** The stored data path; NULL when there is none. */
export function dataPathQuery(alias: string = LAKE): string {
  return `SELECT value FROM ducklake_options('${alias}') WHERE option_name = 'data_path'`;
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

/** The relation in the attached lake, every part quoted: `lake."schema"."table"`. */
export function relationName(table: TableRef, alias: string = LAKE): string {
  return `${alias}.${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)}`;
}

function selectAll(table: TableRef): string {
  return `SELECT * FROM ${relationName(table)}`;
}

// A pinned fingerprint replaces the trust store for this server only; `ca_cert_file` would replace it for every HTTPS
// request of the engine.
function quackAttach(
  profile: Extract<DataAccess['profile'], { kind: 'quack' }>,
  token: string | undefined,
  secretName: string | undefined,
): { secret: string[]; target: string; options: string[] } {
  const uri = quackUri(profile);
  return {
    secret: token ? [quackSecretStatement(uri, token, secretName)] : [],
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

/** The secret of the PostgreSQL catalog; the same statement replaces it when the Entra token is renewed. */
export function postgresSecretStatement(
  profile: Extract<DataAccess['profile'], { kind: 'postgres' }>,
  password: string | undefined,
  name: string = PG_SECRET,
): string {
  const fields = [
    'TYPE postgres',
    `HOST ${quoteLiteral(profile.host)}`,
    `PORT ${profile.port}`,
    `DATABASE ${quoteLiteral(profile.database)}`,
    `USER ${quoteLiteral(profile.user)}`,
    ...(password ? [`PASSWORD ${quoteLiteral(password)}`] : []),
    // Check the certificate against the system trust store, or the certificate authorities of RDS for an RDS server;
    // 'require' would only encrypt. Without a mode DuckDB's PostgreSQL client falls back to unchecked cleartext, so
    // always state the mode.
    ...(profile.ssl
      ? [
          `SSLMODE ${quoteLiteral('verify-full')}`,
          `SSLROOTCERT ${quoteLiteral(rdsCaPathFor(profile.host) ?? 'system')}`,
        ]
      : [`SSLMODE ${quoteLiteral('disable')}`]),
  ];
  return `CREATE OR REPLACE SECRET ${name} (${fields.join(', ')})`;
}
