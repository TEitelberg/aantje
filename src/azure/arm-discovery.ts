import { isObject } from '../guards';
import { API, arrayOf } from './arm-transport';
import type { ArmTransport } from './arm-transport';
import { SIZE_NAMES, SIZES } from './sizes';
import type { LakeSize } from './sizes';

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

/** The major versions aantje deploys, newest first. */
const POSTGRES_VERSIONS = ['17', '16', '15', '14'];

/**
 * What Azure Resource Manager tells before anything is created: tenants, subscriptions, groups and regions, free
 * names, and what a region offers. Whether the signed-in user may create a lake, Azure decides when it checks the
 * deployment.
 */
export class ArmDiscovery {
  constructor(private readonly arm: ArmTransport) {}

  async listTenants(): Promise<Named[]> {
    const rows = await this.arm.list(`/tenants?api-version=${API.tenants}`);
    return rows.flatMap((row) =>
      typeof row.tenantId === 'string'
        ? [{ id: row.tenantId, name: typeof row.displayName === 'string' ? row.displayName : row.tenantId }]
        : [],
    );
  }

  async listSubscriptions(): Promise<Subscription[]> {
    const rows = await this.arm.list(`/subscriptions?api-version=${API.subscriptions}`);
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
    const rows = await this.arm.list(
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
    const rows = await this.arm.list(
      `/subscriptions/${subscriptionId}/locations?api-version=${API.locations}`,
    );
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
      const provider = await this.arm.send(
        'GET',
        `${this.arm.base}/subscriptions/${subscriptionId}/providers/Microsoft.Resources?api-version=${API.resources}`,
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

  /** The resources of a group as `{ id, type }`. */
  async listGroupResources(
    subscriptionId: string,
    resourceGroup: string,
  ): Promise<{ id: string; type: string }[]> {
    const path = `/subscriptions/${subscriptionId}/resourcegroups/${encodeURIComponent(resourceGroup)}/resources`;
    const rows = await this.arm.list(`${path}?api-version=${API.resources}`);
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

  /** The id of the PostgreSQL flexible server with this host name in one of the subscriptions, or undefined. */
  async findPostgresServer(host: string, subscriptionIds: readonly string[]): Promise<string | undefined> {
    for (const subscriptionId of subscriptionIds) {
      const rows = await this.arm
        .list(
          `/subscriptions/${subscriptionId}/providers/Microsoft.DBforPostgreSQL/flexibleServers?api-version=${API.postgres}`,
        )
        .catch(() => []);
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

  /**
   * The newest PostgreSQL major version that the region offers to the subscription. `undefined` means the lookup
   * does not say (it failed, or names no versions at all), so the caller keeps its default; `null` means the region
   * reports versions but none that aantje deploys.
   */
  async postgresVersion(subscriptionId: string, location: string): Promise<string | null | undefined> {
    let rows: Record<string, unknown>[];
    try {
      rows = await this.postgresCapabilities(subscriptionId, location);
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

  /** What PostgreSQL flexible servers the region offers to the subscription: editions, versions and SKUs. */
  private postgresCapabilities(subscriptionId: string, location: string): Promise<Record<string, unknown>[]> {
    const path = `/subscriptions/${subscriptionId}/providers/Microsoft.DBforPostgreSQL/locations/${encodeURIComponent(location)}/capabilities`;
    return this.arm.list(`${path}?api-version=${API.postgres}`);
  }

  private async serverSkus(subscriptionId: string, location: string): Promise<Set<string>> {
    const rows = await this.postgresCapabilities(subscriptionId, location);
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
    const rows = await this.arm.list(
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
    const answer = await this.arm.request('POST', path, { version, body });
    if (!isObject(answer) || answer.nameAvailable !== false) {
      return undefined;
    }
    return typeof answer.message === 'string' && answer.message
      ? answer.message
      : `The ${what} name "${body.name}" is not available.`;
  }
}
