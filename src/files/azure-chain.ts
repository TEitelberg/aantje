import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AantjeError, isAantjeError } from '../errors';
import { isObject } from '../guards';
import {
  assertionToken,
  certificateToken,
  jsonOf,
  oauthError,
  readSignInFile,
  secretToken,
  tokenOfAnswer,
} from './entra';
import type { AccessToken, EntraDeps } from './entra';
import { request, shownText } from './http';

// The credential chain of an Azure or OneLake storage, followed by aantje itself so that the Files folder has a token:
// the providers of DuckDB's azure extension (`env`, `workload_identity`, `managed_identity`, `cli`, and `default` for
// all four in the order of the Azure SDK), in the order the chain names them. A provider that fails hands over to the
// next; the first token wins. Requests go only to the token endpoint of the authority and to the managed identity
// endpoint of the machine (IMDS); the Azure CLI runs without a shell where it can.

export type RunFile = (
  file: string,
  args: readonly string[],
  options: { readonly timeout: number; readonly cwd: string; readonly windowsHide: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export interface ChainDeps extends EntraDeps {
  /** The environment variables; `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The base URL of the managed identity endpoint; the tests point it at a fake. */
  readonly imds?: string;
  /** Runs the Azure CLI; the tests replace it. */
  readonly runFile?: RunFile;
  readonly platform?: NodeJS.Platform;
}

/** DuckDB's `default`: the providers of the Azure SDK's DefaultAzureCredential (C++), in its order. */
const DEFAULT_CHAIN = ['env', 'workload_identity', 'managed_identity', 'cli'] as const;

const IMDS = 'http://169.254.169.254';
/** The managed identity endpoint answers at once on an Azure machine; elsewhere nobody does. */
const IMDS_TIMEOUT_MS = 3000;
const STORAGE_RESOURCE = 'https://storage.azure.com/';
const CLI_TIMEOUT_MS = 30_000;
const CLI_ARGS = ['account', 'get-access-token', '--resource', STORAGE_RESOURCE, '--output', 'json'] as const;

const environment = (deps: ChainDeps): Readonly<Record<string, string | undefined>> =>
  deps.env ?? process.env;
const now = (deps: ChainDeps): number => (deps.now?.() ?? new Date()).getTime();
const notSet = (names: string): AantjeError => new AantjeError('AUTH_FAILED', `${names} are not set.`);

/** `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and a client secret or the path of a certificate (PEM). */
async function fromEnvironment(deps: ChainDeps): Promise<AccessToken> {
  const env = environment(deps);
  const tenant = env.AZURE_TENANT_ID;
  const clientId = env.AZURE_CLIENT_ID;
  const secret = env.AZURE_CLIENT_SECRET;
  const certificate = env.AZURE_CLIENT_CERTIFICATE_PATH;
  if (!tenant || !clientId || (!secret && !certificate)) {
    throw notSet('AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET or AZURE_CLIENT_CERTIFICATE_PATH');
  }
  return secret
    ? secretToken(deps, tenant, clientId, secret)
    : certificateToken(deps, tenant, clientId, certificate ?? '');
}

/** The federated token of a workload identity (Kubernetes) as the client assertion of its app. */
async function fromWorkloadIdentity(deps: ChainDeps): Promise<AccessToken> {
  const env = environment(deps);
  const tenant = env.AZURE_TENANT_ID;
  const clientId = env.AZURE_CLIENT_ID;
  const file = env.AZURE_FEDERATED_TOKEN_FILE;
  if (!tenant || !clientId || !file) {
    throw notSet('AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_FEDERATED_TOKEN_FILE');
  }
  const assertion = (await readSignInFile(deps, file, 'The federated token file')).trim();
  return assertionToken(deps, tenant, clientId, assertion);
}

/** The system-assigned managed identity of an Azure machine, from its instance metadata service. */
async function fromManagedIdentity(deps: ChainDeps): Promise<AccessToken> {
  const query = new URLSearchParams({ 'api-version': '2018-02-01', resource: STORAGE_RESOURCE });
  const started = now(deps);
  const response = await request(
    deps.http,
    `${deps.imds ?? IMDS}/metadata/identity/oauth2/token?${query.toString()}`,
    { method: 'GET', headers: { Metadata: 'true' } },
    {
      timeoutMs: Math.min(IMDS_TIMEOUT_MS, deps.timeoutMs ?? IMDS_TIMEOUT_MS),
      service: 'The managed identity endpoint (IMDS)',
    },
  );
  const parsed = jsonOf(await response.text());
  if (response.status !== 200) {
    const what = oauthError(parsed, []);
    throw new AantjeError(
      'AUTH_FAILED',
      shownText(
        `The managed identity endpoint refused the token (HTTP ${response.status}${what === '' ? ')' : `): ${what}`}`,
      ),
    );
  }
  const token = tokenOfAnswer(parsed, started);
  if (token === undefined) {
    throw new AantjeError('AUTH_FAILED', 'The managed identity endpoint answered without an access token.');
  }
  deps.register(token.token);
  return token;
}

const runFile: RunFile = async (file, args, options) => {
  const { stdout, stderr } = await promisify(execFile)(file, [...args], { ...options, encoding: 'utf8' });
  return { stdout, stderr };
};

// On Windows `az` is a batch file, which only cmd.exe runs; its command line holds the fixed words of CLI_ARGS only.
// The working directory is a system folder, so that no `az` of the current folder is run instead.
function cliCommand(deps: ChainDeps): { file: string; args: readonly string[]; cwd: string } {
  const env = environment(deps);
  if ((deps.platform ?? process.platform) === 'win32') {
    return {
      file: env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/c', 'az', ...CLI_ARGS],
      cwd: env.SystemRoot ?? 'C:\\Windows',
    };
  }
  return { file: 'az', args: CLI_ARGS, cwd: '/' };
}

function cliFailure(error: unknown, timeout: number): AantjeError {
  const failed = isObject(error) ? error : {};
  const stderr = typeof failed.stderr === 'string' ? failed.stderr : '';
  // Without `az` the system says so (ENOENT); cmd.exe ends with 1 and its own words, in English here.
  if (failed.code === 'ENOENT' || /is not recognized as an internal or external/i.test(stderr)) {
    return new AantjeError('AUTH_FAILED', 'The Azure CLI is not installed.', { cause: error });
  }
  if (failed.killed === true) {
    return new AantjeError('TIMEOUT', `The Azure CLI did not answer within ${timeout / 1000} s.`, {
      cause: error,
    });
  }
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim() !== '');
  const line = lines.find((text) => text.startsWith('ERROR')) ?? lines[0];
  return new AantjeError(
    'AUTH_FAILED',
    line === undefined ? 'The Azure CLI gave no token.' : shownText(`The Azure CLI gave no token: ${line}`),
    { cause: error },
  );
}

/** The token of the account that `az login` signed in. */
async function fromCli(deps: ChainDeps): Promise<AccessToken> {
  const { file, args, cwd } = cliCommand(deps);
  const timeout = Math.min(CLI_TIMEOUT_MS, deps.timeoutMs ?? CLI_TIMEOUT_MS);
  let stdout: string;
  try {
    ({ stdout } = await (deps.runFile ?? runFile)(file, args, { timeout, cwd, windowsHide: true }));
  } catch (error) {
    throw cliFailure(error, timeout);
  }
  const parsed = jsonOf(stdout);
  if (!isObject(parsed) || typeof parsed.accessToken !== 'string' || parsed.accessToken === '') {
    throw new AantjeError('AUTH_FAILED', 'The Azure CLI answered without an access token.');
  }
  deps.register(parsed.accessToken);
  // `expires_on` (seconds since 1970) since Azure CLI 2.54; older ones write `expiresOn` in local time.
  const expiresAt =
    typeof parsed.expires_on === 'number'
      ? parsed.expires_on * 1000
      : typeof parsed.expiresOn === 'string'
        ? Date.parse(parsed.expiresOn)
        : Number.NaN;
  return { token: parsed.accessToken, expiresAt: Number.isFinite(expiresAt) ? expiresAt : now(deps) };
}

const PROVIDERS: Readonly<Record<string, (deps: ChainDeps) => Promise<AccessToken>>> = {
  env: fromEnvironment,
  workload_identity: fromWorkloadIdentity,
  managed_identity: fromManagedIdentity,
  cli: fromCli,
};

/** The providers of a chain, in its order: `default` stands for its four, each provider is tried once. */
export function chainProviders(chain: string | undefined): string[] {
  const names = (chain ?? 'default')
    .split(';')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '')
    .flatMap((name) => (name === 'default' ? [...DEFAULT_CHAIN] : [name]));
  return [...new Set(names)];
}

const reasonOf = (error: unknown): string =>
  isAantjeError(error) ? error.userMessage.replace(/\.$/, '') : 'an unexpected error (see the log)';

/**
 * The first token that a provider of the chain gives. When none does, the error names each provider with its reason;
 * the reasons hold no secret (the masked Entra answer, the first error line of the Azure CLI).
 */
export async function chainToken(chain: string | undefined, deps: ChainDeps): Promise<AccessToken> {
  const reasons: string[] = [];
  const errors: unknown[] = [];
  for (const name of chainProviders(chain)) {
    const provider = PROVIDERS[name];
    if (provider === undefined) {
      reasons.push(`${name}: not a provider of the chain`);
      continue;
    }
    try {
      return await provider(deps);
    } catch (error) {
      errors.push(error);
      reasons.push(`${name}: ${reasonOf(error)}`);
    }
  }
  throw new AantjeError('AUTH_FAILED', `The credential chain gave no token. ${reasons.join('; ')}.`, {
    cause: new AggregateError(errors, 'The providers of the credential chain failed.'),
  });
}
