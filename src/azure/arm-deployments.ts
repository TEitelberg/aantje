import { AantjeError } from '../errors';
import { isObject } from '../guards';
import { armErrorOf, armFailure } from './arm-errors';
import { API, ArmRequestError } from './arm-transport';
import type { ArmTransport } from './arm-transport';
import { armOperationOf, deploymentOperationOf, deploymentStatusOf, TERMINAL_STATES } from './operations';
import type { ArmOperation, DeploymentOperation, DeploymentStatus } from './operations';
import { pollUntil } from './poll';
import type { PollOptions } from './poll';

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
  readonly onRetry?: PollOptions['onRetry'];
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 45 * 60_000;
const VALIDATE_TIMEOUT_MS = 10 * 60_000;

/** Azure ended the deployment as failed or cancelled; nothing of it goes on any more. */
export class DeploymentFailedError extends AantjeError {}

/** The ARM id of a deployment in a resource group, also the path of its requests. */
export function deploymentId(subscriptionId: string, resourceGroup: string, name: string): string {
  return `/subscriptions/${subscriptionId}/resourcegroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Resources/deployments/${encodeURIComponent(name)}`;
}

/** The body of a deployment; its start and its validation send the same. */
function deploymentBody(request: DeploymentRequest): object {
  const parameters = Object.fromEntries(
    Object.entries(request.parameters).map(([key, value]) => [key, { value }]),
  );
  return { properties: { mode: 'Incremental', template: request.template, parameters } };
}

/** Throws the refusal of an answer to a validation that carries an `error`, as a failed request would. */
function refuseFailedValidation(status: number, body: unknown, state?: string): void {
  if (isObject(body) && isObject(body.error)) {
    throw new ArmRequestError(
      armFailure(armErrorOf(body) ?? { code: 'Unknown', message: '' }, status),
      status,
      body.error,
    );
  }
  if (state !== undefined) {
    throw new ArmRequestError(
      armFailure({ code: state, message: 'Azure did not finish the check.' }, status),
      status,
    );
  }
}

/**
 * What creates and deletes a lake: the resource group, the deployment of the template and the poll that follows it,
 * and the deletes, which Azure accepts and finishes later.
 */
export class ArmDeployments {
  constructor(private readonly arm: ArmTransport) {}

  async createResourceGroup(subscriptionId: string, name: string, location: string): Promise<void> {
    await this.arm.request(
      'PUT',
      `/subscriptions/${subscriptionId}/resourcegroups/${encodeURIComponent(name)}`,
      {
        version: API.resources,
        body: { location },
      },
    );
  }

  /**
   * Azure's check of a deployment before it starts (its preflight validation): the request of `startDeployment`, to
   * `.../validate` at the same scope and API version. It creates nothing. Azure checks the template, the parameters and
   * whether the caller may create every resource of the template. A refusal throws `ArmRequestError` with Azure's
   * error; an answer that Azure gives later (202) is waited for. A 202 without an address to follow counts as passed:
   * the start runs the same check.
   */
  async validateDeployment(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    request: DeploymentRequest,
  ): Promise<void> {
    const { status, headers, body } = await this.arm.exchange(
      'POST',
      `${this.arm.base}${deploymentId(subscriptionId, resourceGroup, name)}/validate?api-version=${API.deployments}`,
      deploymentBody(request),
    );
    refuseFailedValidation(status, body);
    const { poll } = armOperationOf(status, headers, this.arm.base);
    if (poll === undefined) {
      return;
    }
    await pollUntil(
      async () => {
        const answer = await this.arm.exchange('GET', poll.url);
        if (poll.kind === 'location') {
          refuseFailedValidation(answer.status, answer.body);
          return answer.status === 202 ? undefined : true;
        }
        const state = isObject(answer.body) ? answer.body.status : undefined;
        if (state === 'Failed' || state === 'Canceled') {
          refuseFailedValidation(answer.status, answer.body, String(state));
        }
        return state === 'Succeeded' ? true : undefined;
      },
      {
        pollMs: DEFAULT_POLL_MS,
        timeoutMs: VALIDATE_TIMEOUT_MS,
        sleep: this.arm.sleep,
        onTimeout: () =>
          new AantjeError('TIMEOUT', "Azure's check of the deployment takes longer than expected."),
      },
    );
  }

  /** Starts a deployment; it runs on in Azure, `waitForDeployment` follows it. */
  async startDeployment(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    request: DeploymentRequest,
  ): Promise<void> {
    await this.arm.request('PUT', `${deploymentId(subscriptionId, resourceGroup, name)}`, {
      version: API.deployments,
      body: deploymentBody(request),
    });
  }

  /** Polls until the deployment ends; returns its outputs by name, or throws what Azure reported. */
  async waitForDeployment(
    subscriptionId: string,
    resourceGroup: string,
    name: string,
    options: WaitOptions = {},
  ): Promise<Record<string, unknown>> {
    const path = deploymentId(subscriptionId, resourceGroup, name);
    return pollUntil(
      async () => {
        const body = await this.arm.request('GET', path, { version: API.deployments });
        const properties = isObject(body) && isObject(body.properties) ? body.properties : {};
        const state =
          typeof properties.provisioningState === 'string' ? properties.provisioningState : 'Unknown';
        await this.reportOperations(path, options);
        options.onState?.(state, deploymentStatusOf(properties));
        if (!TERMINAL_STATES.has(state)) {
          return undefined;
        }
        return state === 'Succeeded'
          ? outputsOf(properties)
          : await this.deploymentFailure(path, properties, state);
      },
      {
        pollMs: options.pollMs ?? DEFAULT_POLL_MS,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        sleep: this.arm.sleep,
        onRetry: options.onRetry,
        onTimeout: () => new AantjeError('TIMEOUT', 'The deployment takes longer than expected.'),
      },
    );
  }

  /** The rows of `.../deployments/<name>/operations`: one per resource of the template, with state and duration. */
  private operationRows(path: string): Promise<Record<string, unknown>[]> {
    return this.arm.list(`${path}/operations?api-version=${API.deployments}`);
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
    const { status, headers } = await this.arm.exchange(
      'DELETE',
      `${this.arm.base}${path}?api-version=${version}`,
    );
    return armOperationOf(status, headers, this.arm.base);
  }

  /**
   * Asks once how an accepted request goes on: true when Azure has finished it, false while it runs. A failed or
   * cancelled operation throws what Azure reported.
   */
  async operationDone(operation: ArmOperation): Promise<boolean> {
    if (operation.poll === undefined) {
      return true;
    }
    const { status, body } = await this.arm.exchange('GET', operation.poll.url);
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
}

function outputsOf(properties: Record<string, unknown>): Record<string, unknown> {
  const outputs = isObject(properties.outputs) ? properties.outputs : {};
  return Object.fromEntries(
    Object.entries(outputs).map(([key, output]) => [key, isObject(output) ? output.value : undefined]),
  );
}
