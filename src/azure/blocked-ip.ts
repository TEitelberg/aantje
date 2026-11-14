import { isAzureLake } from '../connections/profile';
import type { ConnectionProfile } from '../connections/profile';

// The server answers a blocked address with "no pg_hba.conf entry for host ..."; a firewall that drops the packets
// ends in a timeout instead.
const BLOCKED = /pg_hba\.conf|no response within/i;

/** Whether a failed connect to an Azure lake looks like the firewall of the server refusing this machine's IP address. */
export function looksLikeBlockedIp(profile: ConnectionProfile, message: string): boolean {
  return isAzureLake(profile) && BLOCKED.test(message);
}
