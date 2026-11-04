import { describe, expect, it, vi } from 'vitest';
import type { InputOptions, WizardUi } from '../../src/connections/ports';
import { ArmRequestError, ArmUnreachableError } from '../../src/azure/arm';
import { createLakeFlow, deleteLakeFlow, finishLakeFlow, importLakeFlow } from '../../src/azure/wizard';
import type { CreateFlowDeps, FinishFlowDeps } from '../../src/azure/wizard';
import { AantjeError } from '../../src/errors';
import { silentLogger } from '../../src/log';
import { jwt, memoryLog, memoryPending, MemoryStore, OID, TID } from './azure-support';

/** Answers pick and input prompts in order; `undefined` cancels. */
function scriptedUi(answers: (string | undefined)[], confirm = true) {
  const queue = [...answers];
  const errors: string[] = [];
  const asked: InputOptions[] = [];
  const ui: WizardUi = {
    pick: () => Promise.resolve(queue.shift() as never),
    input: (options) => {
      asked.push(options);
      return Promise.resolve(queue.shift());
    },
    confirm: () => Promise.resolve(confirm),
    info: () => undefined,
    error: (message) => void errors.push(message),
    withProgress: (_title, task) => task(() => undefined),
  };
  return { ui, errors, asked };
}

const ENTRA_JSON = JSON.stringify({
  authentication: 'entra',
  attach: "ATTACH 'x' AS lake (DATA_PATH 'abfss://lake@acct.dfs.core.windows.net/data/');",
  azureSecret: { provider: 'access_token', accountName: 'acct' },
  postgres: {
    host: 'h.postgres.database.azure.com',
    database: 'ducklake_catalog',
    user: 'ada@contoso.com',
    port: 5432,
  },
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

function createDeps(overrides: Partial<CreateFlowDeps> = {}) {
  const store = new MemoryStore();
  const { pending } = memoryPending();
  const { log, lines } = memoryLog();
  const deps: CreateFlowDeps = {
    arm: {
      listTenants: () => Promise.resolve([{ id: TID, name: 'Home' }]),
      listSubscriptions: () => Promise.resolve([{ id: 'sub', name: 'Sub', tenantId: TID }]),
      listResourceGroups: () => Promise.resolve([{ name: 'rg', location: 'westeurope' }]),
      listLocations: () =>
        Promise.resolve([{ id: 'westeurope', name: 'westeurope', displayName: 'West Europe' }]),
      sizeProblems: () => Promise.resolve({ medium: 'Standard_ZRS is not offered' }),
      canAssignRoles: () => Promise.resolve(true),
      postgresVersion: () => Promise.resolve('17'),
      storageNameProblem: () => Promise.resolve(undefined),
      serverNameProblem: () => Promise.resolve(undefined),
      createResourceGroup: () => Promise.resolve(),
      deleteResourceGroup: () => Promise.resolve({ status: 202 }),
      startDeployment: () => Promise.resolve(),
      waitForDeployment: () =>
        Promise.resolve({ ducklake: LAKE_JSON, postgresServerName: 'srv', storageAccountName: 'acct' }),
    },
    signIn: () => Promise.resolve(),
    token: () => Promise.resolve(jwt({ oid: OID, tid: TID })),
    publicIp: () => Promise.resolve('203.0.113.7'),
    store,
    registry: { set: vi.fn(() => Promise.resolve()) },
    pending,
    attach: vi.fn(() => Promise.resolve()),
    password: () => 'generated',
    log,
    ...overrides,
  };
  return { deps, added: store.added, pending, lines };
}

describe('createLakeFlow', () => {
  // subscription, resource group, region, size; the name is an input
  const answers = ['sub', 'group:rg', 'westeurope', undefined];

  it('keeps the connection and the password, then attaches the lake', async () => {
    const { deps, added, pending } = createDeps();
    const { ui } = scriptedUi(['sub', 'group:rg', 'westeurope', 'lake', 'small', 'password']);
    const profile = await createLakeFlow(ui, deps);
    expect(profile).toMatchObject({
      host: 'h.postgres.database.azure.com',
      ssl: true,
      azureAccount: 'acct',
      azureTenant: TID,
    });
    expect(added).toEqual([{ profile, password: 'generated' }]);
    expect(deps.registry.set).toHaveBeenCalledWith(
      profile?.id,
      expect.objectContaining({ serverName: 'srv' }),
    );
    expect(deps.attach).toHaveBeenCalledWith(
      profile,
      'abfss://lake@acct.dfs.core.windows.net/data/',
      expect.any(Function),
    );
    expect(pending.list()).toEqual([]);
  });

  it('logs the choices, the names and the saved connection, but never the password or a token', async () => {
    const password = 'Pw-7f3a9c2e1b5d';
    const token = jwt({ oid: OID, tid: TID });
    const { deps, lines } = createDeps({ password: () => password, token: () => Promise.resolve(token) });
    await createLakeFlow(scriptedUi(['sub', 'group:rg', 'westeurope', 'lake', 'small', 'password']).ui, deps);
    const log = lines.join('\n');
    for (const value of [
      'westeurope',
      OID,
      'h.postgres.database.azure.com',
      'abfss://lake@acct.dfs.core.windows.net/data/',
    ]) {
      expect(log).toContain(value);
    }
    expect(log).not.toContain(password);
    expect(log).not.toContain(token);
  });

  it('keeps no password for Entra and stores the profile as an Entra login', async () => {
    const { deps, added } = createDeps({
      token: () => Promise.resolve(jwt({ oid: OID, tid: TID, upn: 'ada@contoso.com' })),
    });
    vi.spyOn(deps.arm, 'waitForDeployment').mockResolvedValue({
      ducklake: ENTRA_JSON,
      postgresServerName: 'srv',
      storageAccountName: 'acct',
    });
    const { ui } = scriptedUi(['sub', 'group:rg', 'westeurope', 'lake', 'small', 'entra']);
    const profile = await createLakeFlow(ui, deps);
    expect(profile).toMatchObject({ azureAuth: 'entra', user: 'ada@contoso.com' });
    expect(added).toEqual([{ profile, password: undefined }]);
  });

  it('keeps the connection when the attach fails and says so', async () => {
    const { deps, added } = createDeps({ attach: () => Promise.reject(new Error('boom')) });
    const { ui, errors } = scriptedUi(['sub', 'group:rg', 'westeurope', 'lake', 'small', 'password']);
    expect(await createLakeFlow(ui, deps)).toBeDefined();
    expect(added).toHaveLength(1);
    expect(errors.join()).toMatch(/exists and is saved/);
  });

  it('asks again when the size is not offered in the region', async () => {
    const { deps } = createDeps();
    const { ui, errors } = scriptedUi([
      'sub',
      'group:rg',
      'westeurope',
      'lake',
      'medium',
      'small',
      'password',
    ]);
    expect(await createLakeFlow(ui, deps)).toBeDefined();
    expect(errors.join()).toMatch(/not available/);
  });

  it('asks for the IP when the lookup fails, and deploys nothing when declined', async () => {
    const { deps } = createDeps({ publicIp: () => Promise.reject(new Error('offline')) });
    const start = vi.spyOn(deps.arm, 'startDeployment');
    const { ui, asked } = scriptedUi(
      [...answers.slice(0, 3), 'lake', 'small', 'password', '198.51.100.4'],
      false,
    );
    expect(await createLakeFlow(ui, deps)).toBeUndefined();
    expect(asked.at(-1)?.validate?.('not an ip')).toBeDefined();
    expect(start).not.toHaveBeenCalled();
  });
});

describe('finishLakeFlow', () => {
  const lake = {
    subscriptionId: 'sub',
    resourceGroup: 'rg',
    createdResourceGroup: true,
    deployment: 'aantje-lake-abc',
    namePrefix: 'lake',
    serverName: 'expected-pg',
    storageAccountName: 'expected',
    authentication: 'password',
    tenantId: TID,
  } as const;

  async function finishDeps(wait: FinishFlowDeps['arm']['waitForDeployment']) {
    const store = new MemoryStore();
    const { pending } = memoryPending();
    const { log } = memoryLog();
    await pending.add(lake, 'kept');
    const deps: FinishFlowDeps = {
      arm: { waitForDeployment: vi.fn(wait) },
      signIn: vi.fn(() => Promise.resolve()),
      store,
      registry: { set: vi.fn(() => Promise.resolve()) },
      pending,
      attach: vi.fn(() => Promise.resolve()),
      log,
    };
    return { deps, added: store.added, pending };
  }

  it('waits again, then saves the lake with the kept password and forgets the record', async () => {
    const { deps, added, pending } = await finishDeps(() =>
      Promise.resolve({ ducklake: LAKE_JSON, postgresServerName: 'srv', storageAccountName: 'acct' }),
    );
    const profile = await finishLakeFlow(scriptedUi([lake.deployment]).ui, deps);
    expect(deps.signIn).toHaveBeenCalledWith(TID);
    expect(deps.arm.waitForDeployment).toHaveBeenCalledWith('sub', 'rg', lake.deployment, expect.anything());
    expect(profile).toMatchObject({ name: 'lake', azureAccount: 'acct', azureTenant: TID });
    expect(added).toEqual([{ profile, password: 'kept' }]);
    expect(deps.registry.set).toHaveBeenCalledWith(profile?.id, {
      subscriptionId: 'sub',
      resourceGroup: 'rg',
      createdResourceGroup: true,
      serverName: 'srv',
      storageAccountName: 'acct',
    });
    expect(deps.attach).toHaveBeenCalled();
    expect(pending.list()).toEqual([]);
  });

  it('keeps the record when Azure is still unreachable', async () => {
    const { deps, added, pending } = await finishDeps(() =>
      Promise.reject(new ArmUnreachableError(new TypeError('fetch failed'))),
    );
    await expect(finishLakeFlow(scriptedUi([lake.deployment]).ui, deps)).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });
    expect(added).toEqual([]);
    expect(pending.list()).toEqual([lake]);
  });

  it('forgets a deployment that Azure does not know', async () => {
    const missing = new ArmRequestError(new AantjeError('CONNECTION_FAILED', 'DeploymentNotFound'), 404);
    const { deps, pending } = await finishDeps(() => Promise.reject(missing));
    await expect(finishLakeFlow(scriptedUi([lake.deployment]).ui, deps)).rejects.toBeDefined();
    expect(pending.list()).toEqual([]);
  });

  it('asks nothing and waits for nothing when no deployment is pending', async () => {
    const { deps, pending } = await finishDeps(() => Promise.resolve({}));
    await pending.remove(lake.deployment);
    const { ui, asked } = scriptedUi([]);
    expect(await finishLakeFlow(ui, deps)).toBeUndefined();
    expect(asked).toEqual([]);
    expect(deps.arm.waitForDeployment).not.toHaveBeenCalled();
  });
});

describe('importLakeFlow', () => {
  it('saves the connection with the typed password', async () => {
    const store = new MemoryStore();
    const { ui } = scriptedUi([LAKE_JSON, 'azure', 'password', 'secret']);
    const profile = await importLakeFlow(ui, {
      store,
      clipboard: () => Promise.resolve('nothing useful'),
      test: () => Promise.resolve(),
      entraUser: () => Promise.resolve('unused'),
      log: silentLogger,
    });
    expect(profile).toMatchObject({ name: 'azure', azureAccount: 'acct', database: 'ducklake_catalog' });
    expect(profile).not.toHaveProperty('azureAuth');
    expect(store.added[0]?.password).toBe('secret');
  });

  it('lets an imported lake sign in with Entra: no password asked, the user is the signed-in account', async () => {
    const store = new MemoryStore();
    const test = vi.fn(() => Promise.resolve());
    const { ui, asked } = scriptedUi([LAKE_JSON, 'azure', 'entra']);
    const profile = await importLakeFlow(ui, {
      store,
      clipboard: () => Promise.resolve('nothing useful'),
      test,
      entraUser: () => Promise.resolve('grace@contoso.com'),
      log: silentLogger,
    });
    expect(profile).toMatchObject({ azureAuth: 'entra', user: 'grace@contoso.com' });
    expect(asked.some(({ password }) => password === true)).toBe(false);
    expect(store.added[0]?.password).toBeUndefined();
    expect(test).toHaveBeenCalledWith(profile, undefined);
  });
});

describe('deleteLakeFlow', () => {
  const profile = {
    id: 'lake',
    name: 'lake',
    kind: 'postgres',
    host: 'h',
    port: 5432,
    database: 'd',
    user: 'u',
  } as const;
  const created = {
    subscriptionId: 's',
    resourceGroup: 'rg',
    createdResourceGroup: false,
    serverName: 'a',
    storageAccountName: 'b',
  };
  const accepted = { status: 202, poll: { url: 'https://management.azure.com/op', kind: 'status' } } as const;
  const deps = (known: boolean, done: () => Promise<boolean> = () => Promise.resolve(true)) => {
    const tasks: Promise<void>[] = [];
    return {
      arm: {
        listGroupResources: vi.fn(() => Promise.resolve([])),
        deleteResourceGroup: vi.fn(() => Promise.resolve(accepted)),
        deleteServer: vi.fn(() => Promise.resolve(accepted)),
        deleteStorageAccount: vi.fn(() => Promise.resolve({ status: 200 })),
        operationDone: vi.fn(done),
      },
      signIn: () => Promise.resolve(),
      registry: { get: () => (known ? created : undefined), remove: vi.fn(() => Promise.resolve()) },
      removeConnection: vi.fn(() => Promise.resolve()),
      log: silentLogger,
      sleep: () => Promise.resolve(),
      background: (task: Promise<void>) => void tasks.push(task),
      tasks,
    };
  };

  it('refuses a lake that aantje did not create, without asking anything', async () => {
    const d = deps(false);
    const { ui, errors, asked } = scriptedUi([]);
    expect(await deleteLakeFlow(ui, profile, d)).toBe(false);
    expect(asked).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(d.arm.deleteServer).not.toHaveBeenCalled();
  });

  it('wants the name typed, then a second confirmation, before anything is deleted', async () => {
    const d = deps(true);
    const typed = scriptedUi(['lake']);
    expect(await deleteLakeFlow(typed.ui, profile, d)).toBe(true);
    expect(typed.asked[0]?.validate?.('other')).toBeDefined();
    expect(typed.asked[0]?.validate?.('lake')).toBeUndefined();
    expect(d.arm.deleteServer).toHaveBeenCalled();
    expect(d.removeConnection).toHaveBeenCalledWith(profile);

    const declined = deps(true);
    expect(await deleteLakeFlow(scriptedUi(['lake'], false).ui, profile, declined)).toBe(false);
    expect(declined.arm.deleteServer).not.toHaveBeenCalled();
    expect(declined.removeConnection).not.toHaveBeenCalled();

    const cancelled = deps(true);
    expect(await deleteLakeFlow(scriptedUi([undefined]).ui, profile, cancelled)).toBe(false);
    expect(cancelled.arm.deleteServer).not.toHaveBeenCalled();
  });

  it('follows the deletion after the command and says so when Azure does not finish it', async () => {
    const finished = deps(true);
    const quiet = scriptedUi(['lake']);
    await deleteLakeFlow(quiet.ui, profile, finished);
    await Promise.all(finished.tasks);
    expect(finished.arm.operationDone).toHaveBeenCalledTimes(1);
    expect(quiet.errors).toEqual([]);

    const failing = deps(true, () =>
      Promise.reject(new AantjeError('CONNECTION_FAILED', 'Azure said: Conflict')),
    );
    const told = scriptedUi(['lake']);
    expect(await deleteLakeFlow(told.ui, profile, failing)).toBe(true);
    await Promise.all(failing.tasks);
    expect(told.errors).toHaveLength(1);
    expect(told.errors[0]).toContain('rg');
  });
});
