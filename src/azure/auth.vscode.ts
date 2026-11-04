import * as vscode from 'vscode';
import type { AzureAccess } from '../data/types';
import { AantjeError } from '../errors';
import { ARM_SCOPE, POSTGRES_SCOPE, STORAGE_SCOPE } from './arm';

/** Tokens of the Microsoft account that VS Code is signed in with; the editor keeps and renews them, aantje stores none. */
export interface AzureAuth {
  /** Signs in (the editor asks only when there is no session) and uses the tenant for the Resource Manager calls after it. */
  signIn(tenantId?: string): Promise<void>;
  armToken(): Promise<string>;
  /** The password of an Entra login on the PostgreSQL server; it lives about an hour. `silent` never asks the user. */
  postgresToken(tenantId: string | undefined, silent?: boolean): Promise<string>;
  /** Storage access for a lake; the token is fetched now, `refresh` gets another one without asking the user. */
  storageAccess(accountName: string, tenantId: string | undefined, silent?: boolean): Promise<AzureAccess>;
}

export function createAzureAuth(registerSecret: (value: string) => void): AzureAuth {
  let tenant: string | undefined;

  async function token(scope: string, tenantId: string | undefined, silent: boolean): Promise<string> {
    // The scope `VSCODE_TENANT:<id>` picks the tenant of a sign-in with several directories.
    const scopes = tenantId === undefined ? [scope] : [scope, `VSCODE_TENANT:${tenantId}`];
    const session = await vscode.authentication.getSession(
      'microsoft',
      scopes,
      silent ? { silent: true } : { createIfNone: true },
    );
    if (!session) {
      throw new AantjeError('AUTH_FAILED', 'Sign in with your Microsoft account to use this Azure DuckLake.');
    }
    registerSecret(session.accessToken);
    return session.accessToken;
  }

  return {
    signIn: async (tenantId) => {
      tenant = tenantId;
      await token(ARM_SCOPE, tenant, false);
    },
    armToken: () => token(ARM_SCOPE, tenant, false),
    postgresToken: (tenantId, silent = false) => token(POSTGRES_SCOPE, tenantId, silent),
    storageAccess: async (accountName, tenantId, silent = false) => ({
      accountName,
      accessToken: await token(STORAGE_SCOPE, tenantId, silent),
      refresh: () => token(STORAGE_SCOPE, tenantId, true),
    }),
  };
}
