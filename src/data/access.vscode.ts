import * as vscode from 'vscode';
import type { ConnectionStore } from '../connections/store';
import type { Logger } from '../log';
import type { S3CredentialStore } from './credentials';
import type { DataAccessFactory } from './resolve';
import type { AzureAccess } from './types';
import { parseDataSettings } from './settings';
import type { DataSettings } from './settings';

export function readDataSettings(): DataSettings {
  const config = vscode.workspace.getConfiguration('aantje');
  return parseDataSettings((key) => config.get<unknown>(key));
}

export function createDataAccessFactory(
  store: ConnectionStore,
  credentials: S3CredentialStore,
  timeoutMs: () => number,
  log: Logger,
  azureAccess: (accountName: string, tenantId: string | undefined) => Promise<AzureAccess>,
  postgresToken: (tenantId: string | undefined, silent?: boolean) => Promise<string>,
): DataAccessFactory {
  return async (profile, snapshot) => {
    const { s3, extensionDirectory } = readDataSettings();
    const entra = profile.kind === 'postgres' && profile.azureAuth === 'entra';
    const tenant = profile.kind === 'postgres' ? profile.azureTenant : undefined;
    return {
      profile,
      password: entra ? await postgresToken(tenant) : await store.password(profile),
      renewPassword: entra ? () => postgresToken(tenant, true) : undefined,
      snapshot,
      s3,
      s3Credentials: await credentials.get(),
      azure:
        profile.kind === 'postgres' && profile.azureAccount !== undefined
          ? await azureAccess(profile.azureAccount, profile.azureTenant)
          : undefined,
      extensionDirectory,
      timeoutMs: timeoutMs(),
      log,
    };
  };
}
