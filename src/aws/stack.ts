// The checks before a lake is created, the change set, the stack, the wait and the cleanup of a failed creation. Free
// of the VS Code API; `AwsApi` is the only way to AWS.
import { AantjeError } from '../errors';
import type { Logger } from '../log';
import { generatePassword } from '../azure/password';
import { elapsed } from '../azure/operations';
import { stackConsoleLink } from './api';
import type { AwsApi, AwsIdentity, ResourceChange, StackEvent, StackState } from './api';
import { awsMessageOf, isAccessDenied, isPassingAwsFailure } from './errors';
import { lakeNames, uniqueSuffix } from './names';
import { parseAwsLakeOutputs } from './outputs';
import type { AwsLakeOutputs } from './outputs';
import type { PendingAwsLake, PendingAwsLakes } from './pending';
import { CREATE_ACTIONS, principalOf } from './permissions';
import type { CreatedAwsLake } from './registry';
import { AWS_SIZES } from './sizes';
import type { AwsLakeSize } from './sizes';

export interface AwsLakeRequest {
  /** The profile of the AWS configuration; undefined: the credentials of the environment. */
  readonly awsProfile: string | undefined;
  readonly identity: AwsIdentity;
  readonly lakeName: string;
  readonly size: AwsLakeSize;
  readonly postgresMajor: number;
  readonly clientIp: string;
  /** How PostgreSQL is signed in to: the generated password, or IAM database authentication as ducklake_iam. */
  readonly authentication: 'password' | 'iam';
}

export interface StackDeps {
  readonly api: AwsApi;
  /** The body of `deploy/aws/template.yaml`. */
  readonly template: string;
  readonly pending: Pick<PendingAwsLakes, 'add' | 'remove'>;
  /** Shows what the change set creates and asks to create it. */
  readonly confirm: (
    changes: readonly ResourceChange[],
    names: { stack: string; bucket: string },
  ) => Promise<boolean>;
  /** Asks whether to go on although a check failed or could not run. */
  readonly goOn: (problem: string) => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly report: (step: string) => void;
  readonly log: Logger;
  readonly password?: () => string;
  readonly suffix?: () => string;
  /** Milliseconds since some start, for the time limit of the wait. */
  readonly clock?: () => number;
}

export interface DeployedAwsLake {
  readonly outputs: AwsLakeOutputs;
  /** Generated for this run; the caller keeps it in the secret storage and nowhere else. */
  readonly password: string | undefined;
  readonly created: CreatedAwsLake;
}

/** The default quota of VPCs per region, for when Service Quotas cannot be read. */
const DEFAULT_VPC_QUOTA = 5;
const CHANGE_SET = 'aantje-create';
const CHANGE_SET_POLL_MS = 3_000;
const CHANGE_SET_TIMEOUT_MS = 5 * 60_000;
const STACK_POLL_MS = 15_000;
const STACK_TIMEOUT_MS = 60 * 60_000;
const TOLERATED_POLL_FAILURES = 3;

/**
 * Checks what can be checked before anything is created (free names, quotas, the permissions), creates the change set
 * and shows it; on yes it executes the change set and waits for the stack. Returns undefined when the user stops.
 */
export async function createAwsLake(
  request: AwsLakeRequest,
  deps: StackDeps,
): Promise<DeployedAwsLake | undefined> {
  const { api, report, log } = deps;
  const names = lakeNames(request.lakeName, (deps.suffix ?? uniqueSuffix)());

  report('Checking the names');
  if (await api.describeStack(names.stack)) {
    throw new AantjeError(
      'INVALID_PROFILE',
      `A stack "${names.stack}" exists in ${api.region}. Run the command again.`,
    );
  }
  if (await api.bucketTaken(names.bucket)) {
    throw new AantjeError(
      'INVALID_PROFILE',
      `The bucket name "${names.bucket}" is taken. Run the command again.`,
    );
  }

  report('Checking the quotas');
  if (!(await quotasAllow(api, deps))) return undefined;

  report('Checking your permissions');
  const principalArn = await principalArnOf(request.identity, api, log);
  const actions = request.authentication === 'iam' ? [...CREATE_ACTIONS, 'rds-db:connect'] : CREATE_ACTIONS;
  if (!(await permissionsAllow(request.identity, principalArn, actions, api, deps))) return undefined;
  log.info(
    `Checks passed in ${api.region}: stack "${names.stack}" and bucket "${names.bucket}" are free, PostgreSQL ${request.postgresMajor}.`,
  );

  report('Creating the change set');
  const password = (deps.password ?? generatePassword)();
  const { stackId, changeSetId } = await api.createChangeSet({
    stackName: names.stack,
    changeSetName: CHANGE_SET,
    templateBody: deps.template,
    parameters: {
      LakeName: request.lakeName,
      Size: request.size,
      PostgresVersion: String(request.postgresMajor),
      BucketName: names.bucket,
      ClientIp: request.clientIp,
      MasterPassword: password,
      IamAuthentication: String(request.authentication === 'iam'),
      PrincipalArn: principalArn ?? '',
    },
    tags: { 'aantje:lake': request.lakeName },
    description: `Create AWS DuckLake "${request.lakeName}" (aantje)`,
  });
  log.info(`Created the change set of the stack "${names.stack}": ${stackConsoleLink(api.region, stackId)}`);
  const changes = await changeSetReady(api, stackId, changeSetId, deps);
  if (!(await deps.confirm(changes, names))) {
    await deleteQuietly(api, stackId, log);
    log.info(
      `Create AWS DuckLake "${request.lakeName}" stopped before the change set ran; the stack is deleted.`,
    );
    return undefined;
  }

  const pending: PendingAwsLake = {
    account: request.identity.account,
    region: api.region,
    ...(request.awsProfile === undefined ? {} : { awsProfile: request.awsProfile }),
    stackId,
    stackName: names.stack,
    lakeName: request.lakeName,
    bucket: names.bucket,
    ...(request.authentication === 'iam' ? { authentication: 'iam' as const } : {}),
  };
  // Kept before the start: if waiting breaks off, the stack goes on in AWS and only these tell how to finish it.
  await deps.pending.add(pending, password);
  report('Starting the stack');
  try {
    await api.executeChangeSet(changeSetId);
  } catch (error) {
    if (isPassingAwsFailure(error)) throw stillRunning(error, pending, 'may have started');
    await deps.pending.remove(stackId);
    await deleteQuietly(api, stackId, log);
    throw error;
  }
  log.info(`Started the stack "${names.stack}" in ${api.region} (${AWS_SIZES[request.size].description}).`);
  const outputs = await waitForStack(pending, deps);
  return deployedAwsLake(pending, outputs, password);
}

/** The lake of a stack that has been created; the password is the one generated for it, if any. */
export function deployedAwsLake(
  lake: PendingAwsLake,
  outputs: Readonly<Record<string, string>>,
  password: string | undefined,
): DeployedAwsLake {
  const parsed = parseAwsLakeOutputs(outputs.ducklake);
  return {
    outputs: parsed,
    password,
    created: {
      account: lake.account,
      region: lake.region,
      ...(lake.awsProfile === undefined ? {} : { awsProfile: lake.awsProfile }),
      stackId: lake.stackId,
      stackName: lake.stackName,
      // What the stack made, not what aantje expected: a delete acts on it.
      bucket: outputs.BucketName ?? parsed.bucket,
    },
  };
}

async function quotasAllow(api: AwsApi, deps: Pick<StackDeps, 'goOn' | 'log'>): Promise<boolean> {
  const instances = await api.instanceQuota().catch((error: unknown) => {
    deps.log.warn(`The quota of DB instances could not be read: ${awsMessageOf(error, undefined)}`);
    return undefined;
  });
  if (instances && instances.used >= instances.max) {
    throw new AantjeError(
      'INVALID_PROFILE',
      `The account has ${instances.used} of ${instances.max} DB instances in ${api.region}. Ask for a higher quota in Service Quotas, or choose another region.`,
    );
  }
  const vpcs = await api.vpcQuota().catch((error: unknown) => {
    deps.log.warn(`The VPCs could not be counted: ${awsMessageOf(error, undefined)}`);
    return undefined;
  });
  if (vpcs?.max !== undefined && vpcs.used >= vpcs.max) {
    throw new AantjeError(
      'INVALID_PROFILE',
      `The account has ${vpcs.used} of ${vpcs.max} VPCs in ${api.region}, and the lake needs one of its own. Ask for a higher quota in Service Quotas, or choose another region.`,
    );
  }
  if (vpcs?.max === undefined && vpcs !== undefined && vpcs.used >= DEFAULT_VPC_QUOTA) {
    return deps.goOn(
      `The account has ${vpcs.used} VPCs in ${api.region}; the default quota is ${DEFAULT_VPC_QUOTA}, and aantje could not read yours. Unless it was raised, the creation fails and is rolled back. Go on?`,
    );
  }
  return true;
}

/** The ARN that the bucket policy grants and the simulation checks: an IAM user, or the role of an assumed role. */
async function principalArnOf(identity: AwsIdentity, api: AwsApi, log: Logger): Promise<string | undefined> {
  const principal = principalOf(identity.arn);
  switch (principal.kind) {
    case 'user':
      return principal.arn;
    case 'role': {
      const arn = await api.roleArn(principal.roleName);
      if (arn === undefined) {
        log.warn(
          `The ARN of the role "${principal.roleName}" could not be read (iam:GetRole); the bucket policy grants it nothing, and the IAM policies of the account decide.`,
        );
      }
      return arn;
    }
    default:
      log.info(`${identity.arn} gets no grant of its own in the bucket policy.`);
      return undefined;
  }
}

async function permissionsAllow(
  identity: AwsIdentity,
  principalArn: string | undefined,
  actions: readonly string[],
  api: AwsApi,
  deps: Pick<StackDeps, 'goOn' | 'log'>,
): Promise<boolean> {
  if (principalOf(identity.arn).kind === 'root') return true;
  if (principalArn === undefined) {
    return deps.goOn(
      `aantje could not check your permissions: IAM's policy simulation needs the ARN of ${identity.arn}, which could not be read. If a permission is missing, the creation fails and is rolled back. Go on?`,
    );
  }
  let denied: string[];
  try {
    denied = await api.deniedActions(principalArn, actions);
  } catch (error) {
    if (!isAccessDenied(error)) throw error;
    return deps.goOn(
      `aantje could not check your permissions: ${principalArn} may not run IAM's policy simulation (iam:SimulatePrincipalPolicy). If a permission is missing, the creation fails and is rolled back. Go on?`,
    );
  }
  if (denied.length === 0) {
    deps.log.info(`IAM's policy simulation allows ${principalArn} every action that the creation needs.`);
    return true;
  }
  deps.log.warn(`IAM's policy simulation denies ${principalArn}: ${denied.join(', ')}.`);
  const shown = denied.slice(0, 8).join(', ');
  return deps.goOn(
    `IAM's policy simulation says that ${principalArn} may not: ${shown}${denied.length > 8 ? ` and ${denied.length - 8} more (see the output)` : ''}. The creation would fail and be rolled back. The simulation does not see everything (service control policies, some conditions). Create anyway?`,
  );
}

/** Waits until CloudFormation has computed the change set; a failed one deletes its stack and says why. */
async function changeSetReady(
  api: AwsApi,
  stackId: string,
  changeSetId: string,
  deps: Pick<StackDeps, 'sleep' | 'log' | 'clock'>,
): Promise<readonly ResourceChange[]> {
  for (let waited = 0; ; waited += CHANGE_SET_POLL_MS) {
    const state = await api.describeChangeSet(changeSetId);
    if (state.status === 'CREATE_COMPLETE') return state.changes;
    if (state.status === 'FAILED' || state.status === 'DELETE_COMPLETE' || waited >= CHANGE_SET_TIMEOUT_MS) {
      await deleteQuietly(api, stackId, deps.log);
      throw new AantjeError(
        'CONNECTION_FAILED',
        `CloudFormation could not prepare the stack: ${state.reason ?? `the change set is ${state.status}`}. Nothing was created.`,
      );
    }
    await deps.sleep(CHANGE_SET_POLL_MS);
  }
}

export interface WaitDeps {
  readonly api: AwsApi;
  readonly pending: Pick<PendingAwsLakes, 'remove'>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly report: (step: string) => void;
  readonly log: Logger;
  readonly clock?: () => number;
}

/**
 * Waits for a started stack and returns its outputs. A creation that failed is rolled back by CloudFormation; aantje
 * then deletes the stack and says which resource failed and why. When waiting breaks off, the record stays and the
 * message says how to finish.
 */
export async function waitForStack(
  lake: PendingAwsLake,
  deps: WaitDeps,
): Promise<Readonly<Record<string, string>>> {
  const { api, log } = deps;
  const clock = deps.clock ?? (() => performance.now());
  const started = clock();
  const seen: StackEvent[] = [];
  let lastEvent: string | undefined;
  let lastStatus: string | undefined;
  let failures = 0;
  for (;;) {
    let stack: StackState | undefined;
    try {
      stack = await api.describeStack(lake.stackId);
      const events = await api.stackEvents(lake.stackId, lastEvent);
      for (const event of events) logEvent(event, log);
      seen.push(...events);
      lastEvent = events.at(-1)?.id ?? lastEvent;
      failures = 0;
    } catch (error) {
      if (!isPassingAwsFailure(error) || ++failures > TOLERATED_POLL_FAILURES) {
        throw stillRunning(error, lake, 'goes on');
      }
      log.warn(
        `No answer while waiting for the stack "${lake.stackName}" (${awsMessageOf(error, lake.awsProfile)}); asking again.`,
      );
    }
    if (stack !== undefined || failures === 0) {
      if (stack === undefined) {
        await deps.pending.remove(lake.stackId);
        throw new AantjeError(
          'CONNECTION_FAILED',
          `The stack "${lake.stackName}" is not in ${lake.region}: it was deleted. aantje forgets it.`,
        );
      }
      if (stack.status !== lastStatus) {
        lastStatus = stack.status;
        log.info(`Stack "${lake.stackName}": ${stack.status} after ${elapsed(clock() - started)}.`);
      }
      deps.report(`Stack: ${stack.status}`);
      if (stack.status === 'CREATE_COMPLETE') {
        await protect(lake, deps);
        return stack.outputs;
      }
      if (stack.status === 'REVIEW_IN_PROGRESS') return neverStarted(lake, deps);
      if (
        /(ROLLBACK_COMPLETE|ROLLBACK_FAILED|CREATE_FAILED|DELETE_)/.test(stack.status) &&
        !stack.status.endsWith('_IN_PROGRESS')
      ) {
        return failed(lake, stack, seen, deps);
      }
    }
    if (clock() - started >= STACK_TIMEOUT_MS) {
      throw stillRunning(
        new AantjeError('CONNECTION_FAILED', `The stack was not ready after ${elapsed(STACK_TIMEOUT_MS)}.`),
        lake,
        'goes on',
      );
    }
    await deps.sleep(STACK_POLL_MS * 2 ** failures);
  }
}

/**
 * Termination protection, once the stack is complete: earlier it would keep aantje from deleting a stack that rolled
 * back. A failure is logged; the lake works without it.
 */
async function protect(lake: PendingAwsLake, deps: WaitDeps): Promise<void> {
  try {
    await deps.api.setTerminationProtection(lake.stackId, true);
    deps.log.info(`Switched on the termination protection of the stack "${lake.stackName}".`);
  } catch (error) {
    deps.log.warn(
      `The termination protection of the stack "${lake.stackName}" could not be switched on: ${awsMessageOf(error, lake.awsProfile)}`,
    );
  }
}

/** A stack whose change set never ran: it holds nothing, so it goes. */
async function neverStarted(lake: PendingAwsLake, deps: WaitDeps): Promise<never> {
  await deleteQuietly(deps.api, lake.stackId, deps.log);
  await deps.pending.remove(lake.stackId);
  throw new AantjeError(
    'CONNECTION_FAILED',
    `The stack "${lake.stackName}" never started: its change set did not run. aantje deleted the empty stack and forgets it.`,
  );
}

/** A creation that failed: the first resource that failed and why; a rolled-back stack is deleted. */
async function failed(
  lake: PendingAwsLake,
  stack: StackState,
  seen: StackEvent[],
  deps: WaitDeps,
): Promise<never> {
  const { api, log } = deps;
  const firstFailure = (events: readonly StackEvent[]): StackEvent | undefined =>
    events.find(
      (event) =>
        event.status.endsWith('_FAILED') &&
        event.logicalId !== lake.stackName &&
        !/cancel/i.test(event.reason ?? ''),
    );
  // Finish after a restart has seen only the last events: read them all again when those do not name the failure.
  const first = firstFailure(seen) ?? firstFailure(await api.stackEvents(lake.stackId).catch(() => []));
  const cause = first
    ? `${first.logicalId} (${first.resourceType}) failed: ${first.reason ?? 'no reason given'}`
    : (stack.reason ?? stack.status);
  const link = stackConsoleLink(lake.region, lake.stackId);
  await deps.pending.remove(lake.stackId);
  if (stack.status === 'ROLLBACK_COMPLETE') {
    // A stack in ROLLBACK_COMPLETE holds nothing but blocks its name; delete it so nothing of the run is left.
    await deleteQuietly(api, lake.stackId, log);
    throw new AantjeError(
      'CONNECTION_FAILED',
      `Creating the AWS DuckLake "${lake.lakeName}" failed: ${cause}. CloudFormation rolled it back and aantje deleted the stack, so nothing of it is left. Details: ${link}`,
    );
  }
  throw new AantjeError(
    'CONNECTION_FAILED',
    `Creating the AWS DuckLake "${lake.lakeName}" failed: ${cause}. The stack is ${stack.status}; what it created costs money until you delete the stack in the CloudFormation console: ${link}`,
  );
}

export function logEvent(event: StackEvent, log: Logger): void {
  const line = `${event.resourceType} "${event.logicalId}": ${event.status}${event.reason ? `: ${event.reason}` : '.'}`;
  if (event.status.endsWith('_FAILED')) log.warn(line);
  else if (event.status.endsWith('_COMPLETE')) log.info(line);
}

async function deleteQuietly(api: AwsApi, stackId: string, log: Logger): Promise<void> {
  try {
    await api.deleteStack(stackId);
  } catch (error) {
    log.warn(`The stack ${stackId} could not be deleted: ${awsMessageOf(error, undefined)}`);
  }
}

function stillRunning(
  error: unknown,
  lake: PendingAwsLake,
  state: 'goes on' | 'may have started',
): AantjeError {
  const said = awsMessageOf(error, lake.awsProfile);
  const where = `the stack "${lake.stackName}" in ${lake.region}`;
  return new AantjeError(
    'CONNECTION_FAILED',
    `${said} ${state === 'goes on' ? `${where.charAt(0).toUpperCase()}${where.slice(1)} goes on in AWS.` : `If ${where} has started, it goes on in AWS.`} Run "aantje: Finish Creating AWS DuckLake..." to wait for it again and add the connection.`,
    { cause: error },
  );
}
