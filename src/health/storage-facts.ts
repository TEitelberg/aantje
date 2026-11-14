import type { ResolvedStorage } from '../storage/config';
import { storageExpiry } from '../storage/expiry';
import { s3CredentialsOf } from '../storage/resolve';
import type { SignInSource, StorageFacts } from './connection-checks';

/** The storage of a connection as the checks see it: kinds and names, never a secret value. */
export function storageFactsOf(storage: ResolvedStorage | undefined): StorageFacts | undefined {
  if (storage === undefined) {
    return undefined;
  }
  const { config, legacy } = storage;
  return {
    kind: config.kind,
    signIn: config.signIn,
    ...(config.kind === 's3' && config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    ...(config.kind === 's3' && config.accountId !== undefined ? { accountId: config.accountId } : {}),
    ...(config.kind === 'azure' ? { account: config.account } : {}),
    ...(config.kind === 'azure' || config.kind === 'onelake'
      ? config.tenant === undefined
        ? {}
        : { tenant: config.tenant }
      : {}),
    ...(legacy === undefined ? {} : { legacy }),
  };
}

/**
 * Where the sign-in of the storage comes from, or undefined when it has none:
 * - `connection`: the values stored for this connection (keys, token, SAS, secret) or its Microsoft sign-in;
 * - `environment`: the credential chain, which reads the environment, a profile or the Azure CLI;
 * - `stored` / `environment` for a connection that uses the machine's S3 settings: as `credentialsFrom` says.
 */
export function signInSourceOf(
  storage: ResolvedStorage | undefined,
  credentialsFrom: 'stored' | 'environment' | undefined,
): SignInSource | undefined {
  if (storage === undefined) {
    return undefined;
  }
  if (storage.legacy === 'settings') {
    return s3CredentialsOf(storage) ? (credentialsFrom ?? 'stored') : undefined;
  }
  const { config, values } = storage;
  const has = (...names: (keyof ResolvedStorage['values'])[]): boolean =>
    names.every((name) => (values[name] ?? '') !== '');
  const ok = (found: boolean): SignInSource | undefined => (found ? 'connection' : undefined);
  switch (config.kind) {
    case 'aws':
      return config.signIn === 'chain' ? 'environment' : ok(has('keyId', 'secretKey'));
    case 's3':
      return ok(has('keyId', 'secretKey'));
    case 'azure':
    case 'onelake':
      switch (config.signIn) {
        case 'entra':
          return ok(has('accessToken'));
        case 'connectionString':
          return ok(has('connectionString'));
        case 'accountKey':
          return ok(has('accountKey'));
        case 'sas':
          return ok(has('sasToken'));
        case 'servicePrincipal':
          return ok(config.certificatePath !== undefined || has('clientSecret'));
        case 'chain':
          return 'environment';
      }
  }
}

/** When the SAS of the storage runs out, if it has one. */
export const signInExpiryOf = storageExpiry;
