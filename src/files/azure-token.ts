import { createHash } from 'node:crypto';
import { AantjeError } from '../errors';
import type { ResolvedStorage } from '../storage/config';
import { chainToken } from './azure-chain';
import type { ChainDeps } from './azure-chain';
import { certificateToken, secretToken } from './entra';
import type { AccessToken } from './entra';

// The Entra token of an Azure or OneLake storage that signs in with a service principal or a credential chain: only
// the engine's azure extension resolves those for the lake, and it hands out no token, so the Files folder fetches its
// own (`entra.ts`, `azure-chain.ts`). A token is kept per connection and sign-in until shortly before it runs out.

/** How long before its end a token is fetched anew. */
const RENEW_BEFORE_MS = 5 * 60_000;

/** A token of the storage for the listing of one connection. */
export type AzureTokenSource = (
  connectionId: string,
  storage: ResolvedStorage,
  timeoutMs?: number,
) => Promise<string>;

/** Whether the listing of the storage signs in with a token that aantje fetches itself. */
export function fetchesOwnToken({ config }: ResolvedStorage): boolean {
  return (
    (config.kind === 'azure' || config.kind === 'onelake') &&
    (config.signIn === 'servicePrincipal' || config.signIn === 'chain')
  );
}

function fetchToken(storage: ResolvedStorage, deps: ChainDeps): Promise<AccessToken> {
  const { config, values } = storage;
  if (config.kind !== 'azure' && config.kind !== 'onelake') {
    return Promise.reject(
      new AantjeError('CONNECTION_FAILED', 'The storage is no Azure or OneLake storage.'),
    );
  }
  if (config.signIn === 'chain') return chainToken(config.chain, deps);
  const tenant = config.tenant ?? '';
  const clientId = config.clientId ?? '';
  return config.certificatePath === undefined
    ? secretToken(deps, tenant, clientId, values.clientSecret ?? '')
    : certificateToken(deps, tenant, clientId, config.certificatePath);
}

// The connection, the whole sign-in (tenant, client, certificate path, chain) and a digest of the client secret, so
// that a new secret fetches a new token. The key stays in memory.
function cacheKey(connectionId: string, storage: ResolvedStorage): string {
  const secret = createHash('sha256')
    .update(storage.values.clientSecret ?? '')
    .digest('hex');
  return JSON.stringify([connectionId, storage.config, secret]);
}

interface Entry {
  readonly token: Promise<AccessToken>;
  expiresAt?: number;
}

/**
 * The tokens of the Files folder. Listings that ask at the same time share one request; a failure is not kept, so the
 * next listing asks again.
 */
export function createAzureTokens(deps: ChainDeps): AzureTokenSource {
  const cache = new Map<string, Entry>();
  return async (connectionId, storage, timeoutMs) => {
    const key = cacheKey(connectionId, storage);
    const now = (deps.now?.() ?? new Date()).getTime();
    let entry = cache.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt - RENEW_BEFORE_MS <= now) {
      cache.delete(key);
      entry = undefined;
    }
    if (entry === undefined) {
      const created: Entry = {
        token: fetchToken(storage, timeoutMs === undefined ? deps : { ...deps, timeoutMs }),
      };
      cache.set(key, created);
      created.token.then(
        (token) => {
          created.expiresAt = token.expiresAt;
        },
        () => {
          if (cache.get(key) === created) cache.delete(key);
        },
      );
      entry = created;
    }
    return (await entry.token).token;
  };
}
