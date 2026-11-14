import { ArmDeployments } from './arm-deployments';
import type { DeploymentRequest, WaitOptions } from './arm-deployments';
import { ArmDiscovery } from './arm-discovery';
import type { Location, Named, ResourceGroup, Subscription } from './arm-discovery';
import { ArmFirewall } from './arm-firewall';
import { ArmTransport } from './arm-transport';
import type { ArmOptions } from './arm-transport';
import type { ArmOperation } from './operations';
import type { LakeSize } from './sizes';

/** The scope of the token that Azure Resource Manager accepts. */
export const ARM_SCOPE = 'https://management.azure.com/.default';
/** The scope of the token that Azure Storage accepts (Entra access to the data files). */
export const STORAGE_SCOPE = 'https://storage.azure.com/.default';

/** The scope of the token that Azure Database for PostgreSQL accepts as the password of an Entra user. */
export const POSTGRES_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

/**
 * The part of Azure Resource Manager that creating and deleting a lake needs. Every call is a documented REST API. One
 * transport carries the requests of the three parts: discovery, deployments and the firewall.
 */
export class ArmClient {
  private readonly discovery: ArmDiscovery;
  private readonly deployments: ArmDeployments;
  private readonly firewall: ArmFirewall;

  constructor(options: ArmOptions) {
    const transport = new ArmTransport(options);
    this.discovery = new ArmDiscovery(transport);
    this.deployments = new ArmDeployments(transport);
    this.firewall = new ArmFirewall(transport);
  }

  listTenants(): Promise<Named[]> {
    return this.discovery.listTenants();
  }

  listSubscriptions(): Promise<Subscription[]> {
    return this.discovery.listSubscriptions();
  }

  listResourceGroups(subscriptionId: string): Promise<ResourceGroup[]> {
    return this.discovery.listResourceGroups(subscriptionId);
  }

  listLocations(subscriptionId: string): Promise<Location[]> {
    return this.discovery.listLocations(subscriptionId);
  }

  listGroupResources(subscriptionId: string, resourceGroup: string): Promise<{ id: string; type: string }[]> {
    return this.discovery.listGroupResources(subscriptionId, resourceGroup);
  }

  storageNameProblem(subscriptionId: string, name: string): Promise<string | undefined> {
    return this.discovery.storageNameProblem(subscriptionId, name);
  }

  serverNameProblem(subscriptionId: string, name: string): Promise<string | undefined> {
    return this.discovery.serverNameProblem(subscriptionId, name);
  }

  findPostgresServer(host: string, subscriptionIds: readonly string[]): Promise<string | undefined> {
    return this.discovery.findPostgresServer(host, subscriptionIds);
  }

  sizeProblems(subscriptionId: string, location: string): Promise<Partial<Record<LakeSize, string>>> {
    return this.discovery.sizeProblems(subscriptionId, location);
  }

  postgresVersion(subscriptionId: string, location: string): Promise<string | null | undefined> {
    return this.discovery.postgresVersion(subscriptionId, location);
  }

  createResourceGroup(subscriptionId: string, name: string, location: string): Promise<void> {
    return this.deployments.createResourceGroup(subscriptionId, name, location);
  }

  validateDeployment(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    request: DeploymentRequest,
  ): Promise<void> {
    return this.deployments.validateDeployment(subscriptionId, resourceGroup, name, request);
  }

  startDeployment(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    request: DeploymentRequest,
  ): Promise<void> {
    return this.deployments.startDeployment(subscriptionId, resourceGroup, name, request);
  }

  waitForDeployment(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    options?: WaitOptions,
  ): Promise<Record<string, unknown>> {
    return this.deployments.waitForDeployment(subscriptionId, resourceGroup, name, options);
  }

  deleteResourceGroup(subscriptionId: string, resourceGroup: string): Promise<ArmOperation> {
    return this.deployments.deleteResourceGroup(subscriptionId, resourceGroup);
  }

  deleteServer(resourceId: string): Promise<ArmOperation> {
    return this.deployments.deleteServer(resourceId);
  }

  deleteStorageAccount(resourceId: string): Promise<ArmOperation> {
    return this.deployments.deleteStorageAccount(resourceId);
  }

  operationDone(operation: ArmOperation): Promise<boolean> {
    return this.deployments.operationDone(operation);
  }

  allowIp(serverId: string, ip: string): Promise<'created' | 'updated' | 'unchanged'> {
    return this.firewall.allowIp(serverId, ip);
  }
}
