import type { SecretsPort } from '../connections/ports';
import type { AzureAuthMode } from '../connections/profile';
import { isObject } from '../guards';
import type { KeyValueStore } from './registry';

/** A deployment that Create Azure DuckLake started and has not turned into a connection yet. */
export interface PendingLake {
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly createdResourceGroup: boolean;
  readonly deployment: string;
  readonly namePrefix: string;
  /** The names aantje expects; the outputs of the finished deployment have the last word. */
  readonly serverName: string;
  readonly storageAccountName: string;
  readonly authentication: AzureAuthMode;
  readonly tenantId: string;
}

/**
 * What to tell the user when aantje starts and deployments are still pending: Azure goes on without the editor, so the
 * lake may be ready, still running or failed; only Finish finds out. Undefined when nothing is pending.
 */
export function pendingNotice(lakes: readonly PendingLake[]): string | undefined {
  if (lakes.length === 0) {
    return undefined;
  }
  const names = lakes.map(
    ({ namePrefix, resourceGroup }) => `"${namePrefix}" (resource group ${resourceGroup})`,
  );
  return `The creation of ${lakes.length === 1 ? 'an Azure DuckLake was' : 'Azure DuckLakes were'} interrupted: ${names.join(', ')}. Azure goes on without the editor. Finish it to add the connection. If the deployment failed, the resources it created stay in the resource group and cost money until you delete them in the Azure portal.`;
}

const KEY = 'aantje.pendingAzureLakes';
const passwordKey = (deployment: string): string => `aantje.pendingAzureLake.${deployment}`;

/**
 * What only aantje knows of a deployment it started, kept from before the start until the lake is a connection: the
 * names in the global state, the generated password in the secret storage. If waiting breaks off, Finish Creating Azure
 * DuckLake reads them back. Entries are keyed by the deployment name, which the subscription, group and name fix.
 */
export class PendingLakes {
  constructor(
    private readonly state: KeyValueStore,
    private readonly secrets: SecretsPort,
    /** Called with every password read or written, so the log redactor knows it. */
    private readonly registerSecret: (value: string) => void = () => undefined,
  ) {}

  list(): PendingLake[] {
    return Object.values(this.all()).filter(isPendingLake);
  }

  /** The password first, so that a record never names a password that was not kept. */
  async add(lake: PendingLake, password: string | undefined): Promise<void> {
    if (password) {
      this.registerSecret(password);
      await this.secrets.set(passwordKey(lake.deployment), password);
    } else {
      await this.secrets.delete(passwordKey(lake.deployment));
    }
    await this.state.update(KEY, { ...this.all(), [lake.deployment]: lake });
  }

  async password(lake: PendingLake): Promise<string | undefined> {
    const password = await this.secrets.get(passwordKey(lake.deployment));
    if (password) {
      this.registerSecret(password);
    }
    return password;
  }

  async remove(deployment: string): Promise<void> {
    const { [deployment]: _removed, ...rest } = this.all();
    await this.state.update(KEY, rest);
    await this.secrets.delete(passwordKey(deployment));
  }

  private all(): Record<string, unknown> {
    const value = this.state.get(KEY);
    return isObject(value) ? value : {};
  }
}

function isPendingLake(value: unknown): value is PendingLake {
  return (
    isObject(value) &&
    [
      'subscriptionId',
      'resourceGroup',
      'deployment',
      'namePrefix',
      'serverName',
      'storageAccountName',
      'tenantId',
    ].every((key) => typeof value[key] === 'string') &&
    typeof value.createdResourceGroup === 'boolean' &&
    (value.authentication === 'password' || value.authentication === 'entra')
  );
}
