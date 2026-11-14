import type { PickItem, WizardUi } from '../connections/ports';
import type { AzureAuthMode, PostgresProfile } from '../connections/profile';
import type { ConnectionStore } from '../connections/store';
import { currentFirst } from '../connections/wizard';
import { userMessageOf } from '../errors';
import type { Logger } from '../log';
import type { ArmClient } from './arm';
import { deployedLake, deployLake, waitForLake } from './create-lake';
import type { DeployedLake, LakeDeps, LakeRequest, WaitDeps } from './create-lake';
import { dataPathOf } from './lake-outputs';
import { chooseAuthentication, profileOf, signInName, uniqueName } from './lake-profile';
import { validateNamePrefix, validateResourceGroupName } from './names';
import { elapsed } from './operations';
import type { PendingLakes } from './pending';
import { isIpv4 } from './public-ip';
import type { LakeRegistry } from './registry';
import { SIZE_NAMES, SIZES } from './sizes';
import type { LakeSize } from './sizes';

type Listing = Pick<
  ArmClient,
  'listTenants' | 'listSubscriptions' | 'listResourceGroups' | 'listLocations' | 'sizeProblems'
>;

export interface CreateFlowDeps {
  readonly arm: Listing & LakeDeps['arm'];
  /** Signs in, asking only when there is no session, and uses the tenant for every call after it. */
  readonly signIn: (tenantId?: string) => Promise<void>;
  readonly token: () => Promise<string>;
  readonly publicIp: () => Promise<string>;
  readonly store: Pick<ConnectionStore, 'list' | 'newId' | 'add'>;
  readonly registry: Pick<LakeRegistry, 'set' | 'markUnattached' | 'markAttached'>;
  readonly pending: LakeDeps['pending'];
  /** Attaches the new lake, which creates its schema; resolves when the role works, rejects with the reason. */
  readonly attach: (
    profile: PostgresProfile,
    dataPath: string,
    report: (step: string) => void,
  ) => Promise<void>;
  readonly password?: () => string;
  readonly log: Logger;
}

const NEW_GROUP = 'new';
const TITLE = 'Create Azure DuckLake';
const PRICING = 'https://azure.microsoft.com/pricing/calculator/';

/** Asks what Azure needs, creates the lake and saves it as a connection. Returns it, or undefined when cancelled. */
export async function createLakeFlow(
  ui: WizardUi,
  deps: CreateFlowDeps,
): Promise<PostgresProfile | undefined> {
  const { arm } = deps;
  await deps.signIn();
  const tenantId = await chooseTenant(ui, deps);
  const subscriptions = await ui.withProgress('Reading your subscriptions...', () => arm.listSubscriptions());
  const subscriptionId = await ui.pick(
    `${TITLE} (1/6): subscription`,
    subscriptions
      .filter((subscription) => tenantId === undefined || subscription.tenantId === tenantId)
      .map((subscription) => ({
        label: subscription.name,
        description: subscription.id,
        value: subscription.id,
      })),
  );
  if (subscriptionId === undefined) {
    return undefined;
  }
  const group = await chooseGroup(ui, arm, subscriptionId);
  if (group === undefined) {
    return undefined;
  }
  const location = await chooseLocation(ui, arm, subscriptionId, group.location);
  if (location === undefined) {
    return undefined;
  }
  const namePrefix = await ui.input({
    title: `${TITLE} (4/6)`,
    prompt: 'Name of the lake: the prefix of the Azure resource names, for example "sales"',
    validate: (value) => validateNamePrefix(value.trim()),
  });
  const size = namePrefix === undefined ? undefined : await chooseSize(ui, arm, subscriptionId, location);
  if (namePrefix === undefined || size === undefined) {
    return undefined;
  }
  const authentication = await chooseAuthentication(ui, `${TITLE} (6/6): sign-in to PostgreSQL`);
  if (authentication === undefined) {
    return undefined;
  }
  const clientIp = await chooseIp(ui, deps);
  if (clientIp === undefined) {
    return undefined;
  }
  const request = {
    subscriptionId,
    resourceGroup: group.name,
    newResourceGroup: group.isNew,
    location,
    namePrefix: namePrefix.trim(),
    size,
    authentication,
  };
  const confirmed = await ui.confirm(summary(request, clientIp), 'Create');
  if (!confirmed) {
    return undefined;
  }
  const subscription = subscriptions.find(({ id }) => id === subscriptionId)?.name ?? subscriptionId;
  deps.log.info(requestLine(request, subscription));
  return ui.withProgress('Creating the Azure DuckLake...', async (report) => {
    const lake = await deployLake(request, {
      arm,
      token: deps.token,
      publicIp: () => Promise.resolve(clientIp),
      password: deps.password,
      pending: deps.pending,
      report,
      log: deps.log,
    });
    return addLake(ui, deps, lake, {
      name: request.namePrefix,
      tenant: tenantId ?? lake.tenantId,
      authentication,
      done: 'Created',
      report,
    });
  });
}

export interface FinishFlowDeps {
  readonly arm: WaitDeps['arm'];
  readonly signIn: (tenantId?: string) => Promise<void>;
  readonly store: Pick<ConnectionStore, 'list' | 'newId' | 'add'>;
  readonly registry: Pick<LakeRegistry, 'set' | 'markUnattached' | 'markAttached'>;
  readonly pending: Pick<PendingLakes, 'list' | 'password' | 'remove'>;
  readonly attach: CreateFlowDeps['attach'];
  readonly log: Logger;
}

/**
 * Picks up a deployment of Create Azure DuckLake whose wait broke off: waits for it again, then saves and attaches the
 * lake with the names and the password kept before it started. Returns the connection, or undefined when cancelled.
 */
export async function finishLakeFlow(
  ui: WizardUi,
  deps: FinishFlowDeps,
): Promise<PostgresProfile | undefined> {
  const lakes = deps.pending.list();
  if (lakes.length === 0) {
    ui.info('There is no interrupted Azure DuckLake deployment to finish.');
    return undefined;
  }
  const deployment = await ui.pick(
    'Finish Creating Azure DuckLake: deployment',
    lakes.map((lake) => ({
      label: lake.namePrefix,
      description: `${lake.deployment} in the resource group ${lake.resourceGroup}`,
      value: lake.deployment,
    })),
  );
  const lake = lakes.find((candidate) => candidate.deployment === deployment);
  if (lake === undefined) {
    return undefined;
  }
  deps.log.info(
    `Finish Creating Azure DuckLake "${lake.namePrefix}": deployment "${lake.deployment}" in the resource group "${lake.resourceGroup}" of the subscription ${lake.subscriptionId}.`,
  );
  await deps.signIn(lake.tenantId);
  return ui.withProgress(`Finishing the Azure DuckLake "${lake.namePrefix}"...`, async (report) => {
    const outputs = await waitForLake(lake, { arm: deps.arm, pending: deps.pending, report, log: deps.log });
    const password = lake.authentication === 'entra' ? undefined : await deps.pending.password(lake);
    return addLake(ui, deps, deployedLake(lake, outputs, password), {
      name: lake.namePrefix,
      tenant: lake.tenantId,
      authentication: lake.authentication,
      done: 'Finished',
      report,
    });
  });
}

/** Saves a deployed lake as a connection, forgets its pending record, then attaches it; a failed attach is reported. */
async function addLake(
  ui: WizardUi,
  deps: Pick<CreateFlowDeps, 'store' | 'registry' | 'attach' | 'log'> & {
    readonly pending: Pick<PendingLakes, 'remove'>;
  },
  lake: DeployedLake,
  options: {
    readonly name: string;
    readonly tenant: string;
    readonly authentication: AzureAuthMode;
    readonly done: string;
    readonly report: (step: string) => void;
  },
): Promise<PostgresProfile> {
  const { report } = options;
  // The password is kept only in the pending record: save the connection with it before anything else can fail.
  const profile = profileOf(
    lake.outputs,
    uniqueName(options.name, deps.store.list()),
    (value) => deps.store.newId(value),
    {
      tenant: options.tenant,
      authentication: options.authentication,
    },
  );
  await deps.store.add(profile, lake.password);
  await deps.registry.set(profile.id, lake.created);
  const dataPath = dataPathOf(lake.outputs);
  await deps.registry.markUnattached(profile.id, dataPath);
  await deps.pending.remove(lake.deployment);
  deps.log.info(
    `Saved the connection "${profile.name}": ${profile.host}:${profile.port}/${profile.database} as ${profile.user}, storage account "${lake.created.storageAccountName}", data path ${dataPath}.`,
  );
  const lost =
    options.authentication === 'password' && lake.password === undefined
      ? ' Its generated password was not found: reset the administrator password of the server in the Azure portal and enter it with Edit Connection.'
      : '';
  report('Attaching the lake');
  deps.log.info(
    `Attaching "${profile.name}" for the first time: DuckLake creates its tables in the catalog.`,
  );
  const started = Date.now();
  try {
    await deps.attach(profile, dataPath, report);
    await deps.registry.markAttached(profile.id);
    deps.log.info(`Attached "${profile.name}" after ${elapsed(Date.now() - started)}.${lost}`);
    ui.info(`${options.done} the Azure DuckLake "${profile.name}" and added it as a connection.${lost}`);
  } catch (error) {
    deps.log.error(`Attaching "${profile.name}" failed; the connection is saved.`, error);
    ui.error(
      `The Azure DuckLake "${profile.name}" exists and is saved as a connection, but attaching it failed: ${userMessageOf(error)}${lost} The resources keep costing money until you delete them.`,
    );
  }
  return profile;
}

async function chooseTenant(ui: WizardUi, deps: CreateFlowDeps): Promise<string | undefined> {
  const tenants = await deps.arm.listTenants();
  if (tenants.length < 2) {
    return undefined;
  }
  const picked = await ui.pick(
    `${TITLE}: directory (tenant)`,
    tenants.map((tenant) => ({ label: tenant.name, description: tenant.id, value: tenant.id })),
  );
  if (picked !== undefined) {
    await deps.signIn(picked);
  }
  return picked;
}

async function chooseGroup(
  ui: WizardUi,
  arm: Listing,
  subscriptionId: string,
): Promise<{ name: string; isNew: boolean; location?: string } | undefined> {
  const groups = await ui.withProgress('Reading the resource groups...', () =>
    arm.listResourceGroups(subscriptionId),
  );
  const picked = await ui.pick(`${TITLE} (2/6): resource group`, [
    { label: '$(add) New resource group...', value: NEW_GROUP },
    ...groups.map((group) => ({
      label: group.name,
      description: group.location,
      value: `group:${group.name}`,
    })),
  ]);
  if (picked === undefined) {
    return undefined;
  }
  if (picked !== NEW_GROUP) {
    const name = picked.slice('group:'.length);
    return { name, isNew: false, location: groups.find((group) => group.name === name)?.location };
  }
  const name = await ui.input({
    title: `${TITLE} (2/6)`,
    prompt: 'Name of the new resource group',
    validate: (value) =>
      validateResourceGroupName(value.trim()) ??
      (groups.some((group) => group.name.toLowerCase() === value.trim().toLowerCase())
        ? 'A resource group with this name exists.'
        : undefined),
  });
  return name === undefined ? undefined : { name: name.trim(), isNew: true };
}

async function chooseLocation(
  ui: WizardUi,
  arm: Listing,
  subscriptionId: string,
  preferred: string | undefined,
): Promise<string | undefined> {
  const locations = await ui.withProgress('Reading the regions...', () => arm.listLocations(subscriptionId));
  const items = locations
    .map((location): PickItem<string> => ({
      label: location.displayName,
      description: location.name,
      value: location.name,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return ui.pick(`${TITLE} (3/6): region`, currentFirst(items, preferred));
}

// A quick pick cannot disable an item, so a size that the region lacks is listed with the reason and refused when picked.
async function chooseSize(
  ui: WizardUi,
  arm: Listing,
  subscriptionId: string,
  location: string,
): Promise<LakeSize | undefined> {
  const problems = await ui.withProgress('Checking which sizes the region offers...', () =>
    arm.sizeProblems(subscriptionId, location),
  );
  const items = SIZE_NAMES.map((size): PickItem<LakeSize> => ({
    label: SIZES[size].label,
    description: problems[size] ? `Not available here: ${problems[size]}` : SIZES[size].description,
    value: size,
  }));
  for (;;) {
    const size = await ui.pick(`${TITLE} (5/6): size`, items);
    if (size === undefined || !problems[size]) {
      return size;
    }
    ui.error(`${SIZES[size].label} is not available in this region: ${problems[size]}. Choose another size.`);
  }
}

async function chooseIp(ui: WizardUi, deps: CreateFlowDeps): Promise<string | undefined> {
  try {
    return await deps.publicIp();
  } catch {
    return ui.input({
      title: TITLE,
      prompt:
        'aantje could not look up your public IPv4 address. Enter it; only this address may reach the PostgreSQL server.',
      validate: (value) => (isIpv4(value.trim()) ? undefined : 'Enter an IPv4 address such as 203.0.113.7.'),
    });
  }
}

function summary(
  request: {
    resourceGroup: string;
    newResourceGroup: boolean;
    location: string;
    namePrefix: string;
    size: LakeSize;
    authentication: AzureAuthMode;
  },
  clientIp: string,
): string {
  const size = SIZES[request.size];
  return [
    `Create the DuckLake "${request.namePrefix}" in ${request.newResourceGroup ? 'the new' : 'the'} resource group "${request.resourceGroup}" (${request.location})?`,
    `Size ${size.label}: ${size.description}. A PostgreSQL server (the catalog), a storage account with Data Lake Gen2 (the data files) and the role Storage Blob Data Contributor on it for you.`,
    `Only your public IP address ${clientIp} may reach the PostgreSQL server. ${
      request.authentication === 'entra'
        ? 'You sign in to it with your Microsoft account as Entra administrator; the generated administrator password is not kept.'
        : 'The password is generated and kept in the secret storage.'
    }`,
    `The resources cost money as long as they exist, also when idle; see ${PRICING} for the price of this size.`,
  ].join('\n\n');
}

function requestLine(request: LakeRequest, subscription: string): string {
  return `Create Azure DuckLake "${request.namePrefix}": subscription "${subscription}" (${request.subscriptionId}), ${request.newResourceGroup ? 'new' : 'existing'} resource group "${request.resourceGroup}", region ${request.location}, size ${request.size}, sign-in ${signInName(request.authentication)}.`;
}
