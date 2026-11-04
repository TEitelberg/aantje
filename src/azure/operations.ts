import { isObject } from '../guards';
import { armErrorOf } from './arm-errors';

/** One resource of a deployment, as the deployment operations of Azure report it. */
export interface DeploymentOperation {
  readonly id: string;
  /** For example `Microsoft.Storage/storageAccounts`. */
  readonly resourceType: string;
  readonly resourceName: string;
  readonly state: string;
  /** ISO 8601, for example `PT41.2S`. */
  readonly duration?: string;
  /** Why the operation failed, as Azure says it. */
  readonly message?: string;
}

/** The state of a deployment beyond its provisioning state. */
export interface DeploymentStatus {
  readonly duration?: string;
  readonly correlationId?: string;
}

/**
 * A request that Azure accepted and goes on with: `Azure-AsyncOperation` answers with a status, `Location` with 202
 * until the work is done. Without `poll` the work was done when Azure answered, or Azure gave no address to follow.
 */
export interface ArmOperation {
  readonly status: number;
  readonly poll?: { readonly url: string; readonly kind: 'status' | 'location' };
}

/** A row of `.../deployments/<name>/operations`; rows without a resource (the evaluation of outputs) are left out. */
export function deploymentOperationOf(row: Record<string, unknown>): DeploymentOperation | undefined {
  const properties = isObject(row.properties) ? row.properties : {};
  const target = isObject(properties.targetResource) ? properties.targetResource : undefined;
  if (target === undefined) {
    return undefined;
  }
  const failure = isObject(properties.statusMessage) ? armErrorOf(properties.statusMessage) : undefined;
  return {
    id: text(row.operationId) ?? text(row.id) ?? text(target.id) ?? '',
    resourceType: text(target.resourceType) ?? 'resource',
    resourceName: text(target.resourceName) ?? '',
    state: text(properties.provisioningState) ?? 'Unknown',
    duration: text(properties.duration),
    message: failure?.message,
  };
}

export function deploymentStatusOf(properties: Record<string, unknown>): DeploymentStatus {
  return { duration: text(properties.duration), correlationId: text(properties.correlationId) };
}

/** The states after which a deployment does nothing any more. */
export const TERMINAL_STATES: ReadonlySet<string> = new Set(['Succeeded', 'Failed', 'Canceled']);

/** A poll survives a few failed requests in a row (see `isPassingPollFailure`); the work itself goes on in Azure. */
export const TOLERATED_POLL_FAILURES = 3;

/**
 * Whether a URL that Azure handed out stays on Azure Resource Manager, so that the token may go with it. The slash
 * after the base keeps out a host that only starts with it (`management.azure.com.example.org`).
 */
export function isArmUrl(url: string | null | undefined, base: string): url is string {
  return url?.startsWith(`${base}/`) === true;
}

/** Where to follow an accepted request; an address that leaves Azure Resource Manager is not followed with the token. */
export function armOperationOf(status: number, headers: Headers, base: string): ArmOperation {
  const statusUrl = headers.get('azure-asyncoperation');
  const location = headers.get('location');
  if (status !== 202 && status !== 201) {
    return { status };
  }
  if (isArmUrl(statusUrl, base)) {
    return { status, poll: { url: statusUrl, kind: 'status' } };
  }
  return isArmUrl(location, base) ? { status, poll: { url: location, kind: 'location' } } : { status };
}

/** An ISO 8601 duration of Azure (`PT6M30.5S`) in words (`6 min 31 s`); undefined when it cannot be read. */
export function isoDuration(value: string | undefined): string | undefined {
  const parts =
    value === undefined ? null : /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(value);
  if (!parts) {
    return undefined;
  }
  const [, days, hours, minutes, seconds] = parts.map((part) => Number(part ?? 0));
  return elapsed(((((days ?? 0) * 24 + (hours ?? 0)) * 60 + (minutes ?? 0)) * 60 + (seconds ?? 0)) * 1000);
}

/** Milliseconds in words: `41 s`, `6 min 31 s`, `1 h 3 min`. */
export function elapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ${seconds % 60} s`;
  }
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The page of a resource (or a deployment) in the Azure portal, in the tenant of the lake. */
export function portalLink(tenantId: string, resourceId: string): string {
  return `https://portal.azure.com/#@${tenantId}/resource${resourceId}/overview`;
}

export const capitalized = (value: string): string => `${value.charAt(0).toUpperCase()}${value.slice(1)}`;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;
