import { AantjeError } from '../errors';
import { isObject } from '../guards';
import { deniesPermission } from './arm-errors';
import { API, ArmRequestError } from './arm-transport';
import type { ArmTransport } from './arm-transport';
import { isIpv4 } from './public-ip';
import { withBackoff } from './retry';

/** The one firewall rule that the template creates and that Allow my IP replaces; other rules are never touched. */
export const FIREWALL_RULE = 'client-ip';

/** The permission that changing the rule takes; Azure decides whether the account has it. */
const WRITE_RULE = 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules/write';

const FIREWALL_POLL_MS = 5_000;
const FIREWALL_POLLS = 24;

/** The firewall rule `FIREWALL_RULE` of a PostgreSQL flexible server. */
export class ArmFirewall {
  constructor(private readonly arm: ArmTransport) {}

  /**
   * Makes the rule `FIREWALL_RULE` of the server admit exactly this address, and waits until the server shows it.
   * Only a single IPv4 address is accepted, never `0.0.0.0` (which means every Azure service) or a range.
   */
  async allowIp(serverId: string, ip: string): Promise<'created' | 'updated' | 'unchanged'> {
    if (!isIpv4(ip) || ip === '0.0.0.0') {
      throw new AantjeError('INVALID_PROFILE', `"${ip}" is not a single public IPv4 address.`);
    }
    try {
      return await this.replaceRule(`${serverId}/firewallRules/${FIREWALL_RULE}`, ip);
    } catch (error) {
      // Azure decides who may change the rule; its refusal of the read or of the write says what is missing.
      if (error instanceof ArmRequestError && (error.status === 403 || deniesPermission(error.armError))) {
        throw new AantjeError(
          'AUTH_FAILED',
          `Your account may not change the firewall rules of the PostgreSQL server ${serverId.slice(serverId.lastIndexOf('/') + 1)}. Ask the owner of the server for a role that allows ${WRITE_RULE}, for example Contributor.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async replaceRule(path: string, ip: string): Promise<'created' | 'updated' | 'unchanged'> {
    const current = await this.firewallRule(path);
    if (current?.start === ip && current.end === ip) {
      return 'unchanged';
    }
    // The server runs one operation at a time and answers 409 while another one is going on.
    await withBackoff(
      () =>
        this.arm.request('PUT', path, {
          version: API.postgres,
          body: { properties: { startIpAddress: ip, endIpAddress: ip } },
        }),
      {
        isRetryable: (error) => error instanceof ArmRequestError && error.status === 409,
        sleep: this.arm.sleep,
        attempts: 6,
      },
    );
    // A fixed number of reads, not `pollUntil`: a failed read ends the wait at once.
    for (let tries = 0; tries < FIREWALL_POLLS; tries++) {
      const rule = await this.firewallRule(path);
      if (rule?.start === ip && rule.end === ip) {
        return current === undefined ? 'created' : 'updated';
      }
      await this.arm.sleep(FIREWALL_POLL_MS);
    }
    throw new AantjeError(
      'TIMEOUT',
      'Azure accepted the firewall rule but has not applied it yet. Wait a minute, then try to connect again.',
    );
  }

  private async firewallRule(path: string): Promise<{ start: unknown; end: unknown } | undefined> {
    try {
      const body = await this.arm.request('GET', path, { version: API.postgres });
      const properties = isObject(body) && isObject(body.properties) ? body.properties : {};
      return { start: properties.startIpAddress, end: properties.endIpAddress };
    } catch (error) {
      if (error instanceof ArmRequestError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }
}
