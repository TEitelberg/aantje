import { describe, expect, it } from 'vitest';
import { ArmClient, ArmUnreachableError, DeploymentFailedError } from '../../src/azure/arm';
import { fakeAzure, Reply } from './azure-support';

const client = (routes: Parameters<typeof fakeAzure>[0], calls: Parameters<typeof fakeAzure>[1] = []) =>
  new ArmClient({
    fetch: fakeAzure(routes, calls),
    token: () => Promise.resolve('token'),
    sleep: () => Promise.resolve(),
  });

describe('listing', () => {
  it('follows nextLink and keeps only enabled subscriptions', async () => {
    const calls: { method: string; url: string }[] = [];
    const arm = client(
      {
        'GET api-version=2022-12-01&page=2': {
          value: [{ subscriptionId: 's2', displayName: 'Two', state: 'Enabled' }],
        },
        'GET /subscriptions?': {
          value: [
            { subscriptionId: 's1', displayName: 'One', state: 'Enabled' },
            { subscriptionId: 's0', displayName: 'Off', state: 'Disabled' },
          ],
          nextLink: 'https://management.azure.com/subscriptions?api-version=2022-12-01&page=2',
        },
      },
      calls,
    );
    expect((await arm.listSubscriptions()).map(({ id }) => id)).toEqual(['s1', 's2']);
  });

  it('does not follow a nextLink to another host with the token, also not to one that only starts like Azure', async () => {
    for (const nextLink of [
      'https://evil.example/steal',
      'https://management.azure.com.evil.example/steal',
    ]) {
      const calls: { method: string; url: string }[] = [];
      const arm = client(
        {
          'GET /subscriptions?': {
            value: [{ subscriptionId: 's1', displayName: 'One' }],
            nextLink,
          },
        },
        calls,
      );
      await arm.listSubscriptions();
      expect(calls, nextLink).toHaveLength(1);
    }
  });

  it('lists only physical regions', async () => {
    const arm = client({
      'GET /locations?': {
        value: [
          { name: 'westeurope', displayName: 'West Europe', metadata: { regionType: 'Physical' } },
          { name: 'europe', displayName: 'Europe', metadata: { regionType: 'Logical' } },
        ],
      },
    });
    expect((await arm.listLocations('s')).map(({ name }) => name)).toEqual(['westeurope']);
  });

  it('leaves out a physical region the subscription cannot create a resource group in', async () => {
    const physical = { regionType: 'Physical' };
    const locations = {
      value: [
        { name: 'norwayeast', displayName: 'Norway East', metadata: physical },
        { name: 'norwaywest', displayName: 'Norway West', metadata: physical },
      ],
    };
    const arm = client({
      'GET /locations?': locations,
      'GET /providers/Microsoft.Resources?': {
        resourceTypes: [
          { resourceType: 'deployments', locations: ['Norway West'] },
          { resourceType: 'resourceGroups', locations: ['Norway East', 'West Europe'] },
        ],
      },
    });
    expect((await arm.listLocations('s')).map(({ name }) => name)).toEqual(['norwayeast']);
  });

  it('offers the physical regions when the provider cannot be read', async () => {
    const arm = client({
      'GET /locations?': {
        value: [{ name: 'norwaywest', displayName: 'Norway West', metadata: { regionType: 'Physical' } }],
      },
    });
    expect((await arm.listLocations('s')).map(({ name }) => name)).toEqual(['norwaywest']);
  });
});

describe('canAssignRoles', () => {
  it('follows the effective permissions of the user', async () => {
    const owner = client({ 'GET /permissions?': { value: [{ actions: ['*'], notActions: [] }] } });
    const contributor = client({
      'GET /permissions?': { value: [{ actions: ['*'], notActions: ['Microsoft.Authorization/*/Write'] }] },
    });
    expect(await owner.canAssignRoles('s', 'rg')).toBe(true);
    expect(await contributor.canAssignRoles('s', 'rg')).toBe(false);
  });

  it('asks at the subscription when the group is new', async () => {
    const calls: { method: string; url: string }[] = [];
    await client({ 'GET /permissions?': { value: [] } }, calls).canAssignRoles('sub');
    expect(calls[0]?.url).toContain('/subscriptions/sub/providers/Microsoft.Authorization/permissions');
  });
});

describe('name checks', () => {
  it('reports the reason Azure gives and nothing for a free name', async () => {
    const taken = client({
      'POST checkNameAvailability': { nameAvailable: false, message: 'Already in use.' },
    });
    const free = client({ 'POST checkNameAvailability': { nameAvailable: true } });
    expect(await taken.storageNameProblem('s', 'x')).toBe('Already in use.');
    expect(await free.storageNameProblem('s', 'x')).toBeUndefined();
  });
});

describe('sizeProblems', () => {
  const routes = {
    'GET /capabilities?': {
      value: [{ supportedServerEditions: [{ supportedServerSkus: [{ name: 'Standard_B1ms' }] }] }],
    },
    'GET /Microsoft.Storage/skus?': {
      value: [{ name: 'Standard_LRS', kind: 'StorageV2', locations: ['westeurope'], restrictions: [] }],
    },
  };

  it('marks the size whose SKU the region lacks', async () => {
    const problems = await client(routes).sizeProblems('s', 'WestEurope');
    expect(problems.small).toBeUndefined();
    expect(problems.medium).toBeDefined();
  });

  it('does not block a size when the lookup fails', async () => {
    const problems = await client({
      'GET /capabilities?': new Reply(500, {}),
      'GET /Microsoft.Storage/skus?': new Reply(403, {}),
    }).sizeProblems('s', 'westeurope');
    expect(problems).toEqual({});
  });
});

describe('postgresVersion', () => {
  const capabilities = (value: unknown[]) => ({ 'GET /capabilities?': { value } });

  it('picks the newest version that aantje deploys and the region offers', async () => {
    const arm = client(
      capabilities([{ supportedServerVersions: [{ name: '18' }, { name: '16' }, { name: '14' }] }]),
    );
    expect(await arm.postgresVersion('s', 'westeurope')).toBe('16');
  });

  it('reads versions listed under an edition too', async () => {
    const arm = client(
      capabilities([{ supportedServerEditions: [{ supportedServerVersions: [{ name: '17' }] }] }]),
    );
    expect(await arm.postgresVersion('s', 'westeurope')).toBe('17');
  });

  it('is null when the region reports nothing or no usable version', async () => {
    expect(await client(capabilities([])).postgresVersion('s', 'x')).toBeNull();
    expect(
      await client(capabilities([{ supportedServerVersions: [{ name: '11' }] }])).postgresVersion('s', 'x'),
    ).toBeNull();
  });

  it('says nothing when the lookup fails or names no versions', async () => {
    expect(
      await client({ 'GET /capabilities?': new Reply(500, {}) }).postgresVersion('s', 'x'),
    ).toBeUndefined();
    expect(
      await client(capabilities([{ supportedServerEditions: [] }])).postgresVersion('s', 'x'),
    ).toBeUndefined();
  });
});

describe('deployment', () => {
  const template = { resources: [] };

  it('sends the template and parameters, then returns the outputs by name', async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const states = ['Accepted', 'Running', 'Succeeded'];
    const arm = client(
      {
        'PUT /deployments/d?': { properties: {} },
        'GET /deployments/d?': () => ({
          properties: {
            provisioningState: states.shift(),
            outputs: { ducklake: { type: 'String', value: '{}' } },
          },
        }),
      },
      calls,
    );
    await arm.startDeployment('s', 'rg', 'd', { template, parameters: { size: 'small', pw: 'secret' } });
    expect(calls[0]?.body).toMatchObject({
      properties: {
        mode: 'Incremental',
        template,
        parameters: { size: { value: 'small' }, pw: { value: 'secret' } },
      },
    });
    expect(await arm.waitForDeployment('s', 'rg', 'd')).toEqual({ ducklake: '{}' });
  });

  it('reports the failed operation, not the generic deployment error', async () => {
    const arm = client({
      'GET /deployments/d/operations?': {
        value: [
          { properties: { provisioningState: 'Succeeded' } },
          {
            properties: {
              provisioningState: 'Failed',
              statusMessage: {
                error: {
                  code: 'SkuNotAvailable',
                  message: 'Standard_ZRS is not available in this location.',
                },
              },
            },
          },
        ],
      },
      'GET /deployments/d?': {
        properties: {
          provisioningState: 'Failed',
          error: { code: 'DeploymentFailed', message: 'At least one resource deployment operation failed.' },
        },
      },
    });
    await expect(arm.waitForDeployment('s', 'rg', 'd')).rejects.toThrow(/zone-redundant/);
  });

  it('explains an empty version list in plain words', async () => {
    const arm = client({
      'GET /deployments/d?': {
        properties: {
          provisioningState: 'Failed',
          error: {
            code: 'ParameterOutOfRange',
            message:
              "The value of the 'Version' should be in: []. Verify that the specified parameter value is correct.",
          },
        },
      },
    });
    await expect(arm.waitForDeployment('s', 'rg', 'd')).rejects.toThrow(/another region/);
  });

  it('survives a few server errors while polling, but not a refusal', async () => {
    let calls = 0;
    const flaky = client({
      'GET /deployments/d?': () =>
        ++calls < 3 ? new Reply(503, {}) : { properties: { provisioningState: 'Succeeded', outputs: {} } },
    });
    expect(await flaky.waitForDeployment('s', 'rg', 'd')).toEqual({});

    const refused = client({
      'GET /deployments/d?': new Reply(403, { error: { code: 'AuthorizationFailed', message: 'no' } }),
    });
    await expect(refused.waitForDeployment('s', 'rg', 'd')).rejects.toThrow(/not allowed/);
  });

  it('survives a short network outage and an expired token, waiting longer after each failure', async () => {
    const answers = [
      'offline',
      'offline',
      new Reply(401, { error: { code: 'ExpiredAuthenticationToken', message: 'expired' } }),
      { properties: { provisioningState: 'Succeeded', outputs: {} } },
    ];
    const azure = fakeAzure({ 'GET /deployments/d?': () => answers.shift() });
    const sleeps: number[] = [];
    const arm = new ArmClient({
      fetch: (url, init) =>
        answers[0] === 'offline'
          ? (answers.shift(), Promise.reject(new TypeError('fetch failed')))
          : azure(url, init),
      token: () => Promise.resolve('token'),
      sleep: (ms) => Promise.resolve(void sleeps.push(ms)),
    });
    expect(await arm.waitForDeployment('s', 'rg', 'd', { pollMs: 1_000 })).toEqual({});
    expect(sleeps).toEqual([2_000, 4_000, 8_000]);
  });

  it('gives up when Azure stays unreachable, and tells a failed deployment apart', async () => {
    const offline = new ArmClient({
      fetch: () => Promise.reject(new TypeError('fetch failed')),
      token: () => Promise.resolve('token'),
      sleep: () => Promise.resolve(),
    });
    await expect(offline.waitForDeployment('s', 'rg', 'd')).rejects.toBeInstanceOf(ArmUnreachableError);

    const failed = client({
      'GET /deployments/d/operations?': { value: [] },
      'GET /deployments/d?': { properties: { provisioningState: 'Canceled' } },
    });
    await expect(failed.waitForDeployment('s', 'rg', 'd')).rejects.toBeInstanceOf(DeploymentFailedError);
  });
});

describe('what the output shows', () => {
  it('reads the operations of a deployment while waiting, and its duration and correlation id at the end', async () => {
    const arm = client({
      'GET /deployments/d/operations?': {
        value: [
          {
            operationId: 'o1',
            properties: {
              provisioningState: 'Succeeded',
              duration: 'PT41.2S',
              targetResource: { resourceType: 'Microsoft.Storage/storageAccounts', resourceName: 'acct' },
            },
          },
          { operationId: 'o2', properties: { provisioningState: 'Succeeded' } },
        ],
      },
      'GET /deployments/d?': {
        properties: {
          provisioningState: 'Succeeded',
          duration: 'PT7M12S',
          correlationId: 'corr-1',
          outputs: {},
        },
      },
    });
    const seen: unknown[] = [];
    const states: unknown[] = [];
    await arm.waitForDeployment('s', 'rg', 'd', {
      onOperations: (operations) => seen.push(...operations),
      onState: (state, status) => states.push({ state, ...status }),
    });
    expect(seen).toEqual([
      expect.objectContaining({ id: 'o1', resourceName: 'acct', state: 'Succeeded', duration: 'PT41.2S' }),
    ]);
    expect(states).toEqual([{ state: 'Succeeded', duration: 'PT7M12S', correlationId: 'corr-1' }]);
  });

  it('follows an accepted delete by its Location or its status address, only on Azure Resource Manager', async () => {
    const calls: { method: string; url: string }[] = [];
    let polls = 0;
    const arm = client(
      {
        'DELETE /resourcegroups/rg?': new Reply(
          202,
          {},
          { Location: 'https://management.azure.com/operationresults/g' },
        ),
        'GET /operationresults/g': () => (++polls < 2 ? new Reply(202, {}) : new Reply(200, {})),
        'DELETE /flexibleServers/srv?': new Reply(
          202,
          {},
          { 'Azure-AsyncOperation': 'https://management.azure.com/async/s' },
        ),
        'GET /async/s': { status: 'Failed', error: { code: 'Conflict', message: 'The server is busy.' } },
        'DELETE /storageAccounts/acct?': new Reply(202, {}, { Location: 'https://evil.example/steal' }),
      },
      calls,
    );
    const group = await arm.deleteResourceGroup('s', 'rg');
    expect(await arm.operationDone(group)).toBe(false);
    expect(await arm.operationDone(group)).toBe(true);

    const server = await arm.deleteServer(
      '/subscriptions/s/resourceGroups/rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/srv',
    );
    await expect(arm.operationDone(server)).rejects.toThrow(/busy/);

    const storage = await arm.deleteStorageAccount(
      '/subscriptions/s/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/acct',
    );
    expect(storage.poll).toBeUndefined();
    expect(calls.some(({ url }) => url.includes('evil.example'))).toBe(false);
  });

  it('logs each request for the level Debug, without the token', async () => {
    const lines: string[] = [];
    const arm = new ArmClient({
      fetch: fakeAzure({ 'GET /subscriptions?': { value: [] } }),
      token: () => Promise.resolve('tok-secret-123'),
      sleep: () => Promise.resolve(),
      debug: (line) => void lines.push(line),
    });
    await arm.listSubscriptions();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('/subscriptions');
    expect(lines[0]).toContain('200');
    expect(lines.join()).not.toContain('tok-secret-123');
  });
});
