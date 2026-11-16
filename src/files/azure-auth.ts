import { createHmac } from 'node:crypto';
import { ONELAKE_HOST } from '../storage/config';
import type { ResolvedStorage } from '../storage/config';

// How the listing of an Azure or OneLake storage signs in: with the values the storage of the connection holds (the
// Entra token that aantje fetched, the SAS, the account key, the connection string). A service principal or a
// credential chain signs in with the token that the Files folder fetched for it (`azure-token.ts`); without one the
// sign-in is named, so the tree can say why it does not list.

export type AzureAuth =
  | { readonly kind: 'bearer'; readonly token: string }
  | { readonly kind: 'sas'; readonly query: string }
  | { readonly kind: 'sharedKey'; readonly account: string; readonly key: string };

/** Where the listing requests of a storage go and how they are signed. */
export interface AzureAccess {
  readonly protocol: 'https' | 'http';
  /** The DFS endpoint: ADLS Gen2 and OneLake. */
  readonly dfsHost: string;
  /** The Blob endpoint; OneLake is listed through DFS only. */
  readonly blobHost?: string;
  readonly auth: AzureAuth;
}

export type AzureAccessResult = AzureAccess | { readonly unsupported: string };

/** The version of the storage REST API the requests ask for. */
const AZURE_API_VERSION = '2021-06-08';

/** The parts of a connection string by name, the names in lower case. */
function connectionStringParts(text: string): Map<string, string> {
  const parts = new Map<string, string>();
  for (const part of text.split(';')) {
    const at = part.indexOf('=');
    if (at > 0) parts.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  return parts;
}

const unsupported = (signIn: string): { unsupported: string } => ({
  unsupported: `The Files folder has no token for the sign-in "${signIn}" of this storage.`,
});

function fromConnectionString(text: string, account: string): AzureAccessResult {
  const parts = connectionStringParts(text);
  const blobEndpoint = parts.get('blobendpoint');
  let endpoint: URL | undefined;
  try {
    endpoint = blobEndpoint === undefined ? undefined : new URL(blobEndpoint);
  } catch {
    endpoint = undefined;
  }
  const name = parts.get('accountname') ?? endpoint?.hostname.split('.')[0] ?? account;
  const suffix = parts.get('endpointsuffix') ?? 'core.windows.net';
  const blobHost = endpoint?.host ?? `${name}.blob.${suffix}`;
  const scheme = (
    parts.get('defaultendpointsprotocol') ??
    endpoint?.protocol.replace(':', '') ??
    'https'
  ).toLowerCase();
  const key = parts.get('accountkey');
  const sas = parts.get('sharedaccesssignature');
  const auth: AzureAuth | undefined =
    key !== undefined
      ? { kind: 'sharedKey', account: name, key }
      : sas !== undefined
        ? { kind: 'sas', query: sas.replace(/^\?/, '') }
        : undefined;
  if (auth === undefined)
    return { unsupported: 'The connection string holds neither an account key nor a SAS.' };
  return {
    protocol: scheme === 'http' ? 'http' : 'https',
    dfsHost: blobHost.replace('.blob.', '.dfs.'),
    blobHost,
    auth,
  };
}

/** The access of the listing for an Azure or OneLake storage; undefined for any other storage. */
export function azureAccessOf(storage: ResolvedStorage): AzureAccessResult | undefined {
  const { config, values } = storage;
  if (config.kind === 'onelake') {
    return config.signIn === 'entra' || values.accessToken !== undefined
      ? {
          protocol: 'https',
          dfsHost: ONELAKE_HOST,
          auth: { kind: 'bearer', token: values.accessToken ?? '' },
        }
      : unsupported(config.signIn);
  }
  if (config.kind !== 'azure') return undefined;
  const hosts = {
    protocol: 'https' as const,
    dfsHost: `${config.account}.dfs.core.windows.net`,
    blobHost: `${config.account}.blob.core.windows.net`,
  };
  switch (config.signIn) {
    case 'entra':
      return { ...hosts, auth: { kind: 'bearer', token: values.accessToken ?? '' } };
    case 'accountKey':
      return { ...hosts, auth: { kind: 'sharedKey', account: config.account, key: values.accountKey ?? '' } };
    case 'sas':
      return { ...hosts, auth: { kind: 'sas', query: (values.sasToken ?? '').replace(/^\?/, '') } };
    case 'connectionString':
      return fromConnectionString(values.connectionString ?? '', config.account);
    case 'servicePrincipal':
    case 'chain':
      return values.accessToken === undefined
        ? unsupported(config.signIn)
        : { ...hosts, auth: { kind: 'bearer', token: values.accessToken } };
  }
}

/**
 * The headers of a GET of `url`, signed for its sign-in: a bearer token, or Shared Key (the canonical headers and
 * resource of the storage services); a SAS travels in the query and adds nothing here.
 */
export function azureHeaders(url: URL, auth: AzureAuth, now: Date): Record<string, string> {
  const base = { 'x-ms-date': now.toUTCString(), 'x-ms-version': AZURE_API_VERSION };
  switch (auth.kind) {
    case 'bearer':
      return { ...base, authorization: `Bearer ${auth.token}` };
    case 'sas':
      return base;
    case 'sharedKey':
      return { ...base, authorization: `SharedKey ${auth.account}:${sharedKeySignature(url, auth, base)}` };
  }
}

function sharedKeySignature(
  url: URL,
  auth: Extract<AzureAuth, { kind: 'sharedKey' }>,
  headers: Readonly<Record<string, string>>,
): string {
  const canonicalHeaders = Object.keys(headers)
    .toSorted()
    .map((name) => `${name}:${headers[name] ?? ''}\n`)
    .join('');
  const params = new Map<string, string[]>();
  for (const [name, value] of url.searchParams) {
    const key = name.toLowerCase();
    params.set(key, [...(params.get(key) ?? []), value]);
  }
  const resource = [
    `/${auth.account}${url.pathname}`,
    ...[...params.keys()]
      .toSorted()
      .map((name) => `${name}:${(params.get(name) ?? []).toSorted().join(',')}`),
  ].join('\n');
  // The verb, then eleven standard headers that a listing does not send.
  const toSign = `GET\n${'\n'.repeat(11)}${canonicalHeaders}${resource}`;
  return createHmac('sha256', Buffer.from(auth.key, 'base64')).update(toSign, 'utf8').digest('base64');
}
