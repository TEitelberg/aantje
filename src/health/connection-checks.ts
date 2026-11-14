import { isLoopbackHost } from '../connections/profile';
import type { Phase } from '../data/errors';
import type { StorageKind } from '../storage/config';
import { storeProblemOf } from '../storage/diagnose';
import type { StoreProblem } from '../storage/diagnose';
import { locate } from '../storage/location';
import { CONNECTION_FIX, SIGN_IN_FIX, familyOf, ownsStorage, viaConnection } from './connection-facts';
import type { ConnectionFacts, SignInSource } from './connection-facts';
import { finding } from './finding';
import { PROBE_NAME } from '../data/store-sql';
import { storageConfigFindings } from './storage-findings';
import type { CheckId, EndpointSuggestion, HealthFinding } from './model';

export { ownsStorage } from './connection-facts';
export type { ConnectionFacts, SignInSource, StorageFacts } from './connection-facts';

const LAKE_SCOPE = { kind: 'lake' } as const;

const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

export function isRemote(dataPath: string): boolean {
  return URL_SCHEME.test(dataPath);
}

function isAbsolute(path: string): boolean {
  return /^([a-zA-Z]:[\\/]|\/|\\\\)/.test(path);
}

function hostOf(endpoint: string): { host: string; path: string } {
  const [host = '', ...rest] = endpoint.replace(/^https?:\/\//i, '').split('/');
  return { host, path: rest.join('/') };
}

// The first one holding a plain address wins: the service-specific variable beats the general one.
const ENDPOINT_VARIABLES = ['AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL'] as const;

// `host`, `host:port` or `http(s)://host:port` only: the value ends up in a settings file.
const ENDPOINT_SHAPE = /^(https?:\/\/)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

// AWS accepts both bucket styles; every other store (MinIO, RustFS, Ceph) needs the path style.
const AWS_HOST = /(^|\.)amazonaws\.com(\.cn)?$/i;

/** The endpoint the environment names if it is a plain address; the URL style is suggested only for non-AWS stores. */
export function suggestEndpoint(env: ConnectionFacts['env']): EndpointSuggestion | undefined {
  for (const source of ENDPOINT_VARIABLES) {
    const endpoint = env[source]?.trim().replace(/\/+$/, '') ?? '';
    if (endpoint !== '' && ENDPOINT_SHAPE.test(endpoint)) {
      const { host } = hostOf(endpoint);
      return {
        endpoint,
        ...(AWS_HOST.test(host.replace(/:\d+$/, '')) ? {} : { urlStyle: 'path' as const }),
        source,
      };
    }
  }
  return undefined;
}

/** Setup problems visible without asking the store: the settings against the data path and each other. */
export function configFindings(
  facts: ConnectionFacts,
  localPathExists: boolean | undefined,
  now: Date = new Date(),
): HealthFinding[] {
  return [
    ...localPathFindings(facts.dataPath, localPathExists),
    ...storageConfigFindings(facts, now),
    ...endpointFindings(facts),
  ];
}

function localPathFindings(dataPath: string | null, exists: boolean | undefined): HealthFinding[] {
  if (dataPath === null || dataPath === '' || isRemote(dataPath)) return [];
  const findings: HealthFinding[] = [];
  if (!isAbsolute(dataPath)) {
    findings.push(
      finding('connection.relative-data-path', {
        severity: 'warning',
        scope: LAKE_SCOPE,
        title: 'The data path of the catalog is relative',
        detail: `data_path is "${dataPath}". DuckLake resolves it against the working directory of the extension host, which is rarely the directory the lake was written from.`,
        cause:
          'The lake was created with a relative DATA_PATH, or a DuckDB catalog file stores the default relative one.',
        fix: 'Attach the lake once with an absolute DATA_PATH in a writable session, or open it from the directory that holds the data.',
        objectKey: dataPath,
      }),
    );
  }
  if (exists === false) {
    findings.push(
      finding('connection.local-path-missing', {
        severity: 'error',
        scope: LAKE_SCOPE,
        title: 'The data path of the catalog does not exist on this machine',
        detail: `data_path is "${dataPath}", a path on the machine that runs the extension, and there is no such directory. Every data file of the lake is missing from here.`,
        cause:
          'The catalog was written on another machine (a server, a container, another user), or the directory was moved or deleted.',
        fix: 'Open the lake where the files are, mount or copy the directory to this path, or attach the lake with the right DATA_PATH in a writable session.',
        objectKey: dataPath,
      }),
    );
  }
  return findings;
}

// aantje.s3.* are settings of the machine, not of the connection: they concern only a lake whose data is on S3.
function endpointFindings(facts: ConnectionFacts): HealthFinding[] {
  const { dataPath, s3, credentials } = facts;
  const endpoint = s3.endpoint ?? '';
  if (endpoint === '' || dataPath === null || familyOf(dataPath) !== 's3') return [];
  const own = ownsStorage(facts);
  const { host, path } = hostOf(endpoint);
  const findings: HealthFinding[] = [];
  if (
    s3.urlStyle === 'vhost' &&
    (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(host) || /^localhost(:\d+)?$/i.test(host))
  ) {
    findings.push(
      finding('connection.url-style-vhost-ip', {
        severity: 'warning',
        scope: LAKE_SCOPE,
        title: 'The URL style "vhost" cannot work with an IP address or localhost as endpoint',
        detail: `${own ? 'The URL style of the storage is "vhost" and its endpoint is' : 'aantje.s3.urlStyle is "vhost" and aantje.s3.endpoint is'} "${endpoint}". The virtual-host style puts the bucket in front of the host name ("bucket.${host}"), which does not resolve.`,
        cause: 'MinIO, RustFS and most self-hosted stores want the path style.',
        fix: own
          ? 'Run "Edit Connection" and set the URL style to "path".'
          : 'Set aantje.s3.urlStyle to "path".',
        objectKey: endpoint,
        ...(own ? { connectionActions: CONNECTION_FIX } : { settingKey: 's3.urlStyle' }),
      }),
    );
  }
  if (path.replace(/\/+$/, '') !== '') {
    findings.push(
      finding('connection.endpoint-with-path', {
        severity: 'warning',
        scope: LAKE_SCOPE,
        title: 'The S3 endpoint contains a path',
        detail: `${own ? 'The endpoint of the storage' : 'aantje.s3.endpoint'} is "${endpoint}". DuckDB wants only host and port; the bucket belongs in the data path of the catalog.`,
        cause: 'The URL of the bucket or of a console page was pasted.',
        fix: own
          ? `Run "Edit Connection" and set the endpoint to "${host}" (with http:// in front when the store has no TLS).`
          : `Set aantje.s3.endpoint to "${host}" (with http:// in front when the store has no TLS).`,
        objectKey: endpoint,
        ...(own ? { connectionActions: CONNECTION_FIX } : { settingKey: 's3.endpoint' }),
      }),
    );
  }
  if (
    credentials !== undefined &&
    /^http:\/\//i.test(endpoint) &&
    !isLoopbackHost(host.replace(/:\d+$/, ''))
  ) {
    findings.push(cleartextFinding(endpoint, credentials, own));
  }
  return findings;
}

function cleartextFinding(endpoint: string, credentials: SignInSource, own: boolean): HealthFinding {
  const source =
    credentials === 'connection'
      ? 'the keys stored for this connection'
      : credentials === 'stored'
        ? 'the keys stored with "aantje: Set S3 Credentials..."'
        : 'the environment variables AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY';
  return finding('connection.endpoint-cleartext', {
    severity: 'warning',
    scope: LAKE_SCOPE,
    title: 'The S3 endpoint is a plain http:// address of another machine',
    detail: `${own ? 'The endpoint of the storage' : 'aantje.s3.endpoint'} is "${endpoint}" and aantje signs its requests with ${source}. The secret key itself is not sent, but the requests and the data that come back are not encrypted, so anyone on the network between the two machines can read the data and the key id.`,
    cause: 'The store has no TLS, or the endpoint was written with http:// to avoid a certificate error.',
    fix: 'Use https:// with a certificate that this machine trusts, or keep the traffic on a network that you control.',
    objectKey: endpoint,
    ...(own ? { connectionActions: CONNECTION_FIX } : { settingKey: 's3.endpoint' }),
  });
}

/** The finding for a setup failure (missing engine, extension, attach). */
export function setupFailure(phase: Phase, text: string, extensionHint: string): HealthFinding {
  if (phase === 'extension') {
    return finding('connection.engine-unavailable', {
      severity: 'error',
      scope: LAKE_SCOPE,
      title: 'A DuckDB extension that reading the data needs could not be installed or loaded',
      detail: text.split(/\r?\n/)[0] ?? text,
      cause:
        'DuckDB downloads ducklake, httpfs and the metadata extension on first use and there is no network, or the engine does not exist for this platform.',
      fix: extensionHint,
      settingKey: 'duckdb.extensionDirectory',
    });
  }
  return finding('connection.attach-failed', {
    severity: 'error',
    scope: LAKE_SCOPE,
    title: 'The lake cannot be attached through the data engine',
    detail: text.split(/\r?\n/)[0] ?? text,
    cause: /authentication failed|Quack authentication token/i.test(text)
      ? 'The catalog server rejected the login of the connection (the PostgreSQL password or the Quack token).'
      : 'The catalog database could not be opened by DuckDB, or its DuckLake version does not match the extension.',
    fix: 'Check the connection (server, port and the login: database, user and password for PostgreSQL, the token for Quack). A catalog of another DuckLake version has to be migrated with a matching DuckDB; aantje opens catalogs read-only.',
  });
}

const NOT_SET = 'connection.endpoint-not-set';
const NOT_SET_TITLE = 'No S3 endpoint is configured, so requests go to AWS';

interface StoreText {
  readonly check: CheckId;
  /** Tells this finding from others of its check. */
  readonly object?: string;
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
  /** The machine setting that fixes it for a connection on the machine's S3 settings. */
  readonly settingKey?: string;
  /** The fix is a sign-in problem: the connection offers Set Storage Sign-in, not only Edit Connection. */
  readonly signIn?: true;
}

interface StoreFailure {
  readonly text: string;
  readonly timedOut: boolean;
  readonly facts: ConnectionFacts;
  readonly endpoint: string;
  /** The fix is at the connection (Edit Connection, Set Storage Sign-in), not in the machine settings. */
  readonly via: boolean;
  readonly kind: StorageKind | undefined;
}

const where = (endpoint: string): string => (endpoint === '' ? 'the AWS default endpoint' : `"${endpoint}"`);

const isAzure = (kind: StorageKind | undefined): boolean => kind === 'azure' || kind === 'onelake';

// The kind of storage the failure is about: the connection's own, else the one the data path names.
function kindOf(facts: ConnectionFacts): StorageKind | undefined {
  if (facts.storage !== undefined && facts.storage.legacy !== 'settings') return facts.storage.kind;
  const family = familyOf(facts.dataPath);
  return family === 'azure' || family === 'onelake' ? family : family === 's3' ? 's3' : undefined;
}

function deniedReason(text: string, kind: StorageKind | undefined): string {
  if (isAzure(kind)) {
    if (/\bUnauthorized\b|HTTP 401/.test(text)) return 'The storage did not accept the token or the key.';
    if (/\bAuthenticationFailed\b|\bInvalidAuthenticationInfo\b|Server failed to authenticate/.test(text))
      return 'The storage rejected the sign-in: the key, the SAS or the token is wrong or does not match the account.';
    return 'The storage refused the request.';
  }
  const code = /\b(SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied|NoSuchBucket)\b/.exec(text)?.[1];
  if (code === 'SignatureDoesNotMatch')
    return 'The store knows the key id but the secret key does not match it.';
  if (code === 'InvalidAccessKeyId') return 'The store does not know the key id.';
  if (/No credentials are provided/.test(text)) return 'No credentials were sent.';
  return 'The store refused the request.';
}

function describeDenied({ text, facts, endpoint, via, kind }: StoreFailure): StoreText {
  const { credentials } = facts;
  if (via) {
    const azure = isAzure(kind);
    return {
      check: 'connection.store-access-denied',
      title: azure
        ? 'The storage refuses the sign-in'
        : 'The object store refuses the credentials or the permissions',
      cause: `${deniedReason(text, kind)}${credentials === undefined ? ' aantje has no sign-in stored for this connection.' : ''}`,
      fix: azure
        ? 'Run "Set Storage Sign-in..." (a new key, SAS or secret) or "Edit Connection" (account, tenant, sign-in), and check that the account may read the container.'
        : 'Run "Set Storage Sign-in..." with the key id and secret of this store, and check that the key may list and read the bucket. "Edit Connection" changes the endpoint.',
      settingKey: 's3.endpoint',
      signIn: true,
    };
  }
  const aws =
    endpoint === ''
      ? ' No aantje.s3.endpoint is set, so the request went to AWS S3; keys of a self-hosted store (MinIO, RustFS) do not work there.'
      : '';
  const source =
    credentials === 'environment'
      ? ' The credentials come from the environment variables AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.'
      : credentials === undefined
        ? ' aantje has no credentials.'
        : '';
  return {
    check: 'connection.store-access-denied',
    title: 'The object store refuses the credentials or the permissions',
    cause: `${deniedReason(text, kind)}${aws}${source}`,
    fix: 'Run "aantje: Set S3 Credentials..." with the key id and secret of this store, and check that the key may list and read the bucket. For a self-hosted store set aantje.s3.endpoint.',
    settingKey: 's3.endpoint',
  };
}

function describeExpired({ kind }: StoreFailure): StoreText {
  const what = isAzure(kind)
    ? 'The access token (Microsoft sign-in) or the SAS of the storage has expired.'
    : 'The session token of the keys has expired.';
  return {
    check: 'connection.sign-in-expired',
    object: 'store',
    title: 'The sign-in of the storage has expired',
    cause: what,
    fix: isAzure(kind)
      ? 'Sign in again: "Edit Connection" for the Microsoft account, or "Set Storage Sign-in..." with a new SAS or secret.'
      : 'Run "Set Storage Sign-in..." (or "aantje: Set S3 Credentials..." for the machine keys) with new keys and a new session token.',
    signIn: true,
  };
}

function describeRole({ kind }: StoreFailure): StoreText {
  const oneLake = kind === 'onelake';
  return {
    check: 'connection.store-role-missing',
    title: oneLake
      ? 'The account has no access to the OneLake workspace or item'
      : 'The account has no role that may read the storage',
    cause: oneLake
      ? 'The sign-in is accepted, but the account is no member of the Fabric workspace (Viewer or higher) and has no OneLake data access role for the item.'
      : 'The sign-in is accepted, but the account has no data role (Storage Blob Data Reader or Contributor) on the storage account or the container, or a firewall of the storage account blocks this machine.',
    fix: oneLake
      ? 'Ask a workspace admin to add the account to the workspace, or sign in with another account ("Set Storage Sign-in..." or "Edit Connection").'
      : 'Assign the role "Storage Blob Data Reader" (or Contributor) to the account on the storage account or the container, and allow this machine in the firewall of the storage account. A role takes a few minutes to apply.',
    signIn: true,
  };
}

function describeNoBucket({ facts, endpoint, via, kind }: StoreFailure): StoreText {
  const { dataPath } = facts;
  const bucket = dataPath === null ? undefined : locate(dataPath).bucket;
  if (isAzure(kind)) {
    const account = facts.storage?.account;
    return {
      check: 'connection.store-bucket-missing',
      title: 'The container of the data path does not exist in the storage',
      cause: `${bucket === undefined ? 'The container' : `The container "${bucket}"`} is not in ${account === undefined ? 'the storage that answers' : `the storage account "${account}"`}: it was never created or was deleted, or the account is another one than the lake was written to.`,
      fix: 'Compare the container in data_path with the containers of the account, create it again if it was deleted, or run "Edit Connection" and set the right account.',
      settingKey: 's3.endpoint',
    };
  }
  const first =
    !via && familyOf(dataPath) === 's3' && endpoint === ''
      ? `First see "${NOT_SET_TITLE}" (${NOT_SET}): no endpoint is configured. `
      : '';
  return {
    check: 'connection.store-bucket-missing',
    title: 'The bucket of the data path does not exist in the object store',
    cause: `${bucket === undefined ? 'The bucket' : `The bucket "${bucket}"`} is not in the store that answers at ${where(endpoint)}: it was never created or was deleted, or the endpoint is another store than the one the lake was written to.`,
    fix: `${first}Compare the bucket in data_path with the buckets of the store, create the bucket again if the store was reset, or ${via ? 'run "Edit Connection" and set the right endpoint' : 'point aantje.s3.endpoint to the right store'}.`,
    settingKey: 's3.endpoint',
  };
}

const describeHostUnresolved = ({ facts, via, kind }: StoreFailure): StoreText => ({
  check: 'connection.store-host-unresolved',
  title: 'The host name of the object store cannot be resolved',
  cause: isAzure(kind)
    ? 'The DNS of this machine does not know the host of the storage account: the account name is wrong, or the account was deleted.'
    : facts.s3.urlStyle === 'vhost'
      ? 'The virtual-host style puts the bucket in front of the host name, which only works with a DNS name that has wildcard entries for the buckets.'
      : via
        ? 'The host name of the endpoint of the storage is not known to the DNS of this machine.'
        : 'The host name of aantje.s3.endpoint is not known to the DNS of this machine.',
  fix: isAzure(kind)
    ? 'Run "Edit Connection" and check the storage account name.'
    : via
      ? 'Use the URL style "path" for self-hosted stores, and check the host name of the endpoint with "Edit Connection".'
      : 'Use aantje.s3.urlStyle "path" for self-hosted stores, and check the host name in aantje.s3.endpoint.',
  settingKey: 's3.urlStyle',
});

const describeSslMismatch = ({ endpoint, via, kind }: StoreFailure): StoreText => ({
  check: 'connection.store-ssl-mismatch',
  title: 'TLS and the object store do not match',
  cause: isAzure(kind)
    ? 'The TLS connection to the storage failed: a proxy or a security tool replaces the certificate and this machine does not trust it, or the clock is wrong.'
    : /^https:/i.test(endpoint) || !/^http:/i.test(endpoint)
      ? 'DuckDB speaks TLS (https) because the endpoint has no http:// in front or says https://, but the store answers in plain HTTP or with a certificate that DuckDB does not accept.'
      : 'The store is not reachable with the protocol that the endpoint names.',
  fix: isAzure(kind)
    ? 'Trust the certificate of the proxy on this machine, or connect from a network without TLS inspection.'
    : `For a store without TLS write the endpoint as http://host:port${via ? ' ("Edit Connection")' : ''}. For a store with TLS check its certificate.`,
  settingKey: 's3.endpoint',
});

const describeUnreachable = ({ endpoint, via, kind, facts }: StoreFailure): StoreText => ({
  check: 'connection.store-unreachable',
  title: 'The object store cannot be reached',
  cause: isAzure(kind)
    ? `Nothing answers for the storage${facts.storage?.account === undefined ? '' : ` account "${facts.storage.account}"`}: no network, a firewall or proxy is in the way, or the request timed out.`
    : `Nothing answers at ${where(endpoint)}: wrong host or port, the store is down, or a firewall or proxy is in the way.`,
  fix: isAzure(kind)
    ? 'Check the network and the firewall of the storage account, and the account name in "Edit Connection".'
    : via
      ? 'Check the endpoint (host and port) with "Edit Connection" and that the store is running and reachable from this machine.'
      : 'Check aantje.s3.endpoint (host and port) and that the store is running and reachable from this machine.',
  settingKey: 's3.endpoint',
});

const describeNotFound = ({ via }: StoreFailure): StoreText => ({
  check: 'connection.store-not-found',
  title: 'The server answers 404 but is no object store for this bucket',
  cause:
    'The answer has no S3 error code: a web server or proxy without a route for the bucket answered, not the object store.',
  fix: `Check ${via ? 'the endpoint of the storage ("Edit Connection")' : 'aantje.s3.endpoint'}: it must be the address of the S3 API, not of a web console or a proxy path.`,
  settingKey: 's3.endpoint',
});

const describeUnknown = ({ via }: StoreFailure): StoreText => ({
  check: 'connection.store-failed',
  title: 'Listing the object store failed',
  cause: 'The store or the network answered with an error that aantje does not know.',
  fix: via
    ? 'Read the message below. The storage of the connection and its sign-in ("Edit Connection", "Set Storage Sign-in...") are the first things to check.'
    : 'Read the message below. aantje.s3.* and the S3 credentials are the first things to check.',
  settingKey: 's3.endpoint',
});

// What each kind of failure means here; a missing local file is no answer of a store.
const DESCRIBE: Readonly<Partial<Record<StoreProblem, (failure: StoreFailure) => StoreText>>> = {
  denied: describeDenied,
  expired: describeExpired,
  role: describeRole,
  'no-bucket': describeNoBucket,
  unresolved: describeHostUnresolved,
  ssl: describeSslMismatch,
  unreachable: describeUnreachable,
  'not-found': describeNotFound,
};

// A statement that ran out of time is a store that did not answer, unless its text says more.
function problemOf({ text, timedOut, kind }: StoreFailure): StoreProblem | undefined {
  const problem = storeProblemOf(text, kind);
  return timedOut && (problem === undefined || problem === 'not-found' || problem === 'missing-file')
    ? 'unreachable'
    : problem;
}

/** Explains a failed storage request from DuckDB's text; shapes reproduced with DuckDB 2.0.0 and RustFS 1.0.4. */
export function storeFailure(text: string, timedOut: boolean, facts: ConnectionFacts): HealthFinding {
  const failure: StoreFailure = {
    text,
    timedOut,
    facts,
    endpoint: facts.s3.endpoint ?? '',
    via: viaConnection(facts),
    kind: kindOf(facts),
  };
  const problem = problemOf(failure);
  const describe = (problem && DESCRIBE[problem]) ?? describeUnknown;
  const kind = describe(failure);
  // The first paragraph names the request, the second the store's answer (HTTP status and S3 error code).
  const [first = text, answer] = text.replaceAll(PROBE_NAME, '').split(/\r?\n\r?\n/);
  return finding(kind.check, {
    severity: 'error',
    scope: LAKE_SCOPE,
    ...(kind.object === undefined ? {} : { object: kind.object }),
    title: kind.title,
    detail: [first, answer].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 400),
    cause: kind.cause,
    fix: kind.fix,
    ...(failure.via
      ? { connectionActions: kind.signIn ? SIGN_IN_FIX : CONNECTION_FIX }
      : kind.settingKey === undefined
        ? {}
        : { settingKey: kind.settingKey }),
  });
}

// Failures AWS gives when the lake is on a self-hosted store.
const FROM_AWS: readonly CheckId[] = [
  'connection.store-bucket-missing',
  'connection.store-access-denied',
  'connection.store-host-unresolved',
];

// Finding for a request sent to AWS because `aantje.s3.endpoint` is empty: an error for failures a self-hosted
// lake gets from AWS, else a warning when the environment names an endpoint. Only for a connection that uses the
// machine's S3 settings; a storage of the connection names its endpoint or is Amazon S3 on purpose.
export function endpointNotSet(failed: HealthFinding, facts: ConnectionFacts): HealthFinding | undefined {
  const { dataPath, s3, credentials, env } = facts;
  if (dataPath === null || ownsStorage(facts) || familyOf(dataPath) !== 's3' || (s3.endpoint ?? '') !== '') {
    return undefined;
  }
  const suggestion = suggestEndpoint(env);
  const likely = FROM_AWS.includes(failed.check);
  if (!likely && !suggestion) return undefined;
  const style = suggestion?.urlStyle ? `, URL style: ${suggestion.urlStyle}` : '';
  const keys =
    credentials === undefined ? ' Then run "aantje: Set S3 Credentials..." with the keys of that store.' : '';
  return finding('connection.endpoint-not-set', {
    severity: likely ? 'error' : 'warning',
    scope: { kind: 'lake' },
    title: NOT_SET_TITLE,
    detail: `data_path is "${dataPath}" and aantje.s3.endpoint is empty, so aantje sends its requests to the AWS default endpoint.${suggestion ? ` Suggested endpoint: ${suggestion.endpoint} (from ${suggestion.source})${style}.` : ''}`,
    cause: likely
      ? 'The lake is on a self-hosted store (MinIO, RustFS, Ceph), but without an endpoint the request went to AWS S3, which does not know that bucket or those keys.'
      : 'The lake may be on a self-hosted store (MinIO, RustFS, Ceph): without an endpoint every request goes to AWS S3.',
    fix: suggestion
      ? `Use the suggested endpoint (the environment of the extension host names it) or set aantje.s3.endpoint to the address of your store.${keys}`
      : `Set aantje.s3.endpoint to the address of the S3 API of your store (host:port or http(s)://host:port) and aantje.s3.urlStyle to "path".${keys} Nothing is wrong when the lake is on AWS.`,
    settingKey: 's3.endpoint',
    ...(suggestion ? { suggestion } : {}),
  });
}
