import { maskSecrets } from '../secrets';
import type { IcebergFact } from './status';
import { oauth2ServerUriOf } from './target';
import type { IcebergTarget } from './target';

/** The part of `fetch` the client uses; a test passes its own. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 15_000;
const PARALLEL = 8;

/**
 * The 64 bit snapshot ids of a table response as text: `JSON.parse` would round them. The keys that carry them are named in
 * the Iceberg REST specification, so only their numbers are quoted.
 */
export function quoteSnapshotIds(text: string): string {
  return text.replace(
    /("(?:current-snapshot-id|snapshot-id|parent-snapshot-id)"\s*:\s*)(-?\d{15,})/g,
    '$1"$2"',
  );
}

interface Metadata {
  readonly 'current-snapshot-id'?: unknown;
  readonly 'snapshot-log'?: unknown;
}

function factOf(text: string): IcebergFact {
  const body = JSON.parse(quoteSnapshotIds(text)) as { metadata?: Metadata };
  const metadata = body.metadata ?? {};
  const id = (value: unknown): string | undefined =>
    typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
  const current = id(metadata['current-snapshot-id']);
  const log = Array.isArray(metadata['snapshot-log'])
    ? (metadata['snapshot-log'] as { 'snapshot-id'?: unknown }[]).flatMap(
        (entry) => id(entry['snapshot-id']) ?? [],
      )
    : [];
  // A table without a snapshot has the id -1 in some catalogs.
  return { kind: 'table', current: current === '-1' ? undefined : current, log };
}

/**
 * Asks the REST catalog for the current snapshot and the snapshot log of each table; no DuckDB and no write. Signs in with
 * the secret of the target (OAuth2 client credentials, or the token). A failure that hits every table (sign-in, the
 * catalog is down) is returned as `error`, one that hits a table is the fact of that table.
 */
export async function readIcebergFacts(
  target: IcebergTarget,
  secret: string | undefined,
  tables: readonly { readonly schema: string; readonly table: string }[],
  fetcher: Fetch = fetch,
): Promise<{ readonly facts: Map<string, IcebergFact>; readonly error?: string }> {
  const hidden = secret === undefined ? [] : [secret];
  const failure = (cause: unknown): string =>
    maskSecrets(cause instanceof Error ? cause.message : String(cause), hidden);
  const facts = new Map<string, IcebergFact>();
  let headers: Record<string, string>;
  let prefix: string;
  try {
    headers = await signIn(target, secret, fetcher);
    prefix = await prefixOf(target, headers, fetcher);
  } catch (cause) {
    return { facts, error: failure(cause) };
  }
  const base = target.endpoint.replace(/\/+$/, '');
  const queue = [...tables];
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const key = `${next.schema}.${next.table}`;
      try {
        const response = await fetcher(
          `${base}/v1/${encodeURIComponent(prefix)}/namespaces/${encodeURIComponent(next.schema)}/tables/${encodeURIComponent(next.table)}`,
          { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        );
        if (response.status === 404) facts.set(key, { kind: 'missing' });
        else if (!response.ok)
          facts.set(key, { kind: 'error', message: `The catalog answered HTTP ${response.status}.` });
        else facts.set(key, factOf(await response.text()));
      } catch (cause) {
        facts.set(key, { kind: 'error', message: failure(cause) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
  return { facts };
}

async function signIn(
  target: IcebergTarget,
  secret: string | undefined,
  fetcher: Fetch,
): Promise<Record<string, string>> {
  if (target.signIn === 'none') return {};
  if (secret === undefined) {
    throw new Error(
      target.signIn === 'entra'
        ? 'Not signed in with your Microsoft account. Sync to Iceberg signs in.'
        : 'No sign-in is stored for this target. Sync to Iceberg asks for it.',
    );
  }
  if (target.signIn === 'token' || target.signIn === 'entra') return { Authorization: `Bearer ${secret}` };
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: target.clientId ?? '',
    client_secret: secret,
    scope: target.scope ?? 'PRINCIPAL_ROLE:ALL',
  });
  const response = await fetcher(oauth2ServerUriOf(target), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`The sign-in to the catalog failed (HTTP ${response.status}).`);
  const token = ((await response.json()) as { access_token?: unknown }).access_token;
  if (typeof token !== 'string') throw new Error('The catalog sent no access token.');
  return { Authorization: `Bearer ${token}` };
}

/** The path prefix of the catalog: what `/v1/config` says, else the warehouse name. */
async function prefixOf(
  target: IcebergTarget,
  headers: Record<string, string>,
  fetcher: Fetch,
): Promise<string> {
  const url = `${target.endpoint.replace(/\/+$/, '')}/v1/config?warehouse=${encodeURIComponent(target.warehouse)}`;
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) return target.warehouse;
  const config = (await response.json()) as {
    overrides?: { prefix?: unknown };
    defaults?: { prefix?: unknown };
  };
  const prefix = config.overrides?.prefix ?? config.defaults?.prefix;
  return typeof prefix === 'string' && prefix !== '' ? prefix : target.warehouse;
}

/**
 * Drops the table when the catalog has it without any snapshot: nothing is lost. OneLake creates a table before its
 * data (it does not stage a create), so a write that fails there leaves such an empty table, which DuckDB does not list
 * and which a later create runs into (`AlreadyExistsException`). True when it dropped one.
 */
export async function dropEmptyTable(
  target: IcebergTarget,
  secret: string | undefined,
  table: { readonly namespace: string; readonly name: string },
  fetcher: Fetch = fetch,
): Promise<boolean> {
  const headers = await signIn(target, secret, fetcher);
  const prefix = await prefixOf(target, headers, fetcher);
  const url = `${target.endpoint.replace(/\/+$/, '')}/v1/${encodeURIComponent(prefix)}/namespaces/${encodeURIComponent(table.namespace)}/tables/${encodeURIComponent(table.name)}`;
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) return false;
  const fact = factOf(await response.text());
  if (fact.kind !== 'table' || fact.current !== undefined) return false;
  const dropped = await fetcher(url, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return dropped.ok;
}
