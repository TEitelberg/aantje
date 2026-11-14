import { AantjeError } from '../errors';

/** One request to this service, when a lake is created and when Allow My IP runs; the answer is the only address that the firewall rule admits. */
const PUBLIC_IP_URL = 'https://api.ipify.org';

const TIMEOUT_MS = 10_000;

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function isIpv4(value: string): boolean {
  return IPV4.test(value);
}

/** The public IPv4 address this machine reaches the internet with. */
export async function discoverPublicIp(fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const response = await fetchImpl(PUBLIC_IP_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = (await response.text()).trim();
    if (response.ok && isIpv4(text)) {
      return text;
    }
  } catch {
    // Reported below: the reason does not help the user.
  }
  throw new AantjeError('CONNECTION_FAILED', 'aantje could not find out your public IPv4 address.');
}
