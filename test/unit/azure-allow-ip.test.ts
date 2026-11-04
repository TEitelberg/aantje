import { describe, expect, it, vi } from 'vitest';
import template from '../../deploy/azure/azuredeploy.json';
import { allowMyIpFlow } from '../../src/azure/allow-ip';
import type { AllowIpDeps } from '../../src/azure/allow-ip';
import { ArmClient, FIREWALL_RULE } from '../../src/azure/arm';
import { looksLikeBlockedIp } from '../../src/azure/blocked-ip';
import type { WizardUi } from '../../src/connections/ports';
import type { PostgresProfile } from '../../src/connections/profile';
import { silentLogger } from '../../src/log';
import { fakeAzure, Reply } from './azure-support';

const SERVER = '/subscriptions/s/resourceGroups/rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/srv';
const RULE = `${SERVER}/firewallRules/client-ip`;

type Call = { method: string; url: string; body?: unknown };
const client = (routes: Parameters<typeof fakeAzure>[0], calls: Call[] = []) =>
  new ArmClient({
    fetch: fakeAzure(routes, calls),
    token: () => Promise.resolve('t'),
    sleep: () => Promise.resolve(),
  });

describe('the firewall rule', () => {
  it('is the one the template creates', () => {
    const names = Object.values(
      template.resources as unknown as Record<string, { type: string; name: string }>,
    )
      .filter(({ type }) => type.endsWith('/firewallRules'))
      .map(({ name }) => name);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain(`'${FIREWALL_RULE}'`);
  });
});

describe('allowIp', () => {
  const rule = (ip: string) => ({ properties: { startIpAddress: ip, endIpAddress: ip } });

  it('creates the rule, writes only that rule and waits until the server shows it', async () => {
    const calls: Call[] = [];
    let reads = 0;
    const arm = client(
      {
        [`PUT ${RULE}`]: {},
        [`GET ${RULE}`]: () =>
          ++reads === 1 ? new Reply(404, { error: { code: 'NotFound' } }) : rule('203.0.113.7'),
      },
      calls,
    );
    expect(await arm.allowIp(SERVER, '203.0.113.7')).toBe('created');
    const puts = calls.filter(({ method }) => method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toContain(RULE);
    expect(puts[0]?.body).toEqual({
      properties: { startIpAddress: '203.0.113.7', endIpAddress: '203.0.113.7' },
    });
  });

  it('replaces an old address, and writes nothing when the rule is right already', async () => {
    let current = '198.51.100.1';
    const calls: Call[] = [];
    const arm = client(
      {
        [`PUT ${RULE}`]: () => {
          current = '203.0.113.7';
          return {};
        },
        [`GET ${RULE}`]: () => rule(current),
      },
      calls,
    );
    expect(await arm.allowIp(SERVER, '203.0.113.7')).toBe('updated');
    calls.length = 0;
    expect(await arm.allowIp(SERVER, '203.0.113.7')).toBe('unchanged');
    expect(calls.some(({ method }) => method === 'PUT')).toBe(false);
  });

  it.each(['0.0.0.0', '10.0.0.0/8', 'my.host', ''])('refuses %s before any request', async (ip) => {
    const calls: Call[] = [];
    await expect(client({}, calls).allowIp(SERVER, ip)).rejects.toThrow(/single public IPv4/);
    expect(calls).toHaveLength(0);
  });

  it('retries while the server is busy, and explains a missing permission', async () => {
    let puts = 0;
    const busy = client({
      [`PUT ${RULE}`]: () => (++puts < 3 ? new Reply(409, { error: { code: 'ServerIsBusy' } }) : {}),
      [`GET ${RULE}`]: () => (puts < 3 ? new Reply(404, {}) : rule('203.0.113.7')),
    });
    expect(await busy.allowIp(SERVER, '203.0.113.7')).toBe('created');
    const denied = client({
      [`PUT ${RULE}`]: new Reply(403, { error: { code: 'AuthorizationFailed', message: 'no' } }),
      [`GET ${RULE}`]: new Reply(404, {}),
    });
    await expect(denied.allowIp(SERVER, '203.0.113.7')).rejects.toThrow(/may not change the firewall rules/);
  });
});

describe('findPostgresServer', () => {
  it('matches the host name, ignoring case, across subscriptions, and skips one it cannot read', async () => {
    const arm = client({
      'GET /subscriptions/a/providers': new Reply(403, { error: { code: 'AuthorizationFailed' } }),
      'GET /subscriptions/b/providers': {
        value: [
          { id: '/x/other', properties: { fullyQualifiedDomainName: 'other.postgres.database.azure.com' } },
          { id: SERVER, properties: { fullyQualifiedDomainName: 'srv.postgres.database.azure.com' } },
        ],
      },
    });
    expect(await arm.findPostgresServer('SRV.postgres.database.azure.com', ['a', 'b'])).toBe(SERVER);
    expect(await arm.findPostgresServer('none.postgres.database.azure.com', ['b'])).toBeUndefined();
  });
});

describe('allowMyIpFlow', () => {
  const profile: PostgresProfile = {
    id: 'lake',
    name: 'lake',
    kind: 'postgres',
    host: 'srv.postgres.database.azure.com',
    port: 5432,
    database: 'd',
    user: 'u',
    azureAccount: 'acct',
    azureTenant: 'tenant',
  };

  function setup(overrides: Partial<AllowIpDeps['arm']> = {}, created = false, confirm = true) {
    const messages: string[] = [];
    const ui: WizardUi = {
      pick: () => Promise.resolve(undefined as never),
      input: () => Promise.resolve(undefined),
      confirm: () => Promise.resolve(confirm),
      info: (message) => void messages.push(message),
      error: (message) => void messages.push(message),
      withProgress: (_title, task) => task(() => undefined),
    };
    const arm = {
      listSubscriptions: vi.fn(() =>
        Promise.resolve([
          { id: 'mine', name: 'Mine', tenantId: 'tenant' },
          { id: 'foreign', name: 'Foreign', tenantId: 'other' },
        ]),
      ),
      findPostgresServer: vi.fn((): Promise<string | undefined> => Promise.resolve(SERVER)),
      canDo: vi.fn(() => Promise.resolve(true)),
      allowIp: vi.fn((): Promise<'created' | 'updated' | 'unchanged'> => Promise.resolve('updated')),
      ...overrides,
    };
    const signIn = vi.fn(() => Promise.resolve());
    const deps: AllowIpDeps = {
      arm,
      signIn,
      publicIp: () => Promise.resolve('203.0.113.7'),
      log: silentLogger,
      registry: {
        get: () =>
          created
            ? {
                subscriptionId: 's',
                resourceGroup: 'rg',
                createdResourceGroup: false,
                serverName: 'srv',
                storageAccountName: 'acct',
              }
            : undefined,
      },
    };
    return { ui, deps, arm, messages, signIn };
  }

  it('uses the registry for a lake aantje created, without searching', async () => {
    const { ui, deps, arm, signIn } = setup({}, true);
    expect(await allowMyIpFlow(ui, profile, deps)).toBe(true);
    expect(signIn).toHaveBeenCalledWith('tenant');
    expect(arm.findPostgresServer).not.toHaveBeenCalled();
    expect(arm.allowIp).toHaveBeenCalledWith(SERVER, '203.0.113.7');
  });

  it('finds the server of an imported lake by host name, in the subscriptions of its tenant only', async () => {
    const { ui, deps, arm } = setup();
    await allowMyIpFlow(ui, profile, deps);
    expect(arm.findPostgresServer).toHaveBeenCalledWith(profile.host, ['mine']);
  });

  it('says what is missing when the server is not found or the account may not write the rule', async () => {
    const missing = setup({ findPostgresServer: () => Promise.resolve(undefined) });
    await expect(allowMyIpFlow(missing.ui, profile, missing.deps)).rejects.toThrow(
      /found no PostgreSQL server/,
    );
    const denied = setup({ canDo: () => Promise.resolve(false) });
    await expect(allowMyIpFlow(denied.ui, profile, denied.deps)).rejects.toThrow(
      /may not change the firewall rules/,
    );
    expect(denied.arm.allowIp).not.toHaveBeenCalled();
  });

  it('changes nothing when the user declines, and refuses a connection that is not an Azure lake', async () => {
    const declined = setup({}, true, false);
    expect(await allowMyIpFlow(declined.ui, profile, declined.deps)).toBe(false);
    expect(declined.arm.allowIp).not.toHaveBeenCalled();
    const plain = setup();
    expect(await allowMyIpFlow(plain.ui, { ...profile, azureAccount: undefined }, plain.deps)).toBe(false);
    expect(plain.messages.join()).toMatch(/not an Azure lake/);
  });
});

describe('looksLikeBlockedIp', () => {
  const azure = { kind: 'postgres', azureAccount: 'acct' } as PostgresProfile;
  const blocked =
    'Authentication failed on h:5432: no pg_hba.conf entry for host "203.0.113.7", user "u", database "d", SSL encryption.';

  it('recognises the refusal and the timeout of an Azure lake, and nothing else', () => {
    expect(looksLikeBlockedIp(azure, blocked)).toBe(true);
    expect(looksLikeBlockedIp(azure, 'Cannot connect to h:5432: no response within 10 s.')).toBe(true);
    expect(looksLikeBlockedIp(azure, 'password authentication failed for user "u"')).toBe(false);
    expect(looksLikeBlockedIp({ ...azure, azureAccount: undefined }, blocked)).toBe(false);
  });
});
