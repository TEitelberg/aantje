import type { ResolvedStorage, StorageKind } from './config';

// What a failed request to the storage of a lake means, read from the text of DuckDB, of curl below it, of the S3
// answer and of the Azure answer. One classifier for the button of a failed read, the connection check, the deep check
// and the messages of the engine and the SQL editor, so they agree.

/** The kinds of failure, in the order the rules are tried. */
export type StoreProblem =
  | 'no-bucket'
  | 'not-found'
  | 'expired'
  | 'role'
  | 'denied'
  | 'unresolved'
  | 'ssl'
  | 'unreachable'
  | 'missing-file';

/** Where a failure has to be fixed: the sign-in, the place the data should be at, the network, or the file itself. */
export type ProblemSide = 'sign-in' | 'storage-missing' | 'network' | 'file';

export const SIDE: Readonly<Record<StoreProblem, ProblemSide>> = {
  expired: 'sign-in',
  role: 'sign-in',
  denied: 'sign-in',
  'no-bucket': 'storage-missing',
  'not-found': 'storage-missing',
  unresolved: 'network',
  ssl: 'network',
  unreachable: 'network',
  'missing-file': 'file',
};

const S3: readonly StorageKind[] = ['aws', 's3'];
const AZURE: readonly StorageKind[] = ['azure', 'onelake'];

interface Rule {
  readonly problem: StoreProblem;
  readonly pattern: RegExp;
  /** The storage kinds whose texts this rule reads; a rule without kinds reads every text. */
  readonly kinds?: readonly StorageKind[];
}

const RULES: readonly Rule[] = [
  // An answer of 404 wins over a refusal in the same text: the bucket, the container or the key is gone.
  { problem: 'no-bucket', pattern: /\bNoSuchBucket\b/, kinds: S3 },
  {
    problem: 'no-bucket',
    pattern:
      /\b(?:ContainerNotFound|FilesystemNotFound)\b|The specified (?:container|filesystem) does not exist/i,
    kinds: AZURE,
  },
  { problem: 'not-found', pattern: /HTTP 404|\bNoSuchKey\b/ },
  {
    problem: 'not-found',
    pattern: /\b(?:BlobNotFound|PathNotFound|ResourceNotFound)\b|The specified (?:blob|path) does not exist/i,
    kinds: AZURE,
  },
  // A sign-in that ran out: an expired session token, access token or SAS. Before the plain refusal, which it comes with.
  {
    problem: 'expired',
    pattern:
      /\bExpiredToken\b|\bExpiredAuthenticationToken\b|token (?:has )?expired|\bLifetime validation failed\b|not valid in the specified time frame|(?:signature|SAS)(?: token)? (?:has )?expired/i,
  },
  // The account is known but may not do this: no role on the storage (Azure) or a firewall of the account.
  {
    problem: 'role',
    pattern:
      /\bAuthorizationPermissionMismatch\b|\bAuthorizationFailure\b|does not have authorization|not authorized to perform this operation/i,
    kinds: AZURE,
  },
  // The store refused the request: HTTP 401 or 403, or the code of bad keys or a bad token.
  {
    problem: 'denied',
    pattern: /HTTP 40[13]|\bAccessDenied\b|\bSignatureDoesNotMatch\b|\bInvalidAccessKeyId\b/,
  },
  {
    problem: 'denied',
    pattern:
      /\bAuthenticationFailed\b|\bInvalidAuthenticationInfo\b|\bUnauthorized\b|Server failed to authenticate the request/,
    kinds: AZURE,
  },
  {
    problem: 'unresolved',
    pattern: /Could not resolve host|Couldn't resolve host|server name or address could not be resolved/i,
  },
  { problem: 'ssl', pattern: /SSL connect error|Problem with the SSL CA cert|SSL certificate problem/ },
  { problem: 'unreachable', pattern: /Could not connect|Connection refused|timed out|Timeout was reached/i },
  // A local data file is gone, or a path matched nothing. Other "No such file or directory" messages (a catalog file,
  // an extension directory) must not match.
  {
    problem: 'missing-file',
    pattern:
      /No files found that match the pattern|does not exist on this machine|IO Error: Cannot open file "[^"]*": (?:No such file or directory|The system cannot find the (?:file|path) specified)/,
  },
];

/**
 * The kind of a failure of the storage; undefined for a text that names none. `kind` limits the rules that are specific
 * to a storage (S3 codes, Azure codes); without it every rule reads the text.
 */
export function storeProblemOf(text: string, kind?: StorageKind): StoreProblem | undefined {
  return RULES.find(
    ({ pattern, kinds }) =>
      (kinds === undefined || kind === undefined || kinds.includes(kind)) && pattern.test(text),
  )?.problem;
}

/** The side of the failure in `text`: sign-in, storage-missing, network or file; undefined when it names none. */
export function problemSideOf(text: string, kind?: StorageKind): ProblemSide | undefined {
  const problem = storeProblemOf(text, kind);
  return problem === undefined ? undefined : SIDE[problem];
}

/** What the wording of a message needs to know about the storage: its kind and whether the connection owns it. */
export interface StorageContext {
  readonly kind?: StorageKind;
  /**
   * The storage is set on the connection itself (`storage` or the legacy Azure account), so a message points to Edit
   * Connection. Without it the S3 settings and keys of the machine are meant, as before.
   */
  readonly perConnection: boolean;
}

export function storageContextOf(storage: ResolvedStorage | undefined): StorageContext {
  return storage === undefined
    ? { perConnection: false }
    : { kind: storage.config.kind, perConnection: storage.legacy !== 'settings' };
}

const EDIT = 'Edit Connection, or "Set Storage Sign-in..." for the keys and tokens only';

/** The sentence that tells where to fix a refused sign-in; for a connection with its own storage it is the connection. */
export function signInAdvice(context: StorageContext): string {
  if (context.perConnection) {
    return `Check the sign-in of the storage: ${EDIT}.`;
  }
  return 'Check the S3 credentials: the settings aantje.s3.* and the command "aantje: Set S3 Credentials...".';
}

/** The sentence for a failed file or network read of the lake: where the data and the sign-in are set. */
export function dataAdvice(context: StorageContext): string {
  return context.perConnection
    ? `Check that the data files exist and the storage of the connection (${EDIT}).`
    : 'Check that the data files exist and, for S3 data, the settings aantje.s3.* and the command "aantje: Set S3 Credentials...".';
}

/** The likely cause that names where the lake was written to: another place than the storage the connection uses. */
export function otherPlaceCause(context: StorageContext): string {
  return context.perConnection
    ? 'the storage of the connection (Edit Connection), the bucket, the container or the data_path of the catalog points to another place than the one the lake was written to'
    : 'the setting aantje.s3.endpoint, the bucket or the data_path of the catalog points to another store than the one the lake was written to';
}

/** The text for a refusal (HTTP 403) of the storage in the SQL editor. */
export function refusedText(context: StorageContext): string {
  if (!context.perConnection) {
    return 'The object store refused access to the data path (HTTP 403). Check the S3 credentials and their permissions on the bucket.';
  }
  const azure = context.kind === 'azure' || context.kind === 'onelake';
  const what = azure
    ? 'Check the sign-in and that the account has a role that may read the data (for example Storage Blob Data Reader), and sign in again for an expired token or SAS'
    : 'Check the keys and their permissions on the bucket';
  return `The storage refused access to the data path. ${what}: ${EDIT}.`;
}
