import { X509Certificate, constants, createHash, createPrivateKey, randomUUID, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { STORAGE_SCOPE } from '../azure/arm';
import { AantjeError } from '../errors';
import { isObject } from '../guards';
import { maskSecrets } from '../secrets';
import { request, shownText } from './http';
import type { Http } from './http';

// The token of a service principal for the storage service, fetched by aantje itself: the OAuth 2.0 client credentials
// grant of the Microsoft identity platform, with a client secret or a signed client assertion (a certificate, or the
// federated token of a workload identity). One POST to the token endpoint of the authority, no SDK. OneLake accepts
// tokens of the storage audience only, so Azure and OneLake ask for the same scope.

/** The authority of the public Azure cloud, the only cloud whose storage endpoints the Files folder lists. */
export const ENTRA_AUTHORITY = 'https://login.microsoftonline.com';

/** An access token and when it runs out, in milliseconds since 1970. */
export interface AccessToken {
  readonly token: string;
  readonly expiresAt: number;
}

export interface EntraDeps {
  readonly http: Http;
  /** The base URL of the authority; the tests point it at a fake. */
  readonly authority?: string;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  /** Reads a certificate or token file; the tests replace it. */
  readonly readFile?: (path: string) => Promise<string>;
  /** Receives every secret, assertion and token for the masking of the log. */
  readonly register: (value: string) => void;
}

const SERVICE = 'Microsoft Entra ID';
const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
/** How long a client assertion is valid; Microsoft asks for 5 to 10 minutes at most. */
const ASSERTION_SECONDS = 600;
// A tenant is a GUID or a domain name; anything else would change the path of the token endpoint.
const TENANT = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

const clock = (deps: Pick<EntraDeps, 'now'>): Date => deps.now?.() ?? new Date();

/** The token endpoint of `tenant` at the authority. */
export function tokenEndpoint(authority: string, tenant: string): string {
  if (!TENANT.test(tenant)) {
    throw new AantjeError('INVALID_PROFILE', 'The tenant is neither a directory ID nor a domain name.');
  }
  return `${authority.replace(/\/+$/, '')}/${tenant}/oauth2/v2.0/token`;
}

/** The JSON of an answer; undefined when it is none. */
export function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The token of an answer of the token endpoint or of the managed identity endpoint: `access_token`, and `expires_in`
 * (seconds from `now`, robust against a wrong clock) or else `expires_on` (seconds since 1970). Without either the
 * token counts as expired, so it is used once and not kept.
 */
export function tokenOfAnswer(parsed: unknown, now: number): AccessToken | undefined {
  if (!isObject(parsed) || typeof parsed.access_token !== 'string' || parsed.access_token === '') {
    return undefined;
  }
  const inSeconds = Number(parsed.expires_in);
  const onSeconds = Number(parsed.expires_on);
  const expiresAt =
    Number.isFinite(inSeconds) && inSeconds > 0
      ? now + inSeconds * 1000
      : Number.isFinite(onSeconds) && onSeconds > 0
        ? onSeconds * 1000
        : now;
  return { token: parsed.access_token, expiresAt };
}

/** The error and the first line of the description of an OAuth error answer, without the given secrets. */
export function oauthError(parsed: unknown, secrets: readonly string[]): string {
  const code = isObject(parsed) && typeof parsed.error === 'string' ? parsed.error : '';
  const description =
    isObject(parsed) && typeof parsed.error_description === 'string'
      ? (parsed.error_description.split(/\r?\n/)[0] ?? '')
      : '';
  return maskSecrets([code, description].filter((part) => part.trim() !== '').join(': '), secrets);
}

async function tokenRequest(
  deps: EntraDeps,
  tenant: string,
  credential: Readonly<Record<string, string>>,
  secrets: readonly string[],
): Promise<AccessToken> {
  const url = tokenEndpoint(deps.authority ?? ENTRA_AUTHORITY, tenant);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: STORAGE_SCOPE,
    ...credential,
  }).toString();
  const started = clock(deps).getTime();
  const response = await request(
    deps.http,
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    },
    { timeoutMs: deps.timeoutMs, service: SERVICE },
  );
  const parsed = jsonOf(await response.text());
  if (response.status !== 200) {
    const what = oauthError(parsed, secrets);
    throw new AantjeError(
      response.status >= 400 && response.status < 500 ? 'AUTH_FAILED' : 'CONNECTION_FAILED',
      shownText(
        `Microsoft Entra ID refused the token request (HTTP ${response.status}${what === '' ? ')' : `): ${what}`}`,
      ),
    );
  }
  const token = tokenOfAnswer(parsed, started);
  if (token === undefined) {
    throw new AantjeError('CONNECTION_FAILED', 'Microsoft Entra ID answered without an access token.');
  }
  deps.register(token.token);
  return token;
}

/** The token of a service principal that proves itself with a client secret. */
export function secretToken(
  deps: EntraDeps,
  tenant: string,
  clientId: string,
  secret: string,
): Promise<AccessToken> {
  deps.register(secret);
  return tokenRequest(deps, tenant, { client_id: clientId, client_secret: secret }, [secret]);
}

/** The token of a service principal that proves itself with a signed assertion (certificate, federated token). */
export function assertionToken(
  deps: EntraDeps,
  tenant: string,
  clientId: string,
  assertion: string,
): Promise<AccessToken> {
  deps.register(assertion);
  return tokenRequest(
    deps,
    tenant,
    { client_id: clientId, client_assertion_type: ASSERTION_TYPE, client_assertion: assertion },
    [assertion],
  );
}

/** The text of a file the sign-in needs; a file that cannot be read names `what` and the reason, not the content. */
export async function readSignInFile(deps: EntraDeps, path: string, what: string): Promise<string> {
  try {
    return await (deps.readFile ?? ((file: string) => readFile(file, 'utf8')))(path);
  } catch (cause) {
    const code = isObject(cause) && typeof cause.code === 'string' ? ` (${cause.code})` : '';
    throw new AantjeError('AUTH_FAILED', shownText(`${what} "${path}" cannot be read${code}.`), { cause });
  }
}

/** The token of a service principal with the certificate in the PEM file at `path`, read only now. */
export async function certificateToken(
  deps: EntraDeps,
  tenant: string,
  clientId: string,
  path: string,
): Promise<AccessToken> {
  const pem = await readSignInFile(deps, path, 'The certificate file');
  const audience = tokenEndpoint(deps.authority ?? ENTRA_AUTHORITY, tenant);
  return assertionToken(deps, tenant, clientId, clientAssertion(pem, clientId, audience, clock(deps)));
}

const certificateProblem = (reason: string, cause?: unknown): AantjeError =>
  new AantjeError('AUTH_FAILED', `The certificate file cannot be used: ${reason}.`, { cause });

const base64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');

// The blocks of a PEM file: the private key and the certificates (one file holds both, as DuckDB's azure extension
// reads it).
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;

function privateKeyOf(blocks: readonly RegExpMatchArray[]): KeyObject {
  const block = blocks.find(([, label]) => label === 'PRIVATE KEY' || label === 'RSA PRIVATE KEY');
  if (block === undefined) {
    throw certificateProblem(
      blocks.some(([, label]) => label === 'ENCRYPTED PRIVATE KEY')
        ? 'its private key is encrypted; aantje needs the key without a password'
        : 'it holds no private key (aantje reads a PEM file with the certificate and its key)',
    );
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(block[0]);
  } catch (cause) {
    throw certificateProblem('its private key cannot be read', cause);
  }
  if (key.asymmetricKeyType !== 'rsa') throw certificateProblem('its key is no RSA key');
  return key;
}

function certificateOf(blocks: readonly RegExpMatchArray[], key: KeyObject): X509Certificate {
  const certificates: X509Certificate[] = [];
  for (const [block, label] of blocks) {
    if (label !== 'CERTIFICATE') continue;
    try {
      certificates.push(new X509Certificate(block));
    } catch (cause) {
      throw certificateProblem('a certificate in it cannot be read', cause);
    }
  }
  const own = certificates.find((certificate) => certificate.checkPrivateKey(key));
  if (own === undefined) {
    throw certificateProblem(
      certificates.length === 0
        ? 'it holds no certificate'
        : 'no certificate in it belongs to its private key',
    );
  }
  return own;
}

/**
 * The client assertion of a certificate as Microsoft documents it ("certificate credentials" of the Microsoft identity
 * platform): a JWT signed PS256 with the private key, the SHA-256 thumbprint of the certificate in `x5t#S256`, the
 * token endpoint as `aud`, the client as `iss` and `sub`, a fresh `jti`, valid from now for ten minutes.
 */
export function clientAssertion(pem: string, clientId: string, audience: string, now: Date): string {
  const blocks = [...pem.matchAll(PEM_BLOCK)];
  const key = privateKeyOf(blocks);
  const certificate = certificateOf(blocks, key);
  const header = {
    alg: 'PS256',
    typ: 'JWT',
    'x5t#S256': base64url(createHash('sha256').update(certificate.raw).digest()),
  };
  const seconds = Math.floor(now.getTime() / 1000);
  const claims = {
    aud: audience,
    iss: clientId,
    sub: clientId,
    jti: randomUUID(),
    nbf: seconds,
    iat: seconds,
    exp: seconds + ASSERTION_SECONDS,
  };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = sign('sha256', Buffer.from(input), {
    key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return `${input}.${base64url(signature)}`;
}
