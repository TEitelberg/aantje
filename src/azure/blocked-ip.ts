import { isAwsLake, isAzureLake } from '../connections/profile';
import type { ConnectionProfile } from '../connections/profile';

// The server answers a blocked address with "no pg_hba.conf entry for host ..."; a firewall or security group that drops
// the packets ends in a timeout instead.
const BLOCKED = /pg_hba\.conf|no response within/i;

/** Whether a failed connect to an Azure lake looks like the firewall of the server refusing this machine's IP address. */
export function looksLikeBlockedIp(profile: ConnectionProfile, message: string): boolean {
  return isAzureLake(profile) && BLOCKED.test(message);
}

/**
 * The command that lets this machine's IP address reach the catalog, when a failed connect looks like a blocked address:
 * Allow My IP of an Azure lake or of an AWS lake; undefined for any other connection or failure.
 */
export function allowIpCommandFor(profile: ConnectionProfile, message: string): string | undefined {
  if (!BLOCKED.test(message)) return undefined;
  if (isAzureLake(profile)) return 'aantje.allowMyIp';
  if (isAwsLake(profile)) return 'aantje.allowMyIpAws';
  return undefined;
}
