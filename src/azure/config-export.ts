import type { PostgresProfile } from '../connections/profile';

/** The container and the folder of the data files that `deploy/azure/main.bicep` creates; the profile does not keep them. */
const CONTAINER = 'lake';
const DATA_PREFIX = 'data';

/**
 * The text of `azure.config.json` of the Azure notebooks in the Docker stack (`docker/notebooks/azure`) for an Azure
 * lake, ready to paste over the file. No password: the notebooks ask for it, or with Entra sign-in to PostgreSQL (`pgAuth`) take a token. Undefined for a connection that is not an
 * Azure lake.
 */
export function azureNotebookConfig(profile: PostgresProfile): string | undefined {
  if (profile.azureAccount === undefined) {
    return undefined;
  }
  const config = {
    storageAccount: profile.azureAccount,
    container: CONTAINER,
    dataPrefix: DATA_PREFIX,
    bronzePrefix: 'bronze',
    lakeName: 'azure_lake',
    pgHost: profile.host,
    pgPort: profile.port,
    pgDatabase: profile.database,
    pgUser: profile.user,
    auth: 'device_code',
    pgAuth: profile.azureAuth === 'entra' ? 'entra' : 'password',
    tenantId: profile.azureTenant ?? '',
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}
