import * as vscode from 'vscode';
import { signsInWithEntra } from '../connections/profile';
import type { ConnectionProfile } from '../connections/profile';
import type { ConnectionStore } from '../connections/store';
import type { Logger } from '../log';
import type { StorageValues } from '../storage/config';
import { resolveStorage } from '../storage/resolve';
import type { StorageTokenSource } from '../storage/resolve';
import type { StorageSecretStore } from '../storage/secrets';
import type { S3CredentialStore } from './credentials';
import type { DataAccessFactory } from './resolve';
import type { DataAccess } from './types';
import { parseDataSettings } from './settings';
import type { DataSettings } from './settings';

export function readDataSettings(): DataSettings {
  const config = vscode.workspace.getConfiguration('aantje');
  return parseDataSettings((key) => config.get<unknown>(key));
}

/** The Microsoft sign-in, as far as the data engine needs it. */
export interface DataSignIn extends StorageTokenSource {
  postgresToken(tenantId: string | undefined, silent?: boolean): Promise<string>;
}

/**
 * Assembles the `DataAccess` of a connection. A `silent` factory never shows a sign-in, for reads that the user did not
 * ask for, such as the view columns that completion reads while the user types.
 */
export function createDataAccessFactory(
  store: ConnectionStore,
  credentials: S3CredentialStore,
  storageSecrets: Pick<StorageSecretStore, 'get'>,
  timeoutMs: () => number,
  log: Logger,
  signIn: DataSignIn,
  { silent = false }: { readonly silent?: boolean } = {},
): DataAccessFactory {
  return async (profile, snapshot) => {
    const { s3, extensionDirectory } = readDataSettings();
    const entra = signsInWithEntra(profile) ? profile : undefined;
    return {
      profile,
      password: entra ? await signIn.postgresToken(entra.azureTenant, silent) : await store.password(profile),
      renewPassword: entra ? () => signIn.postgresToken(entra.azureTenant, true) : undefined,
      snapshot,
      storage: await resolveStorage(profile, {
        settings: s3,
        credentials,
        stored: storageSecrets,
        signIn,
        silent,
      }),
      extensionDirectory,
      timeoutMs: timeoutMs(),
      log,
    };
  };
}

/**
 * The access for testing a connection in the wizard: the password and the sign-in values of the storage that the user
 * typed are not stored yet, so they replace the stored ones. Without typed values the stored ones apply.
 */
export async function testAccess(
  factory: (storageValues: StorageValues | undefined) => DataAccessFactory,
  profile: ConnectionProfile,
  password: string | undefined,
  storageValues: StorageValues | undefined,
): Promise<DataAccess> {
  const access = await factory(storageValues)(profile, undefined);
  return signsInWithEntra(profile) ? access : { ...access, password };
}
