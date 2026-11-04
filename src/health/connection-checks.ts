import { isLoopbackHost } from '../connections/profile';
import type { Phase } from '../data/errors';
import type { S3Settings } from '../data/types';
import { finding } from './finding';
import { PROBE_NAME } from './storage-checks';
import type { CheckId, EndpointSuggestion, HealthFinding } from './model';

/** What the connection checks know about the setup. */
export interface ConnectionFacts {
  /** The catalog's `data_path`; null when there is none. */
  readonly dataPath: string | null;
  readonly s3: S3Settings;
  /** Undefined when there are no S3 credentials. */
  readonly credentials: 'stored' | 'environment' | undefined;
  /** The extension host environment; only S3 endpoint variables are read. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

const LAKE_SCOPE = { kind: 'lake' } as const;

const URL_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

export function isRemote(dataPath: string): boolean {
  return URL_SCHEME.test(dataPath);
}

function isS3(dataPath: string): boolean {
  return /^s3a?:\/\//i.test(dataPath);
}

function bucketOf(dataPath: string): string | undefined {
  return /^s3a?:\/\/([^/]+)/i.exec(dataPath)?.[1];
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
): HealthFinding[] {
  return [
    ...localPathFindings(facts.dataPath, localPathExists),
    ...credentialFindings(facts),
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

function credentialFindings({ dataPath, credentials }: ConnectionFacts): HealthFinding[] {
  if (dataPath === null || !isS3(dataPath) || credentials !== undefined) return [];
  return [
    finding('connection.credentials-missing', {
      severity: 'warning',
      scope: LAKE_SCOPE,
      title: 'The lake is on S3 but aantje has no S3 credentials',
      detail: `data_path is "${dataPath}". No credentials are stored and the environment variables AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not both set. Only a bucket that allows anonymous reads works without them.`,
      cause: 'The command "aantje: Set S3 Credentials..." was never run on this machine.',
      fix: 'Run "aantje: Set S3 Credentials..." or set the environment variables for the extension host.',
      objectKey: dataPath,
    }),
  ];
}

function endpointFindings({ s3, credentials }: ConnectionFacts): HealthFinding[] {
  const endpoint = s3.endpoint ?? '';
  if (endpoint === '') return [];
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
        detail: `aantje.s3.urlStyle is "vhost" and aantje.s3.endpoint is "${endpoint}". The virtual-host style puts the bucket in front of the host name ("bucket.${host}"), which does not resolve.`,
        cause: 'MinIO, RustFS and most self-hosted stores want the path style.',
        fix: 'Set aantje.s3.urlStyle to "path".',
        settingKey: 's3.urlStyle',
        objectKey: endpoint,
      }),
    );
  }
  if (path.replace(/\/+$/, '') !== '') {
    findings.push(
      finding('connection.endpoint-with-path', {
        severity: 'warning',
        scope: LAKE_SCOPE,
        title: 'The S3 endpoint contains a path',
        detail: `aantje.s3.endpoint is "${endpoint}". DuckDB wants only host and port; the bucket belongs in the data path of the catalog.`,
        cause: 'The URL of the bucket or of a console page was pasted.',
        fix: `Set aantje.s3.endpoint to "${host}" (with http:// in front when the store has no TLS).`,
        settingKey: 's3.endpoint',
        objectKey: endpoint,
      }),
    );
  }
  if (
    credentials !== undefined &&
    /^http:\/\//i.test(endpoint) &&
    !isLoopbackHost(host.replace(/:\d+$/, ''))
  ) {
    findings.push(cleartextFinding(endpoint, credentials));
  }
  return findings;
}

function cleartextFinding(endpoint: string, credentials: 'stored' | 'environment'): HealthFinding {
  const source =
    credentials === 'stored'
      ? 'the keys stored with "aantje: Set S3 Credentials..."'
      : 'the environment variables AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY';
  return finding('connection.endpoint-cleartext', {
    severity: 'warning',
    scope: LAKE_SCOPE,
    title: 'The S3 endpoint is a plain http:// address of another machine',
    detail: `aantje.s3.endpoint is "${endpoint}" and aantje signs its requests with ${source}. The secret key itself is not sent, but the requests and the data that come back are not encrypted, so anyone on the network between the two machines can read the data and the key id.`,
    cause: 'The store has no TLS, or the endpoint was written with http:// to avoid a certificate error.',
    fix: 'Use https:// with a certificate that this machine trusts, or keep the traffic on a network that you control.',
    settingKey: 's3.endpoint',
    objectKey: endpoint,
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
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
  readonly settingKey: string;
}

interface StoreFailure {
  readonly text: string;
  readonly timedOut: boolean;
  readonly facts: ConnectionFacts;
  readonly endpoint: string;
}

interface StoreRule {
  readonly test: (failure: StoreFailure) => boolean;
  readonly describe: (failure: StoreFailure) => StoreText;
}

const where = (endpoint: string): string => (endpoint === '' ? 'the AWS default endpoint' : `"${endpoint}"`);

function deniedReason(text: string): string {
  const code = /\b(SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied|NoSuchBucket)\b/.exec(text)?.[1];
  if (code === 'SignatureDoesNotMatch')
    return 'The store knows the key id but the secret key does not match it.';
  if (code === 'InvalidAccessKeyId') return 'The store does not know the key id.';
  if (/No credentials are provided/.test(text)) return 'No credentials were sent.';
  return 'The store refused the request.';
}

function describeDenied({ text, facts, endpoint }: StoreFailure): StoreText {
  const { credentials } = facts;
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
    cause: `${deniedReason(text)}${aws}${source}`,
    fix: 'Run "aantje: Set S3 Credentials..." with the key id and secret of this store, and check that the key may list and read the bucket. For a self-hosted store set aantje.s3.endpoint.',
    settingKey: 's3.endpoint',
  };
}

function describeNoBucket({ facts, endpoint }: StoreFailure): StoreText {
  const { dataPath } = facts;
  const bucket = dataPath === null ? undefined : bucketOf(dataPath);
  const first =
    isS3(dataPath ?? '') && endpoint === ''
      ? `First see "${NOT_SET_TITLE}" (${NOT_SET}): no endpoint is configured. `
      : '';
  return {
    check: 'connection.store-bucket-missing',
    title: 'The bucket of the data path does not exist in the object store',
    cause: `${bucket === undefined ? 'The bucket' : `The bucket "${bucket}"`} is not in the store that answers at ${where(endpoint)}: it was never created or was deleted, or the endpoint is another store than the one the lake was written to.`,
    fix: `${first}Compare the bucket in data_path with the buckets of the store, create the bucket again if the store was reset, or point aantje.s3.endpoint to the right store.`,
    settingKey: 's3.endpoint',
  };
}

const describeHostUnresolved = ({ facts }: StoreFailure): StoreText => ({
  check: 'connection.store-host-unresolved',
  title: 'The host name of the object store cannot be resolved',
  cause:
    facts.s3.urlStyle === 'vhost'
      ? 'The virtual-host style puts the bucket in front of the host name, which only works with a DNS name that has wildcard entries for the buckets.'
      : 'The host name of aantje.s3.endpoint is not known to the DNS of this machine.',
  fix: 'Use aantje.s3.urlStyle "path" for self-hosted stores, and check the host name in aantje.s3.endpoint.',
  settingKey: 's3.urlStyle',
});

const describeSslMismatch = ({ endpoint }: StoreFailure): StoreText => ({
  check: 'connection.store-ssl-mismatch',
  title: 'TLS and the object store do not match',
  cause:
    /^https:/i.test(endpoint) || !/^http:/i.test(endpoint)
      ? 'DuckDB speaks TLS (https) because the endpoint has no http:// in front or says https://, but the store answers in plain HTTP or with a certificate that DuckDB does not accept.'
      : 'The store is not reachable with the protocol that the endpoint names.',
  fix: 'For a store without TLS write the endpoint as http://host:port. For a store with TLS check its certificate.',
  settingKey: 's3.endpoint',
});

const describeUnreachable = ({ endpoint }: StoreFailure): StoreText => ({
  check: 'connection.store-unreachable',
  title: 'The object store cannot be reached',
  cause: `Nothing answers at ${where(endpoint)}: wrong host or port, the store is down, or a firewall or proxy is in the way.`,
  fix: 'Check aantje.s3.endpoint (host and port) and that the store is running and reachable from this machine.',
  settingKey: 's3.endpoint',
});

const describeNotFound = (): StoreText => ({
  check: 'connection.store-not-found',
  title: 'The server answers 404 but is no object store for this bucket',
  cause:
    'The answer has no S3 error code: a web server or proxy without a route for the bucket answered, not the object store.',
  fix: 'Check aantje.s3.endpoint: it must be the address of the S3 API, not of a web console or a proxy path.',
  settingKey: 's3.endpoint',
});

const describeUnknown = (): StoreText => ({
  check: 'connection.store-failed',
  title: 'Listing the object store failed',
  cause: 'The store or the network answered with an error that aantje does not know.',
  fix: 'Read the message below. aantje.s3.* and the S3 credentials are the first things to check.',
  settingKey: 's3.endpoint',
});

// In the order the rules are tried.
const STORE_RULES: readonly StoreRule[] = [
  {
    test: ({ text }) => /HTTP 403|\bAccessDenied\b|SignatureDoesNotMatch|InvalidAccessKeyId/.test(text),
    describe: describeDenied,
  },
  { test: ({ text }) => /\bNoSuchBucket\b/.test(text), describe: describeNoBucket },
  { test: ({ text }) => /Could not resolve hostname/.test(text), describe: describeHostUnresolved },
  { test: ({ text }) => /SSL connect error/.test(text), describe: describeSslMismatch },
  {
    test: ({ text, timedOut }) =>
      timedOut || /Could not connect to server|Connection refused|timed out|Timeout was reached/i.test(text),
    describe: describeUnreachable,
  },
  { test: ({ text }) => /HTTP 404/.test(text), describe: describeNotFound },
];

/** Explains a failed object store request from DuckDB's text; shapes reproduced with DuckDB 2.0.0 and RustFS 1.0.4. */
export function storeFailure(text: string, timedOut: boolean, facts: ConnectionFacts): HealthFinding {
  const failure: StoreFailure = { text, timedOut, facts, endpoint: facts.s3.endpoint ?? '' };
  const describe = STORE_RULES.find((rule) => rule.test(failure))?.describe ?? describeUnknown;
  const kind = describe(failure);
  // The first paragraph names the request, the second the store's answer (HTTP status and S3 error code).
  const [first = text, answer] = text.replaceAll(PROBE_NAME, '').split(/\r?\n\r?\n/);
  return finding(kind.check, {
    severity: 'error',
    scope: LAKE_SCOPE,
    title: kind.title,
    detail: [first, answer].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 400),
    cause: kind.cause,
    fix: kind.fix,
    settingKey: kind.settingKey,
  });
}

// Failures AWS gives when the lake is on a self-hosted store.
const FROM_AWS: readonly CheckId[] = [
  'connection.store-bucket-missing',
  'connection.store-access-denied',
  'connection.store-host-unresolved',
];

// Finding for a request sent to AWS because `aantje.s3.endpoint` is empty: an error for failures a self-hosted
// lake gets from AWS, else a warning when the environment names an endpoint.
export function endpointNotSet(failed: HealthFinding, facts: ConnectionFacts): HealthFinding | undefined {
  const { dataPath, s3, credentials, env } = facts;
  if (dataPath === null || !isS3(dataPath) || (s3.endpoint ?? '') !== '') return undefined;
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
