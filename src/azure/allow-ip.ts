import type { WizardUi } from '../connections/ports';
import type { PostgresProfile } from '../connections/profile';
import { AantjeError } from '../errors';
import type { Logger } from '../log';
import { FIREWALL_RULE } from './arm';
import type { ArmClient } from './arm';
import type { LakeRegistry } from './registry';

export interface AllowIpDeps {
  readonly arm: Pick<ArmClient, 'listSubscriptions' | 'findPostgresServer' | 'canDo' | 'allowIp'>;
  /** Signs in, asking only when there is no session, and uses the tenant for every call after it. */
  readonly signIn: (tenantId?: string) => Promise<void>;
  readonly publicIp: () => Promise<string>;
  readonly registry: Pick<LakeRegistry, 'get'>;
  readonly log: Pick<Logger, 'info'>;
}

const WRITE_RULE = 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules/write';

/**
 * Lets the current public IP reach the PostgreSQL server of an Azure lake: replaces the one firewall rule that aantje
 * created, after the user confirmed the address and the server. Returns whether the rule was changed.
 */
export async function allowMyIpFlow(
  ui: WizardUi,
  profile: PostgresProfile,
  deps: AllowIpDeps,
): Promise<boolean> {
  if (profile.azureAccount === undefined) {
    ui.error(`"${profile.name}" is not an Azure lake, so aantje has no firewall rule to change.`);
    return false;
  }
  const { arm } = deps;
  const ip = await ui.withProgress('Looking up your public IP address...', () => deps.publicIp());
  await deps.signIn(profile.azureTenant);
  const serverId = await ui.withProgress('Looking for the PostgreSQL server...', () =>
    serverIdOf(profile, deps),
  );
  const server = serverId.slice(serverId.lastIndexOf('/') + 1);
  if (!(await arm.canDo(serverId, WRITE_RULE))) {
    throw new AantjeError(
      'AUTH_FAILED',
      `Your account may not change the firewall rules of the PostgreSQL server ${server}. Ask the owner of the server for a role that allows ${WRITE_RULE}, for example Contributor.`,
    );
  }
  const confirmed = await ui.confirm(
    `Allow your public IP address ${ip} to reach the PostgreSQL server ${server} of "${profile.name}"? Only the rule "client-ip" is replaced; other rules stay as they are.`,
    'Allow',
  );
  if (!confirmed) {
    return false;
  }
  const change = await ui.withProgress('Updating the firewall rule...', () => arm.allowIp(serverId, ip));
  deps.log.info(
    `Allow My IP for "${profile.name}": the firewall rule "${FIREWALL_RULE}" of the server ${serverId} for ${ip} is ${change}.`,
  );
  ui.info(
    change === 'unchanged'
      ? `${ip} is already allowed on ${server}. If the connection still fails, the cause is another one.`
      : `${ip} may now reach ${server}. Connect again; the rule can take a minute to reach every gateway.`,
  );
  return change !== 'unchanged';
}

// A lake that aantje created knows its server; any other (imported) lake is found by its host name.
async function serverIdOf(profile: PostgresProfile, deps: AllowIpDeps): Promise<string> {
  const created = deps.registry.get(profile.id);
  if (created && profile.host.toLowerCase().startsWith(`${created.serverName.toLowerCase()}.`)) {
    return `/subscriptions/${created.subscriptionId}/resourceGroups/${created.resourceGroup}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${created.serverName}`;
  }
  const subscriptions = (await deps.arm.listSubscriptions())
    .filter(({ tenantId }) => profile.azureTenant === undefined || tenantId === profile.azureTenant)
    .map(({ id }) => id);
  const found = await deps.arm.findPostgresServer(profile.host, subscriptions);
  if (found === undefined) {
    throw new AantjeError(
      'INVALID_PROFILE',
      `aantje found no PostgreSQL server ${profile.host} in the subscriptions that your Microsoft account can read. Sign in with the account that owns the server, or change the rule in the Azure portal.`,
    );
  }
  return found;
}
