import { describe, expect, it, vi } from 'vitest';
import template from '../../deploy/azure/azuredeploy.json';
import { ArmRequestError, ArmUnreachableError, DeploymentFailedError } from '../../src/azure/arm';
import { deployLake, waitForLake } from '../../src/azure/create-lake';
import type { LakeDeps, LakeRequest } from '../../src/azure/create-lake';
import { deleteLake, followDeletion, lakeResourceIds } from '../../src/azure/delete-lake';
import { LakeRegistry } from '../../src/azure/registry';
import { SIZES } from '../../src/azure/sizes';
import { AantjeError } from '../../src/errors';
import { silentLogger } from '../../src/log';
import { jwt, memoryLog, memoryPending, OID, TID } from './azure-support';

describe('the template', () => {
  const { parameters, variables, resources } = template as unknown as {
    parameters: Record<string, { type: string; allowedValues?: string[] }>;
    variables: { sizes: Record<string, { serverSku: string; storageSku: string }> };
    resources: Record<string, { type: string; properties: Record<string, unknown> }>;
  };

  it('offers the sizes of the wizard with the SKUs the wizard checks', () => {
    for (const [size, preset] of Object.entries(SIZES)) {
      expect(variables.sizes[size]).toMatchObject({
        serverSku: preset.serverSku,
        storageSku: preset.storageSku,
      });
    }
    expect(parameters.size?.allowedValues).toEqual(Object.keys(SIZES));
  });

  it('keeps the password secret and takes every parameter that the deployment sends', () => {
    expect(parameters.administratorLoginPassword?.type).toBe('securestring');
    for (const name of [
      'authentication',
      'principalName',
      'namePrefix',
      'size',
      'principalId',
      'principalType',
      'clientIp',
      'location',
      'uniqueSuffix',
    ]) {
      expect(parameters).toHaveProperty(name);
    }
  });

  it('registers the Entra administrator last, and only for the Entra mode', () => {
    expect(parameters.authentication?.allowedValues).toEqual(['password', 'entra']);
    const administrator = Object.values(
      template.resources as unknown as Record<
        string,
        { type: string; condition?: string; dependsOn?: string[] }
      >,
    ).find(({ type }) => type.endsWith('/administrators'));
    expect(administrator?.condition).toContain("'entra'");
    expect(administrator?.dependsOn?.join()).toContain('require_secure_transport');
    // The local login stays, so a broken Entra setup cannot lock everybody out.
    const server = Object.values(resources).find(({ type }) => type.endsWith('/flexibleServers'));
    expect(JSON.stringify(server?.properties)).toContain('"passwordAuth":"Enabled"');
  });

  it('admits one address, forbids shared keys and public blobs, and never outputs the password', () => {
    const all = Object.values(resources);
    const firewall = all.find((resource) => resource.type.endsWith('/firewallRules'));
    expect(firewall?.properties).toMatchObject({
      startIpAddress: "[parameters('clientIp')]",
      endIpAddress: "[parameters('clientIp')]",
    });
    const storage = all.find((resource) => resource.type === 'Microsoft.Storage/storageAccounts');
    expect(storage?.properties).toMatchObject({
      isHnsEnabled: true,
      allowSharedKeyAccess: false,
      allowBlobPublicAccess: false,
      minimumTlsVersion: 'TLS1_2',
    });
    expect(JSON.stringify(template.outputs)).not.toMatch(/administratorLoginPassword/);
  });
});

const LAKE_JSON = JSON.stringify({
  attach: "ATTACH 'x' AS lake (DATA_PATH 'abfss://lake@acct.dfs.core.windows.net/data/');",
  azureSecret: { provider: 'access_token', accountName: 'acct' },
  postgres: {
    host: 'h.postgres.database.azure.com',
    database: 'ducklake_catalog',
    user: 'ducklakeadmin',
    port: 5432,
  },
});

const request: LakeRequest = {
  subscriptionId: 'sub',
  resourceGroup: 'rg',
  newResourceGroup: false,
  location: 'westeurope',
  namePrefix: 'lake',
  size: 'small',
  authentication: 'password',
};

function deps(overrides: Partial<LakeDeps['arm']> = {}) {
  const arm = {
    canAssignRoles: vi.fn(() => Promise.resolve(true)),
    postgresVersion: vi.fn((): Promise<string | null | undefined> => Promise.resolve('16')),
    storageNameProblem: vi.fn(() => Promise.resolve(undefined)),
    serverNameProblem: vi.fn(() => Promise.resolve(undefined)),
    createResourceGroup: vi.fn(() => Promise.resolve()),
    deleteResourceGroup: vi.fn(() => Promise.resolve({ status: 202 })),
    startDeployment: vi.fn(() => Promise.resolve()),
    waitForDeployment: vi.fn(() =>
      Promise.resolve({ ducklake: LAKE_JSON, postgresServerName: 'srv', storageAccountName: 'acct' }),
    ),
    ...overrides,
  };
  const { pending } = memoryPending();
  const all: LakeDeps = {
    arm,
    token: () => Promise.resolve(jwt({ oid: OID, tid: TID })),
    publicIp: () => Promise.resolve('203.0.113.7'),
    password: () => 'generated-password',
    pending,
    report: () => undefined,
    log: silentLogger,
  };
  return { arm, all, pending };
}

const unreachable = (): Promise<never> =>
  Promise.reject(new ArmUnreachableError(new TypeError('fetch failed')));

describe('deployLake when the deployment is interrupted', () => {
  it('keeps the names and the password before the deployment starts', async () => {
    const { arm, all, pending } = deps();
    const kept: unknown[] = [];
    vi.mocked(arm.startDeployment).mockImplementation(async () => {
      const [lake] = pending.list();
      kept.push(lake, lake && (await pending.password(lake)));
    });
    const lake = await deployLake(request, all);
    expect(kept).toEqual([
      expect.objectContaining({
        deployment: lake.deployment,
        subscriptionId: 'sub',
        resourceGroup: 'rg',
        tenantId: TID,
        authentication: 'password',
      }),
      'generated-password',
    ]);
    // The wizard forgets the record once the connection is saved; deployLake keeps it.
    expect(pending.list()).toHaveLength(1);
  });

  it('keeps the record and names the deployment when waiting breaks off', async () => {
    const { all, pending } = deps({ waitForDeployment: vi.fn(unreachable) });
    const failure = await deployLake(request, all).catch((error: unknown) => error);
    const [lake] = pending.list();
    expect(failure).toMatchObject({ code: 'CONNECTION_FAILED' });
    expect(String(failure)).toContain(lake?.deployment);
    expect(lake && (await pending.password(lake))).toBe('generated-password');
  });

  it('keeps the record when the start got no answer, and forgets it when Azure refused the start', async () => {
    const silent = deps({ startDeployment: vi.fn(unreachable) });
    await expect(deployLake(request, silent.all)).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    expect(silent.pending.list()).toHaveLength(1);

    const refusal = new ArmRequestError(new AantjeError('CONNECTION_FAILED', 'InvalidTemplate'), 400);
    const refused = deps({ startDeployment: vi.fn(() => Promise.reject(refusal)) });
    await expect(deployLake(request, refused.all)).rejects.toBe(refusal);
    expect(refused.pending.list()).toEqual([]);
  });

  it('deletes the resource group that the run created when Azure refuses the start, and says so; an existing group stays', async () => {
    const refusal = new ArmRequestError(new AantjeError('QUERY_FAILED', 'InvalidTemplate'), 400);
    const created = deps({ startDeployment: vi.fn(() => Promise.reject(refusal)) });
    const failure = await deployLake({ ...request, newResourceGroup: true }, created.all).catch(
      (error: unknown) => error,
    );
    expect(created.arm.deleteResourceGroup).toHaveBeenCalledWith('sub', 'rg');
    expect(failure).toMatchObject({ code: 'QUERY_FAILED' });
    expect(String((failure as AantjeError).userMessage)).toContain('"rg"');

    // The delete itself is refused: the message tells that the group stays.
    const stuck = deps({
      startDeployment: vi.fn(() => Promise.reject(refusal)),
      deleteResourceGroup: vi.fn(() => Promise.reject(new Error('no right to delete'))),
    });
    const kept = await deployLake({ ...request, newResourceGroup: true }, stuck.all).catch(
      (error: unknown) => error,
    );
    expect(String((kept as AantjeError).userMessage)).not.toBe(String((failure as AantjeError).userMessage));

    const existing = deps({ startDeployment: vi.fn(() => Promise.reject(refusal)) });
    await expect(deployLake(request, existing.all)).rejects.toBe(refusal);
    expect(existing.arm.deleteResourceGroup).not.toHaveBeenCalled();
  });

  it('forgets the record when Azure ends the deployment as failed', async () => {
    const failed = new DeploymentFailedError('CONNECTION_FAILED', 'Azure said: Conflict');
    const { all, pending } = deps({ waitForDeployment: vi.fn(() => Promise.reject(failed)) });
    await expect(deployLake(request, all)).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    expect(pending.list()).toEqual([]);
  });

  it('keeps no password for Entra', async () => {
    const { all, pending } = deps({ waitForDeployment: vi.fn(unreachable) });
    const entra = {
      ...all,
      token: () => Promise.resolve(jwt({ oid: OID, tid: TID, upn: 'ada@contoso.com' })),
    };
    await expect(deployLake({ ...request, authentication: 'entra' }, entra)).rejects.toBeDefined();
    const [lake] = pending.list();
    expect(lake?.authentication).toBe('entra');
    expect(lake && (await pending.password(lake))).toBeUndefined();
  });
});

describe('deployLake', () => {
  it('deploys with the identity of the token and the current IP, and hands back the password separately', async () => {
    const { arm, all } = deps();
    const lake = await deployLake(request, all);
    const [, , , sent] = vi.mocked(arm.startDeployment).mock.calls[0] as unknown as [
      string,
      string,
      string,
      { parameters: Record<string, string> },
    ];
    expect(sent.parameters).toMatchObject({
      principalId: OID,
      clientIp: '203.0.113.7',
      size: 'small',
      administratorLoginPassword: 'generated-password',
    });
    expect(lake.password).toBe('generated-password');
    expect(JSON.stringify(lake.outputs)).not.toContain('generated-password');
    expect(lake.created).toMatchObject({
      serverName: 'srv',
      storageAccountName: 'acct',
      createdResourceGroup: false,
    });
    expect(lake.tenantId).toBe(TID);
  });

  it('passes the sign-in name for Entra and keeps no password', async () => {
    const { arm, all } = deps();
    const lake = await deployLake(
      { ...request, authentication: 'entra' },
      { ...all, token: () => Promise.resolve(jwt({ oid: OID, tid: TID, upn: 'ada@contoso.com' })) },
    );
    const sent = vi.mocked(arm.startDeployment).mock.calls[0]?.[3] as unknown as {
      parameters: Record<string, string>;
    };
    expect(sent.parameters).toMatchObject({ authentication: 'entra', principalName: 'ada@contoso.com' });
    expect(lake.password).toBeUndefined();
  });

  it('does not start an Entra lake for a sign-in without a user name', async () => {
    const { arm, all } = deps();
    await expect(deployLake({ ...request, authentication: 'entra' }, all)).rejects.toThrow(/user name/);
    expect(arm.startDeployment).not.toHaveBeenCalled();
  });

  it('does not start without the right to assign roles', async () => {
    const { arm, all } = deps({ canAssignRoles: vi.fn(() => Promise.resolve(false)) });
    await expect(deployLake(request, all)).rejects.toThrow(/role assignments/);
    expect(arm.startDeployment).not.toHaveBeenCalled();
    expect(arm.createResourceGroup).not.toHaveBeenCalled();
  });

  it('deploys the version the region offers', async () => {
    const { arm, all } = deps();
    await deployLake(request, all);
    const body = vi.mocked(arm.startDeployment).mock.calls[0]?.[3];
    expect(body?.parameters.postgresVersion).toBe('16');
  });

  it('creates nothing when the region offers no PostgreSQL version', async () => {
    const { arm, all } = deps({ postgresVersion: vi.fn(() => Promise.resolve(null)) });
    await expect(deployLake({ ...request, newResourceGroup: true }, all)).rejects.toThrow(/westeurope/);
    expect(arm.createResourceGroup).not.toHaveBeenCalled();
    expect(arm.startDeployment).not.toHaveBeenCalled();
  });

  it('keeps the template default when the lookup says nothing', async () => {
    const { arm, all } = deps({ postgresVersion: vi.fn(() => Promise.resolve(undefined)) });
    await deployLake(request, all);
    expect(vi.mocked(arm.startDeployment).mock.calls[0]?.[3].parameters).not.toHaveProperty(
      'postgresVersion',
    );
  });

  it('gives every run new names in the same resource group, also for the same answers', async () => {
    const { arm, all } = deps();
    const first = await deployLake(request, all);
    const second = await deployLake(request, all);
    const started = vi
      .mocked(arm.startDeployment)
      .mock.calls.map(
        (call) => call as unknown as [string, string, string, { parameters: Record<string, string> }],
      );
    expect(started.map(([, group]) => group)).toEqual(['rg', 'rg']);
    const suffixes = started.map(([, , , sent]) => sent.parameters.uniqueSuffix ?? '');
    for (const suffix of suffixes) expect(suffix).toMatch(/^[0-9a-f]{13}$/);
    expect(suffixes[0]).not.toBe(suffixes[1]);
    expect(started.map(([, , deployment]) => deployment)).toEqual(
      suffixes.map((suffix) => `aantje-lake-${suffix}`),
    );
    expect([first.deployment, second.deployment]).toEqual(started.map(([, , deployment]) => deployment));
    const checked = vi.mocked(arm.storageNameProblem).mock.calls.map(([, name]) => name);
    expect(checked).toEqual(suffixes.map((suffix) => `lake${suffix}`));
    expect(vi.mocked(arm.serverNameProblem).mock.calls.map(([, name]) => name)).toEqual(
      suffixes.map((suffix) => `lake-${suffix}-pg`),
    );
  });

  it('does not start when a name is taken', async () => {
    const { arm, all } = deps({ storageNameProblem: vi.fn(() => Promise.resolve('Name taken.')) });
    await expect(deployLake(request, all)).rejects.toThrow(/Name taken/);
    expect(arm.startDeployment).not.toHaveBeenCalled();
  });

  it('creates a new resource group first and checks the right at the subscription', async () => {
    const { arm, all } = deps();
    await deployLake({ ...request, newResourceGroup: true }, all);
    expect(arm.canAssignRoles).toHaveBeenCalledWith('sub', undefined);
    expect(vi.mocked(arm.createResourceGroup).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(arm.startDeployment).mock.invocationCallOrder[0] ?? 0,
    );
  });
});

describe('deleteLake', () => {
  const lake = {
    subscriptionId: 'sub',
    resourceGroup: 'rg',
    createdResourceGroup: true,
    serverName: 'srv',
    storageAccountName: 'acct',
  };
  const accepted = { status: 202 };
  const arm = (found: string[]) => ({
    listGroupResources: vi.fn(() => Promise.resolve(found.map((id) => ({ id, type: 't' })))),
    deleteResourceGroup: vi.fn(() => Promise.resolve(accepted)),
    deleteServer: vi.fn(() => Promise.resolve(accepted)),
    deleteStorageAccount: vi.fn(() => Promise.resolve(accepted)),
  });

  it('deletes the group it created when nothing else is in it', async () => {
    const ids = lakeResourceIds(lake);
    const client = arm([ids.server.toUpperCase(), ids.storage]);
    expect((await deleteLake(lake, client, silentLogger)).scope).toBe('resource group');
    expect(client.deleteServer).not.toHaveBeenCalled();
  });

  it('deletes only the two resources when something else lives in the group, and names it in the log', async () => {
    const client = arm([
      lakeResourceIds(lake).server,
      '/subscriptions/sub/resourceGroups/rg/providers/x/y/other',
    ]);
    const { log, lines } = memoryLog();
    const deleted = await deleteLake(lake, client, log);
    expect(deleted.scope).toBe('resources');
    expect(deleted.started).toHaveLength(2);
    expect(client.deleteResourceGroup).not.toHaveBeenCalled();
    expect(client.deleteServer).toHaveBeenCalledWith(lakeResourceIds(lake).server);
    expect(client.deleteStorageAccount).toHaveBeenCalledWith(lakeResourceIds(lake).storage);
    expect(lines.some((line) => line.includes('"other"'))).toBe(true);
  });

  it('never deletes a group it did not create', async () => {
    const client = arm([]);
    expect((await deleteLake({ ...lake, createdResourceGroup: false }, client, silentLogger)).scope).toBe(
      'resources',
    );
    expect(client.deleteResourceGroup).not.toHaveBeenCalled();
  });
});

describe('followDeletion', () => {
  const poll = (url: string) => ({ status: 202, poll: { url, kind: 'status' } }) as const;

  it('logs the end of each delete, and throws a failed one after the others have ended', async () => {
    const answers: Record<string, (boolean | Error)[]> = {
      server: [false, true],
      storage: [new AantjeError('CONNECTION_FAILED', 'Azure said: Conflict')],
    };
    const operationDone = vi.fn(({ poll: target }: { poll?: { url: string } }) => {
      const next = answers[target?.url ?? '']?.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next ?? true);
    });
    const { log, lines } = memoryLog();
    const started = [
      { what: 'the server', operation: poll('server') },
      { what: 'the storage account', operation: poll('storage') },
    ];
    await expect(
      followDeletion(started, { arm: { operationDone }, log, sleep: () => Promise.resolve() }),
    ).rejects.toThrow(/storage account/);
    expect(operationDone).toHaveBeenCalledTimes(3);
    expect(lines.filter((line) => line.startsWith('info') && line.includes('the server'))).toHaveLength(1);
  });
});

describe('waitForLake', () => {
  it('logs each change of the state and each resource once, when it has ended', async () => {
    const storage = {
      id: '1',
      resourceType: 'Microsoft.Storage/storageAccounts',
      resourceName: 'acct',
      state: 'Succeeded',
      duration: 'PT41S',
    };
    const waitForDeployment: LakeDeps['arm']['waitForDeployment'] = (_s, _g, _n, options = {}) => {
      options.onOperations?.([{ ...storage, state: 'Running' }]);
      options.onState?.('Running', {});
      options.onOperations?.([storage]);
      options.onState?.('Running', {});
      options.onOperations?.([storage]);
      options.onState?.('Succeeded', { duration: 'PT7M12S', correlationId: 'corr-1' });
      return Promise.resolve({});
    };
    const { pending } = memoryPending();
    const { log, lines } = memoryLog();
    const lake = {
      subscriptionId: 'sub',
      resourceGroup: 'rg',
      createdResourceGroup: true,
      deployment: 'aantje-lake-x',
      namePrefix: 'lake',
      serverName: 'lake-x-pg',
      storageAccountName: 'lakex',
      authentication: 'password',
      tenantId: TID,
    } as const;
    await waitForLake(lake, { arm: { waitForDeployment }, pending, report: () => undefined, log });
    expect(lines.filter((line) => line.includes('"acct"'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('41 s'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('Running'))).toHaveLength(1);
    expect(lines.some((line) => line.includes('7 min 12 s') && line.includes('corr-1'))).toBe(true);
  });
});

describe('LakeRegistry', () => {
  it('keeps what was created per connection and forgets it on remove', async () => {
    const data = new Map<string, unknown>();
    const registry = new LakeRegistry({
      get: (key) => data.get(key),
      update: (key, value) => Promise.resolve(void data.set(key, value)),
    });
    const lake = {
      subscriptionId: 's',
      resourceGroup: 'r',
      createdResourceGroup: false,
      serverName: 'a',
      storageAccountName: 'b',
    };
    await registry.set('one', lake);
    expect(registry.get('one')).toEqual(lake);
    expect(registry.get('two')).toBeUndefined();
    await registry.remove('one');
    expect(registry.get('one')).toBeUndefined();
  });
});

describe('PendingLakes', () => {
  it('keeps the names in the state and the password in the secrets, and forgets both', async () => {
    const { pending, state, secrets } = memoryPending();
    const lake = {
      subscriptionId: 's',
      resourceGroup: 'r',
      createdResourceGroup: true,
      deployment: 'aantje-lake-x',
      namePrefix: 'lake',
      serverName: 'a',
      storageAccountName: 'b',
      authentication: 'password',
      tenantId: TID,
    } as const;
    await pending.add(lake, 'secret');
    expect(pending.list()).toEqual([lake]);
    expect(JSON.stringify([...state.values()])).not.toContain('secret');
    expect(await pending.password(lake)).toBe('secret');
    await pending.remove(lake.deployment);
    expect(pending.list()).toEqual([]);
    expect(secrets.size).toBe(0);
  });
});
