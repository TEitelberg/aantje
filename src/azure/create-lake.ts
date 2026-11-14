import type { AzureAuthMode } from '../connections/profile';
import { AantjeError, isAantjeError, userMessageOf } from '../errors';
import type { Logger } from '../log';
import template from '../../deploy/azure/azuredeploy.json';
import type { ArmClient } from './arm';
import { deploymentId, DeploymentFailedError } from './arm-deployments';
import type { DeploymentRequest, WaitOptions } from './arm-deployments';
import { armReasons, deniesPermission, validationFailure } from './arm-errors';
import { FIREWALL_RULE } from './arm-firewall';
import { ArmRequestError, ArmUnreachableError } from './arm-transport';
import { decodeClaims, requireUserName } from './jwt';
import { parseLakeOutputs } from './lake-outputs';
import type { LakeOutputs } from './lake-outputs';
import { resourceNames, uniqueSuffix } from './names';
import { capitalized, elapsed, isoDuration, portalLink, TERMINAL_STATES } from './operations';
import type { DeploymentOperation, DeploymentStatus } from './operations';
import { generatePassword } from './password';
import type { PendingLake, PendingLakes } from './pending';
import type { LakeSize } from './sizes';

export interface LakeRequest {
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  /** The group does not exist yet; this run creates it, and a later delete may remove it with the lake. */
  readonly newResourceGroup: boolean;
  readonly location: string;
  readonly namePrefix: string;
  readonly size: LakeSize;
  readonly authentication: AzureAuthMode;
}

/** What a later delete needs; the registry keeps it next to the connection. */
export interface CreatedLake {
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly createdResourceGroup: boolean;
  readonly serverName: string;
  readonly storageAccountName: string;
}

export interface LakeDeps {
  readonly arm: Pick<
    ArmClient,
    | 'postgresVersion'
    | 'storageNameProblem'
    | 'serverNameProblem'
    | 'createResourceGroup'
    | 'deleteResourceGroup'
    | 'validateDeployment'
    | 'startDeployment'
    | 'waitForDeployment'
  >;
  /** A token for Azure Resource Manager; only its claims are read. */
  readonly token: () => Promise<string>;
  readonly publicIp: () => Promise<string>;
  readonly password?: () => string;
  /** Draws the suffix of the resource names; new for every run. */
  readonly suffix?: () => string;
  /** Keeps the names and the password from before the start until the caller has saved the connection. */
  readonly pending: Pick<PendingLakes, 'add' | 'remove'>;
  readonly report: (step: string) => void;
  readonly log: Logger;
}

export interface DeployedLake {
  readonly outputs: LakeOutputs;
  /** Generated for this run; the caller keeps it in the secret storage and nowhere else. Undefined with Entra authentication. */
  readonly password: string | undefined;
  readonly created: CreatedLake;
  readonly tenantId: string;
  /** The deployment, whose pending record the caller removes once the connection is saved. */
  readonly deployment: string;
}

/**
 * Checks what can be checked without cost (free names, a PostgreSQL version of the region), lets Azure check the
 * deployment (which also decides whether the account may create every resource of the template), then deploys the
 * template and waits for it. Throws a message for the user, and does not start the deployment, when a check fails.
 */
export async function deployLake(request: LakeRequest, deps: LakeDeps): Promise<DeployedLake> {
  const { arm, report } = deps;
  const { subscriptionId, resourceGroup, namePrefix } = request;
  const armToken = await deps.token();
  const { oid, tid, userName } = decodeClaims(armToken);
  const principalName = request.authentication === 'entra' ? requireUserName(armToken) : undefined;
  const suffix = (deps.suffix ?? uniqueSuffix)();
  const names = resourceNames(namePrefix, suffix);
  deps.log.info(`Signed in to Azure as ${userName ?? oid} (object id ${oid}) in the tenant ${tid}.`);

  report('Checking the names');
  const taken =
    (await arm.storageNameProblem(subscriptionId, names.storageAccount)) ??
    (await arm.serverNameProblem(subscriptionId, names.server));
  if (taken) {
    throw new AantjeError('INVALID_PROFILE', `The name is not free: ${taken} Choose another name.`);
  }

  const postgresVersion = await arm.postgresVersion(subscriptionId, request.location);
  if (postgresVersion === null) {
    throw new AantjeError(
      'INVALID_PROFILE',
      `The region "${request.location}" offers no PostgreSQL flexible server to this subscription. Choose another region.`,
    );
  }
  deps.log.info(
    `Checks passed: the names are free (server "${names.server}", storage account "${names.storageAccount}"), PostgreSQL ${postgresVersion ?? 'of the template'}.`,
  );

  report('Looking up your public IP address');
  const clientIp = await deps.publicIp();
  deps.log.info(`The firewall rule "${FIREWALL_RULE}" lets ${clientIp} reach the server.`);

  if (request.newResourceGroup) {
    report(`Creating the resource group "${resourceGroup}"`);
    await arm.createResourceGroup(subscriptionId, resourceGroup, request.location);
    deps.log.info(`Created the resource group "${resourceGroup}" in ${request.location}.`);
  }

  // The server needs a local administrator password even when Entra is the way in. With Entra nobody keeps it: the
  // local login stays as break-glass access once an owner resets the password in the portal.
  const password = (deps.password ?? generatePassword)();
  const entra = request.authentication === 'entra';
  const pending: PendingLake = {
    subscriptionId,
    resourceGroup,
    createdResourceGroup: request.newResourceGroup,
    deployment: `aantje-lake-${suffix}`,
    namePrefix,
    serverName: names.server,
    storageAccountName: names.storageAccount,
    authentication: request.authentication,
    tenantId: tid,
  };
  const deployment: DeploymentRequest = {
    template,
    parameters: {
      namePrefix,
      size: request.size,
      principalId: oid,
      principalType: 'User',
      clientIp,
      administratorLoginPassword: password,
      authentication: request.authentication,
      ...(principalName === undefined ? {} : { principalName }),
      location: request.location,
      uniqueSuffix: suffix,
      ...(postgresVersion === undefined ? {} : { postgresVersion }),
    },
  };
  await checkDeployment(request, pending.deployment, deployment, deps);
  // Kept before the start: if waiting breaks off, the deployment goes on in Azure and only these tell how to finish it.
  await deps.pending.add(pending, entra ? undefined : password);
  report('Starting the deployment');
  try {
    await arm.startDeployment(subscriptionId, resourceGroup, pending.deployment, deployment);
  } catch (error) {
    // Without an answer the deployment may have started; any other failure means that nothing runs.
    if (error instanceof ArmUnreachableError) {
      throw stillRunning(error, pending, 'may have started');
    }
    await deps.pending.remove(pending.deployment);
    throw request.newResourceGroup ? await withoutNewGroup(error, request, deps) : error;
  }
  deps.log.info(
    `Started the deployment "${pending.deployment}" in the resource group "${resourceGroup}": ${portalLink(tid, deploymentId(pending.subscriptionId, pending.resourceGroup, pending.deployment))}`,
  );
  return deployedLake(pending, await waitForLake(pending, deps), entra ? undefined : password);
}

/**
 * Azure's check of the deployment before it starts, with the request that starts it. Azure decides there, among other
 * things, whether the account may create every resource of the template, the role assignment included; aantje does not
 * evaluate permissions itself. A refusal stops the run before anything is deployed, and a resource group that this run
 * created is deleted again.
 */
async function checkDeployment(
  request: LakeRequest,
  name: string,
  deployment: DeploymentRequest,
  deps: LakeDeps,
): Promise<void> {
  deps.report('Letting Azure check the deployment');
  try {
    await deps.arm.validateDeployment(request.subscriptionId, request.resourceGroup, name, deployment);
  } catch (error) {
    const refused = validationRefusal(error, request);
    throw request.newResourceGroup ? await withoutNewGroup(refused, request, deps) : refused;
  }
  deps.log.info(`Azure's check of the deployment "${name}" passed.`);
}

// A refused permission gets the roles that the template needs; any other refusal says what Azure said.
function validationRefusal(error: unknown, request: LakeRequest): unknown {
  if (!(error instanceof ArmRequestError) || error.armError === undefined) {
    return error;
  }
  if (!deniesPermission(error.armError)) {
    return validationFailure(error.armError, error.status);
  }
  const where = request.newResourceGroup
    ? ' in this subscription'
    : ` in the resource group "${request.resourceGroup}"`;
  return new AantjeError(
    'AUTH_FAILED',
    `Azure's check before the deployment refused your account a permission${where}. The lake includes a role assignment that gives you access to the data files: ask for the role Owner or User Access Administrator, or choose another resource group. That check may miss a role that your account has only through a management group; assigning the role on the subscription or the resource group helps then. Azure said: ${armReasons(error.armError)}`,
    { cause: error },
  );
}

// Azure refused the start, so the resource group that this run created holds nothing: delete it rather than leave an
// empty group behind that blocks the same name next time. The deletion goes on in Azure; the message says so.
async function withoutNewGroup(error: unknown, request: LakeRequest, deps: LakeDeps): Promise<unknown> {
  const group = request.resourceGroup;
  let note: string;
  try {
    await deps.arm.deleteResourceGroup(request.subscriptionId, group);
    deps.log.info(`Deleting the empty resource group "${group}" that this run created.`);
    note = `aantje deletes the empty resource group "${group}" that it created for this run.`;
  } catch (cause) {
    deps.log.warn(`The empty resource group "${group}" could not be deleted: ${userMessageOf(cause)}`);
    note = `The resource group "${group}" that aantje created for this run stays empty; delete it in the Azure portal.`;
  }
  return isAantjeError(error)
    ? new AantjeError(error.code, `${error.userMessage} ${note}`, { cause: error })
    : error;
}

export interface WaitDeps {
  readonly arm: Pick<ArmClient, 'waitForDeployment'>;
  readonly pending: Pick<PendingLakes, 'remove'>;
  readonly report: (step: string) => void;
  readonly log: Logger;
}

/**
 * Waits for a started deployment and returns its outputs. When Azure ends it as failed, or does not know it, nothing
 * runs any more and the pending record goes; when waiting breaks off, the record stays and the message says how to
 * finish.
 */
export async function waitForLake(lake: PendingLake, deps: WaitDeps): Promise<Record<string, unknown>> {
  try {
    return await deps.arm.waitForDeployment(
      lake.subscriptionId,
      lake.resourceGroup,
      lake.deployment,
      deploymentLog(lake.deployment, deps),
    );
  } catch (error) {
    if (error instanceof DeploymentFailedError) {
      await deps.pending.remove(lake.deployment);
      throw new AantjeError(
        error.code,
        `${error.userMessage} Resources that the deployment created stay in the resource group "${lake.resourceGroup}" and cost money until you delete them in the Azure portal.`,
      );
    }
    if (error instanceof ArmRequestError && error.status === 404) {
      await deps.pending.remove(lake.deployment);
      throw new AantjeError(
        'CONNECTION_FAILED',
        `The deployment "${lake.deployment}" is not in the resource group "${lake.resourceGroup}": it never started, or it was deleted. aantje forgets it.`,
      );
    }
    throw stillRunning(error, lake, 'goes on');
  }
}

/** The lake of a deployment that has succeeded; the password is the one generated for it, if any. */
export function deployedLake(
  lake: PendingLake,
  outputs: Record<string, unknown>,
  password: string | undefined,
): DeployedLake {
  return {
    outputs: parseLakeOutputs(outputs.ducklake),
    password,
    tenantId: lake.tenantId,
    deployment: lake.deployment,
    created: {
      subscriptionId: lake.subscriptionId,
      resourceGroup: lake.resourceGroup,
      createdResourceGroup: lake.createdResourceGroup,
      // What the template made, not what aantje expected: a delete acts on these names.
      serverName: nameOf(outputs.postgresServerName, lake.serverName),
      storageAccountName: nameOf(outputs.storageAccountName, lake.storageAccountName),
    },
  };
}

function stillRunning(error: unknown, lake: PendingLake, state: 'goes on' | 'may have started'): AantjeError {
  const said = isAantjeError(error) ? error.userMessage : 'Waiting for the deployment failed.';
  const where = `the deployment "${lake.deployment}" in the resource group "${lake.resourceGroup}"`;
  return new AantjeError(
    isAantjeError(error) ? error.code : 'CONNECTION_FAILED',
    `${said} ${state === 'goes on' ? `${capitalized(where)} goes on in Azure.` : `If ${where} has started, it goes on in Azure.`} Run "aantje: Finish Creating Azure DuckLake..." to wait for it again and add the connection.`,
    { cause: error },
  );
}

// The progress shows each poll; the log shows each change of the state and each resource once it has ended.
function deploymentLog(
  deployment: string,
  deps: Pick<WaitDeps, 'report' | 'log'>,
): Pick<WaitOptions, 'onState' | 'onOperations' | 'onRetry'> {
  let last: string | undefined;
  const ended = new Set<string>();
  return {
    onState: (state, status) => {
      deps.report(`Deployment: ${state}`);
      if (state !== last) {
        last = state;
        if (state === 'Failed' || state === 'Canceled') {
          deps.log.warn(stateLine(deployment, state, status));
        } else {
          deps.log.info(stateLine(deployment, state, status));
        }
      }
    },
    onOperations: (operations) => {
      for (const operation of operations.filter(
        ({ id, state }) => TERMINAL_STATES.has(state) && !ended.has(id),
      )) {
        ended.add(operation.id);
        if (operation.state === 'Succeeded') {
          deps.log.info(operationLine(operation));
        } else {
          deps.log.warn(operationLine(operation));
        }
      }
    },
    onRetry: (error, pauseMs) =>
      deps.log.warn(
        `No answer while waiting for the deployment "${deployment}" (${error.userMessage}); asking again in ${elapsed(pauseMs)}.`,
      ),
  };
}

function stateLine(deployment: string, state: string, status: DeploymentStatus): string {
  const took = isoDuration(status.duration);
  const after = TERMINAL_STATES.has(state) && took !== undefined ? ` after ${took}` : '';
  const correlation =
    TERMINAL_STATES.has(state) && status.correlationId ? ` (correlation id ${status.correlationId})` : '';
  return `Deployment "${deployment}": ${state}${after}${correlation}.`;
}

function operationLine(operation: DeploymentOperation): string {
  const took = isoDuration(operation.duration);
  return `Resource ${operation.resourceType} "${operation.resourceName}": ${operation.state}${took === undefined ? '' : ` after ${took}`}${operation.message ? `: ${operation.message}` : '.'}`;
}

const nameOf = (output: unknown, expected: string): string =>
  typeof output === 'string' ? output : expected;
