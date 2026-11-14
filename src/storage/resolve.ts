import type { ConnectionProfile } from '../connections/profile';
import { effectiveStorage } from '../connections/profile';
import type { S3Credentials, S3Settings } from '../data/types';
import type { AzureStorage, OneLakeStorage, ResolvedStorage, StorageConfig } from './config';

/** The Microsoft sign-in as far as storage needs it: a token for the storage service and how to renew it. */
export interface StorageTokenSource {
  storageAccess(
    accountName: string,
    tenantId: string | undefined,
    silent?: boolean,
  ): Promise<{ readonly accessToken: string; readonly refresh?: () => Promise<string> }>;
}

export interface ResolveDeps {
  /** The global `aantje.s3.*` settings, used by a connection that has no storage. */
  readonly settings: S3Settings;
  /** The global S3 credentials (secret storage, else the AWS environment variables). */
  readonly credentials: { get(): Promise<S3Credentials | undefined> };
  /** The stored sign-in values of a connection's own storage. */
  readonly stored: {
    get(connectionId: string, config: StorageConfig): Promise<ResolvedStorage['values'] | undefined>;
  };
  readonly signIn: StorageTokenSource;
  /** A silent resolution never shows a sign-in. */
  readonly silent?: boolean;
}

/**
 * The storage of a connection as the engine uses it, or undefined when the engine needs none.
 *
 * - With `storage`: its configuration and the values stored for this connection; an Entra sign-in fetches the token.
 * - With the legacy `azureAccount`: the same as `azure` with `entra`; the profile is never rewritten.
 * - Without either: the global `aantje.s3.*` settings and keys, exactly as before. Only an endpoint or keys make it a
 *   storage; a region or URL style alone do not.
 */
export async function resolveStorage(
  profile: ConnectionProfile,
  deps: ResolveDeps,
): Promise<ResolvedStorage | undefined> {
  const config = effectiveStorage(profile);
  if (config === undefined) {
    return legacyS3Storage(deps.settings, await deps.credentials.get());
  }
  const own = profile.kind !== 'quack' && profile.storage !== undefined;
  const legacy = own ? undefined : 'azureAccount';
  const values = own ? ((await deps.stored.get(profile.id, config)) ?? {}) : {};
  if ((config.kind === 'azure' || config.kind === 'onelake') && config.signIn === 'entra') {
    const access = await deps.signIn.storageAccess(accountOf(config), config.tenant, deps.silent);
    return {
      config,
      values: { ...values, accessToken: access.accessToken },
      ...(access.refresh === undefined ? {} : { refresh: access.refresh }),
      ...(legacy === undefined ? {} : { legacy }),
    };
  }
  return { config, values, ...(legacy === undefined ? {} : { legacy }) };
}

// OneLake has no storage account; its token is the one of the storage service all the same.
const accountOf = (config: AzureStorage | OneLakeStorage): string =>
  config.kind === 'azure' ? config.account : 'onelake';

/** The storage of a connection that uses the global S3 settings and keys; undefined without an endpoint and keys. */
export function legacyS3Storage(
  settings: S3Settings,
  credentials: S3Credentials | undefined,
): ResolvedStorage | undefined {
  const endpoint = settings.endpoint?.trim() ?? '';
  if (!credentials && endpoint === '') {
    return undefined;
  }
  return {
    config: {
      kind: 's3',
      signIn: 'keys',
      ...(endpoint === '' ? {} : { endpoint }),
      ...(settings.region ? { region: settings.region } : {}),
      ...(settings.urlStyle ? { urlStyle: settings.urlStyle } : {}),
    },
    values: credentials ? { keyId: credentials.keyId, secretKey: credentials.secretKey } : {},
    legacy: 'settings',
  };
}

/** The S3 settings a storage stands for, for code that still reasons about `aantje.s3.*` (the health check). */
export function s3SettingsOf(storage: ResolvedStorage | undefined): S3Settings {
  const config = storage?.config;
  if (config?.kind !== 's3') {
    return {};
  }
  return { endpoint: config.endpoint, region: config.region, urlStyle: config.urlStyle };
}

/** The S3 keys of a storage; undefined when it has none or is not an S3 storage. */
export function s3CredentialsOf(storage: ResolvedStorage | undefined): S3Credentials | undefined {
  const { keyId, secretKey } = storage?.values ?? {};
  return storage?.config.kind === 's3' && keyId && secretKey ? { keyId, secretKey } : undefined;
}
