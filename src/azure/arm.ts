import { AantjeError } from '../errors';
import { isObject } from '../guards';
import { armErrorOf, armFailure } from './arm-errors';
import {
  armOperationOf,
  deploymentOperationOf,
  deploymentStatusOf,
  isArmUrl,
  TERMINAL_STATES,
  TOLERATED_POLL_FAILURES,
} from './operations';
import type { ArmOperation, DeploymentOperation, DeploymentStatus } from './operations';
import { isIpv4 } from './public-ip';
import { withBackoff } from './retry';
import { SIZE_NAMES, SIZES } from './sizes';
import type { LakeSize } from './sizes';

/** The one firewall rule that the template creates and that Allow my IP replaces; other rules are never touched. */
export const FIREWALL_RULE = 'client-ip';

export const ARM_URL = 'https://management.azure.com';
/** The scope of the token that Azure Resource Manager accepts. */
export const ARM_SCOPE = 'https://management.azure.com/.default';
/** The scope of the token that Azure Storage accepts (Entra access to the data files). */
export const STORAGE_SCOPE = 'https://storage.azure.com/.default';

/** The scope of the token that Azure Database for PostgreSQL accepts as the password of an Entra user. */
export const POSTGRES_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

const API = {
  tenants: '2022-12-01',
  subscriptions: '2022-12-01',
  locations: '2022-12-01',
  resources: '2021-04-01',
  permissions: '2022-04-01',
  deployments: '2024-03-01',
  storage: '2023-05-01',
  postgres: '2024-08-01',
} as const;

export interface Named {
  readonly id: string;
  readonly name: string;
}

export interface Subscription extends Named {
  readonly tenantId: string;
}

export interface ResourceGroup {
  readonly name: string;
  readonly location: string;
}

export interface Location extends Named {
  readonly displayName: string;
}

export interface Permission {
  readonly actions?: readonly string[];
  readonly notActions?: readonly string[];
}

export interface DeploymentRequest {
  /** The compiled template. */
  readonly template: object;
  readonly parameters: Readonly<Record<string, string>>;
}

export interface WaitOptions {
  readonly onState?: (state: string, status: DeploymentStatus) => void;
  /** Given, every poll also reads the deployment operations, one per resource of the template. */
  readonly onOperations?: (operations: readonly DeploymentOperation[]) => void;
  /** A poll that failed but is tried again after `pauseMs`. */
  readonly onRetry?: (error: AantjeError, pauseMs: number) => void;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}

export interface ArmOptions {
  readonly fetch?: typeof fetch;
  /** A token for the ARM scope; called for every request, the sign-in caches it. */
  readonly token: () => Promise<string>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly baseUrl?: string;
  /** One line per request: method, path, status, duration and correlation id; never the token or a body. */
  readonly debug?: (message: string) => void;
}

interface ArmResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 45 * 60_000;
const FIREWALL_POLLS = 24;

/** The major versions aantje deploys, newest first. */
export const POSTGRES_VERSIONS = ['17', '16', '15', '14'];

/** The part of Azure Resource Manager that creating and deleting a lake needs. Every call is a documented REST API. */
export class ArmClient {
  private readonly http: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly base: string;

  constructor(private readonly options: ArmOptions) {
    this.http = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.base = options.baseUrl ?? ARM_URL;
  }

  async listTenants(): Promise<Named[]> {
    const rows = await this.list(`/tenants?api-version=${API.tenants}`);
    return rows.flatMap((row) =>
      typeof row.tenantId === 'string'
        ? [{ id: row.tenantId, name: typeof row.displayName === 'string' ? row.displayName : row.tenantId }]
        : [],
    );
  }

  async listSubscriptions(): Promise<Subscription[]> {
    const rows = await this.list(`/subscriptions?api-version=${API.subscriptions}`);
    return rows.flatMap((row) =>
      typeof row.subscriptionId === 'string' &&
      typeof row.displayName === 'string' &&
      row.state !== 'Disabled'
        ? [
            {
              id: row.subscriptionId,
              name: row.displayName,
              tenantId: typeof row.tenantId === 'string' ? row.tenantId : '',
            },
          ]
        : [],
    );
  }

  async listResourceGroups(subscriptionId: string): Promise<ResourceGroup[]> {
    const rows = await this.list(
      `/subscriptions/${subscriptionId}/resourcegroups?api-version=${API.resources}`,
    );
    return rows.flatMap((row) =>
      typeof row.name === 'string' && typeof row.location === 'string'
        ? [{ name: row.name, location: row.location }]
        : [],
    );
  }

  /** The regions that hold data centres and that the subscription may create a resource group in. */
  async listLocations(subscriptionId: string): Promise<Location[]> {
    const rows = await this.list(`/subscriptions/${subscriptionId}/locations?api-version=${API.locations}`);
    const physical = rows.flatMap((row) => {
      const metadata = isObject(row.metadata) ? row.metadata : {};
      return typeof row.name === 'string' &&
        typeof row.displayName === 'string' &&
        metadata.regionType === 'Physical'
        ? [{ id: row.name, name: row.name, displayName: row.displayName }]
        : [];
    });
    const allowed = await this.resourceGroupRegions(subscriptionId);
    return allowed === undefined
      ? physical
      : physical.filter(({ displayName }) => allowed.has(displayName.toLowerCase()));
  }

  // A subscription lists regions it cannot use (restricted ones such as Norway West); the resource provider names the usable ones.
  private async resourceGroupRegions(subscriptionId: string): Promise<Set<string> | undefined> {
    try {
      const provider = await this.send(
        'GET',
        `${this.base}/subscriptions/${subscriptionId}/providers/Microsoft.Resources?api-version=${API.resources}`,
      );
      const types = isObject(provider) ? arrayOf(provider.resourceTypes) : [];
      const groups = types.find((type) => type.resourceType === 'resourceGroups');
      const names = Array.isArray(groups?.locations)
        ? groups.locations.filter((name): name is string => typeof name === 'string')
        : [];
      return names.length > 0 ? new Set(names.map((name) => name.toLowerCase())) : undefined;
    } catch {
      return undefined;
    }
  }

  async createResourceGroup(subscriptionId: string, name: string, location: string): Promise<void> {
    await this.request('PUT', `/subscriptions/${subscriptionId}/resourcegroups/${encodeURIComponent(name)}`, {
      version: API.resources,
      body: { location },
    });
  }

  /** The resources of a group as `{ id, type }`. */
  async listGroupResources(
    subscriptionId: string,
    resourceGroup: string,
  ): Promise<{ id: string; type: string }[]> {
    const path = `/subscriptions/${subscriptionId}/resourcegroups/${encodeURIComponent(resourceGroup)}/resources`;
    const rows = await this.list(`${path}?api-version=${API.resources}`);
    return rows.flatMap((row) =>
      typeof row.id === 'string' && typeof row.type === 'string' ? [{ id: row.id, type: row.type }] : [],
    );
  }

  /** Undefined when the name is free, else the reason. */
  async storageNameProblem(subscriptionId: string, name: string): Promise<string | undefined> {
    return this.nameProblem(
      `/subscriptions/${subscriptionId}/providers/Microsoft.Storage/checkNameAvailability`,
      API.storage,
      { name, type: 'Microsoft.Storage/storageAccounts' },
      'storage account',
    );
  }

  async serverNameProblem(subscriptionId: string, name: string): Promise<string | undefined> {
    return this.nameProblem(
      `/subscriptions/${subscriptionId}/providers/Microsoft.DBforPostgreSQL/checkNameAvailability`,
      API.postgres,
      { name, type: 'Microsoft.DBforPostgreSQL/flexibleServers' },
      'PostgreSQL server',
    );
  }

  /**
   * Whether the signed-in user may write role assignments at the scope: the effective permissions of the user there
   * allow `Microsoft.Authorization/roleAssignments/write`. Without a resource group (a new one) the subscription counts.
   */
  async canAssignRoles(subscriptionId: string, resourceGroup?: string): Promise<boolean> {
    const scope = `/subscriptions/${subscriptionId}${resourceGroup === undefined ? '' : `/resourceGroups/${encodeURIComponent(resourceGroup)}`}`;
    return this.canDo(scope, 'Microsoft.Authorization/roleAssignments/write');
  }

  /** Whether the effective permissions of the signed-in user at the scope (an ARM id) allow the action. */
  async canDo(scope: string, action: string): Promise<boolean> {
    const rows = await this.list(
      `${scope}/providers/Microsoft.Authorization/permissions?api-version=${API.permissions}`,
    );
    return allows(rows.map(permissionOf), action);
  }

  /** The id of the PostgreSQL flexible server with this host name in one of the subscriptions, or undefined. */
  async findPostgresServer(host: string, subscriptionIds: readonly string[]): Promise<string | undefined> {
    for (const subscriptionId of subscriptionIds) {
      const rows = await this.list(
        `/subscriptions/${subscriptionId}/providers/Microsoft.DBforPostgreSQL/flexibleServers?api-version=${API.postgres}`,
      ).catch(() => []);
      for (const row of rows) {
        const properties = isObject(row.properties) ? row.properties : {};
        const fqdn = properties.fullyQualifiedDomainName;
        if (
          typeof row.id === 'string' &&
          typeof fqdn === 'string' &&
          fqdn.toLowerCase() === host.toLowerCase()
        ) {
          return row.id;
        }
      }
    }
    return undefined;
  }

  /**
   * Makes the rule `FIREWALL_RULE` of the server admit exactly this address, and waits until the server shows it.
   * Only a single IPv4 address is accepted, never `0.0.0.0` (which means every Azure service) or a range.
   */
  async allowIp(serverId: string, ip: string): Promise<'created' | 'updated' | 'unchanged'> {
    if (!isIpv4(ip) || ip === '0.0.0.0') {
      throw new AantjeError('INVALID_PROFILE', `"${ip}" is not a single public IPv4 address.`);
    }
    const path = `${serverId}/firewallRules/${FIREWALL_RULE}`;
    const current = await this.firewallRule(path);
    if (current?.start === ip && current.end === ip) {
      return 'unchanged';
    }
    try {
      // The server runs one operation at a time and answers 409 while another one is going on.
      await withBackoff(
        () =>
          this.request('PUT', path, {
            version: API.postgres,
            body: { properties: { startIpAddress: ip, endIpAddress: ip } },
          }),
        {
          isRetryable: (error) => error instanceof ArmRequestError && error.status === 409,
          sleep: this.sleep,
          attempts: 6,
        },
      );
    } catch (error) {
      if (error instanceof ArmRequestError && error.status === 403) {
        throw new AantjeError(
          'AUTH_FAILED',
          'Your account may not change the firewall rules of this server. Ask for a role that allows Microsoft.DBforPostgreSQL/flexibleServers/firewallRules/write on it, for example Contributor.',
          { cause: error },
        );
      }
      throw error;
    }
    for (let tries = 0; tries < FIREWALL_POLLS; tries++) {
      const rule = await this.firewallRule(path);
      if (rule?.start === ip && rule.end === ip) {
        return current === undefined ? 'created' : 'updated';
      }
      await this.sleep(DEFAULT_POLL_MS);
    }
    throw new AantjeError(
      'TIMEOUT',
      'Azure accepted the firewall rule but has not applied it yet. Wait a minute, then try to connect again.',
    );
  }

  private async firewallRule(path: string): Promise<{ start: unknown; end: unknown } | undefined> {
    try {
      const body = await this.request('GET', path, { version: API.postgres });
      const properties = isObject(body) && isObject(body.properties) ? body.properties : {};
      return { start: properties.startIpAddress, end: properties.endIpAddress };
    } catch (error) {
      if (error instanceof ArmRequestError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Why a size cannot be created in the region, or undefined when it can. A lookup that fails says nothing, so it
   * does not block the size: Azure has the last word when the deployment starts.
   */
  async sizeProblems(subscriptionId: string, location: string): Promise<Partial<Record<LakeSize, string>>> {
    const [servers, storage] = await Promise.all([
      this.serverSkus(subscriptionId, location).catch(() => undefined),
      this.storageSkus(subscriptionId, location).catch(() => undefined),
    ]);
    const problems: Partial<Record<LakeSize, string>> = {};
    for (const size of SIZE_NAMES) {
      const { serverSku, storageSku } = SIZES[size];
      if (servers && !servers.has(serverSku)) {
        problems[size] = `${serverSku} is not offered for PostgreSQL in this region`;
      } else if (storage && !storage.has(storageSku)) {
        problems[size] = `${storageSku} is not offered for storage in this region`;
      }
    }
    return problems;
  }

  /** Starts a deployment; it runs on in Azure, `waitForDeployment` follows it. */
  async startDeployment(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    request: DeploymentRequest,
  ): Promise<void> {
    const parameters = Object.fromEntries(
      Object.entries(request.parameters).map(([key, value]) => [key, { value }]),
    );
    await this.request('PUT', `${deploymentPath(subscriptionId, resourceGroup, name)}`, {
      version: API.deployments,
      body: { properties: { mode: 'Incremental', template: request.template, parameters } },
    });
  }

  /** Polls until the deployment ends; returns its outputs by name, or throws what Azure reported. */
  async waitForDeployment(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    options: WaitOptions = {},
  ): Promise<Record<string, unknown>> {
    const { pollMs = DEFAULT_POLL_MS, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
    const path = deploymentPath(subscriptionId, resourceGroup, name);
    let waited = 0;
    let failures = 0;
    for (;;) {
      try {
        const body = await this.request('GET', path, { version: API.deployments });
        const properties = isObject(body) && isObject(body.properties) ? body.properties : {};
        failures = 0;
        const state =
          typeof properties.provisioningState === 'string' ? properties.provisioningState : 'Unknown';
        await this.reportOperations(path, options);
        options.onState?.(state, deploymentStatusOf(properties));
        if (TERMINAL_STATES.has(state)) {
          return state === 'Succeeded'
            ? outputsOf(properties)
            : await this.deploymentFailure(path, properties, state);
        }
      } catch (error) {
        if (!isPassingPollFailure(error) || ++failures > TOLERATED_POLL_FAILURES) {
          throw error;
        }
        options.onRetry?.(error, pollMs * 2 ** failures);
      }
      if (waited >= timeoutMs) {
        throw new AantjeError('TIMEOUT', 'The deployment takes longer than expected.');
      }
      // Each failed poll in a row waits twice as long, so that a network switch or a short outage passes.
      const pause = pollMs * 2 ** failures;
      await this.sleep(pause);
      waited += pause;
    }
  }

  /** The rows of `.../deployments/<name>/operations`: one per resource of the template, with state and duration. */
  private operationRows(path: string): Promise<Record<string, unknown>[]> {
    return this.list(`${path}/operations?api-version=${API.deployments}`);
  }

  // The operations only add detail: a failed read never stops the wait.
  private async reportOperations(path: string, options: WaitOptions): Promise<void> {
    if (options.onOperations === undefined) {
      return;
    }
    try {
      const rows = await this.operationRows(path);
      options.onOperations(rows.flatMap((row) => deploymentOperationOf(row) ?? []));
    } catch {
      // The next poll reads them again.
    }
  }

  async deleteResourceGroup(subscriptionId: string, resourceGroup: string): Promise<ArmOperation> {
    return this.startDelete(
      `/subscriptions/${subscriptionId}/resourcegroups/${encodeURIComponent(resourceGroup)}`,
      API.resources,
    );
  }

  async deleteServer(resourceId: string): Promise<ArmOperation> {
    return this.startDelete(resourceId, API.postgres);
  }

  async deleteStorageAccount(resourceId: string): Promise<ArmOperation> {
    return this.startDelete(resourceId, API.storage);
  }

  private async startDelete(path: string, version: string): Promise<ArmOperation> {
    const { status, headers } = await this.exchange('DELETE', `${this.base}${path}?api-version=${version}`);
    return armOperationOf(status, headers, this.base);
  }

  /**
   * Asks once how an accepted request goes on: true when Azure has finished it, false while it runs. A failed or
   * cancelled operation throws what Azure reported.
   */
  async operationDone(operation: ArmOperation): Promise<boolean> {
    if (operation.poll === undefined) {
      return true;
    }
    const { status, body } = await this.exchange('GET', operation.poll.url);
    if (operation.poll.kind === 'location') {
      return status !== 202;
    }
    const state = isObject(body) && typeof body.status === 'string' ? body.status : 'Unknown';
    if (state === 'Failed' || state === 'Canceled') {
      const failure = armFailure(armErrorOf(body) ?? { code: state, message: 'Azure did not finish it.' });
      throw new AantjeError(failure.code, failure.userMessage);
    }
    return state === 'Succeeded';
  }

  // The deployment says only "at least one resource failed"; the operation that failed says why.
  private async deploymentFailure(
    path: string,
    properties: Record<string, unknown>,
    state: string,
  ): Promise<never> {
    let reported = armErrorOf(properties);
    try {
      // The code of the failed resource matters as well as its message, so the rows are read here as they are.
      const operations = await this.operationRows(path);
      for (const operation of operations) {
        const result = isObject(operation.properties) ? operation.properties : {};
        const message = isObject(result.statusMessage) ? armErrorOf(result.statusMessage) : undefined;
        if (result.provisioningState === 'Failed' && message) {
          reported = message;
          break;
        }
      }
    } catch {
      // The deployment error alone is enough.
    }
    const failure = armFailure(reported ?? { code: state, message: 'The deployment did not complete.' });
    throw new DeploymentFailedError(failure.code, failure.userMessage);
  }

  /**
   * The newest PostgreSQL major version that the region offers to the subscription. `undefined` means the lookup
   * does not say (it failed, or names no versions at all), so the caller keeps its default; `null` means the region
   * reports versions but none that aantje deploys.
   */
  async postgresVersion(subscriptionId: string, location: string): Promise<string | null | undefined> {
    let rows: Record<string, unknown>[];
    try {
      const path = `/subscriptions/${subscriptionId}/providers/Microsoft.DBforPostgreSQL/locations/${encodeURIComponent(location)}/capabilities`;
      rows = await this.list(`${path}?api-version=${API.postgres}`);
    } catch {
      return undefined;
    }
    const offered = new Set<string>();
    for (const row of rows) {
      for (const holder of [row, ...arrayOf(row.supportedServerEditions)]) {
        for (const version of arrayOf(holder.supportedServerVersions)) {
          if (typeof version.name === 'string') offered.add(version.name);
        }
      }
    }
    if (offered.size === 0) {
      return rows.length === 0 ? null : undefined;
    }
    return POSTGRES_VERSIONS.find((version) => offered.has(version)) ?? null;
  }

  private async serverSkus(subscriptionId: string, location: string): Promise<Set<string>> {
    const path = `/subscriptions/${subscriptionId}/providers/Microsoft.DBforPostgreSQL/locations/${encodeURIComponent(location)}/capabilities`;
    const rows = await this.list(`${path}?api-version=${API.postgres}`);
    const names = new Set<string>();
    for (const row of rows) {
      for (const edition of arrayOf(row.supportedServerEditions)) {
        for (const sku of arrayOf(edition.supportedServerSkus)) {
          if (typeof sku.name === 'string') names.add(sku.name);
        }
      }
    }
    return names;
  }

  private async storageSkus(subscriptionId: string, location: string): Promise<Set<string>> {
    const rows = await this.list(
      `/subscriptions/${subscriptionId}/providers/Microsoft.Storage/skus?api-version=${API.storage}`,
    );
    const names = new Set<string>();
    for (const row of rows) {
      const here: unknown[] = Array.isArray(row.locations) ? row.locations : [];
      const restricted = arrayOf(row.restrictions).some((restriction) => restriction.type === 'Location');
      if (
        typeof row.name === 'string' &&
        row.kind === 'StorageV2' &&
        !restricted &&
        here.some((item) => String(item).toLowerCase() === location.toLowerCase())
      ) {
        names.add(row.name);
      }
    }
    return names;
  }

  private async nameProblem(
    path: string,
    version: string,
    body: { readonly name: string; readonly type: string },
    what: string,
  ): Promise<string | undefined> {
    const answer = await this.request('POST', path, { version, body });
    if (!isObject(answer) || answer.nameAvailable !== false) {
      return undefined;
    }
    return typeof answer.message === 'string' && answer.message
      ? answer.message
      : `The ${what} name "${body.name}" is not available.`;
  }

  /** All items of a list response, following `nextLink`. */
  private async list(pathAndQuery: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let url: string | undefined = pathAndQuery.startsWith('http')
      ? pathAndQuery
      : `${this.base}${pathAndQuery}`;
    while (url !== undefined) {
      const page = await this.send('GET', url);
      if (isObject(page)) {
        items.push(...arrayOf(page.value));
        // A link that leaves Azure Resource Manager would carry the token to another host.
        url =
          typeof page.nextLink === 'string' && isArmUrl(page.nextLink, this.base) ? page.nextLink : undefined;
      } else {
        url = undefined;
      }
    }
    return items;
  }

  private request(
    method: string,
    path: string,
    { version, body }: { version: string; body?: object },
  ): Promise<unknown> {
    return this.send(method, `${this.base}${path}?api-version=${version}`, body);
  }

  private async send(method: string, url: string, body?: object): Promise<unknown> {
    return (await this.exchange(method, url, body)).body;
  }

  private async exchange(method: string, url: string, body?: object): Promise<ArmResponse> {
    const started = Date.now();
    const target = `${method} ${url.startsWith(this.base) ? url.slice(this.base.length) : url}`;
    const unreachable = (cause: unknown): never => {
      this.options.debug?.(`${target}: no answer after ${Date.now() - started} ms`);
      throw new ArmUnreachableError(cause);
    };
    const response = await this.http(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.options.token()}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).catch(unreachable);
    const text = await response.text().catch(unreachable);
    const correlation = response.headers.get('x-ms-correlation-request-id');
    this.options.debug?.(
      `${target}: ${response.status} after ${Date.now() - started} ms${correlation ? ` (correlation id ${correlation})` : ''}`,
    );
    const parsed = parseJson(text);
    if (response.ok) {
      return { status: response.status, headers: response.headers, body: parsed };
    }
    const failure = armFailure(
      armErrorOf(parsed) ?? { code: `HTTP ${response.status}`, message: text.slice(0, 200) },
      response.status,
    );
    throw new ArmRequestError(failure, response.status);
  }
}

/** A failed request with its HTTP status; the poll of a deployment tolerates a few 5xx. */
export class ArmRequestError extends AantjeError {
  constructor(
    failure: AantjeError,
    readonly status: number,
  ) {
    super(failure.code, failure.userMessage);
  }
}

/** A request that got no answer (no network, a dropped connection); Azure may still have carried it out. */
export class ArmUnreachableError extends AantjeError {
  constructor(cause: unknown) {
    super('CONNECTION_FAILED', 'Azure Resource Manager could not be reached.', { cause });
  }
}

/** Azure ended the deployment as failed or cancelled; nothing of it goes on any more. */
export class DeploymentFailedError extends AantjeError {}

// A poll survives a few of these in a row: no answer, a server error, and an expired token, which the next request
// replaces because the sign-in of VS Code renews it.
export function isPassingPollFailure(error: unknown): error is ArmRequestError | ArmUnreachableError {
  return (
    error instanceof ArmUnreachableError ||
    (error instanceof ArmRequestError && (error.status >= 500 || error.status === 401))
  );
}

function deploymentPath(subscriptionId: string, resourceGroup: string, name: string): string {
  return `/subscriptions/${subscriptionId}/resourcegroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Resources/deployments/${encodeURIComponent(name)}`;
}

function outputsOf(properties: Record<string, unknown>): Record<string, unknown> {
  const outputs = isObject(properties.outputs) ? properties.outputs : {};
  return Object.fromEntries(
    Object.entries(outputs).map(([key, output]) => [key, isObject(output) ? output.value : undefined]),
  );
}

function permissionOf(row: Record<string, unknown>): Permission {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
  return { actions: strings(row.actions), notActions: strings(row.notActions) };
}

/** Whether one permission entry allows the action: some `actions` pattern matches and no `notActions` pattern does. */
export function allows(permissions: readonly Permission[], action: string): boolean {
  const matches = (patterns: readonly string[] | undefined): boolean =>
    (patterns ?? []).some((pattern) =>
      new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`, 'i').test(
        action,
      ),
    );
  return permissions.some(({ actions, notActions }) => matches(actions) && !matches(notActions));
}

function arrayOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function parseJson(text: string): unknown {
  try {
    return text === '' ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}
