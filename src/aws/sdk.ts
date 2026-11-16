// The entry of `dist/aws-sdk.js`: the AWS SDK for JavaScript behind `AwsApi`. The only file that imports the SDK; the
// extension loads the bundle when an AWS command runs. Credentials come from a profile of the AWS configuration (IAM
// Identity Center, assume role, credential process, keys) or from the environment; aantje stores none of them.
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
  GetTemplateCommand,
  UpdateStackCommand,
  UpdateTerminationProtectionCommand,
} from '@aws-sdk/client-cloudformation';
import type { Stack, StackEvent as SdkStackEvent } from '@aws-sdk/client-cloudformation';
import { DescribeRegionsCommand, DescribeVpcsCommand, EC2Client } from '@aws-sdk/client-ec2';
import { GetRoleCommand, IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import {
  DescribeAccountAttributesCommand,
  DescribeDBEngineVersionsCommand,
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
  ModifyDBInstanceCommand,
  DescribeOrderableDBInstanceOptionsCommand,
  RDSClient,
} from '@aws-sdk/client-rds';
import { S3Client } from '@aws-sdk/client-s3';
import { GetServiceQuotaCommand, ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromEnv, fromIni } from '@aws-sdk/credential-providers';
import { Signer } from '@aws-sdk/rds-signer';
import { AwsCallError, isAwsCallError } from './api';
import type { AwsApi, AwsApiOptions, ChangeSetState, RdsTokenRequest, StackEvent, StackState } from './api';
import { bucketCalls } from './sdk-bucket';

/** The quota "VPCs per Region" of Service Quotas. */
const VPC_QUOTA = { ServiceCode: 'vpc', QuotaCode: 'L-F678F1CE' } as const;
/** IAM's simulation takes the actions in parts of this size. */
const SIMULATION_CHUNK = 50;
const NETWORK_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE']);

interface SdkError {
  readonly name?: string;
  readonly code?: string;
  readonly message?: string;
  readonly $metadata?: { readonly httpStatusCode?: number };
}

function codeOf(error: SdkError): string {
  const name = error.name ?? 'Error';
  if (NETWORK_CODES.has(error.code ?? '') || name === 'TimeoutError' || name === 'RequestTimeout') {
    return 'Unreachable';
  }
  // Also keys that AWS does not know, for example those of another S3 store in the environment.
  if (
    /^(CredentialsProviderError|TokenProviderError|ExpiredToken|ExpiredTokenException|InvalidClientTokenId|SignatureDoesNotMatch|UnrecognizedClientException)$/.test(
      name,
    )
  ) {
    return 'Credentials';
  }
  return name;
}

export type Sent = { $metadata?: { httpStatusCode?: number; requestId?: string } };
export type Call = <T extends Sent>(operation: string, send: () => Promise<T>) => Promise<T>;

/** Runs one call, logs it, and turns a failure into an `AwsCallError`. */
function callerOf(debug: ((line: string) => void) | undefined): Call {
  return async (operation, send) => {
    const started = performance.now();
    const took = (): string => `${Math.round(performance.now() - started)} ms`;
    try {
      const result = await send();
      const { httpStatusCode, requestId } = result.$metadata ?? {};
      debug?.(
        `${operation}: ${httpStatusCode ?? 'ok'} in ${took()}${requestId ? ` (request ${requestId})` : ''}`,
      );
      return result;
    } catch (cause) {
      const error = (cause ?? {}) as SdkError;
      const code = codeOf(error);
      const status = error.$metadata?.httpStatusCode;
      debug?.(`${operation}: ${code}${status === undefined ? '' : ` ${status}`} in ${took()}`);
      throw new AwsCallError(operation, code, status, error.message ?? String(cause));
    }
  };
}

/** A token of IAM database authentication; a failure is an `AwsCallError` like those of the other calls. */
export async function rdsAuthToken(request: RdsTokenRequest): Promise<string> {
  const credentials = request.profile === undefined ? fromEnv() : fromIni({ profile: request.profile });
  try {
    return await new Signer({
      hostname: request.host,
      port: request.port,
      username: request.user,
      region: request.region,
      credentials,
    }).getAuthToken();
  } catch (cause) {
    const error = (cause ?? {}) as SdkError;
    throw new AwsCallError('rds-db:connect', codeOf(error), undefined, error.message ?? String(cause));
  }
}

export function createAwsApi(options: AwsApiOptions): AwsApi {
  const credentials = options.profile === undefined ? fromEnv() : fromIni({ profile: options.profile });
  const config = {
    region: options.region,
    credentials,
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 60_000 },
  };
  const call = callerOf(options.debug);
  const cloudFormation = new CloudFormationClient(config);
  return {
    region: options.region,
    ...accountCalls(new STSClient(config), new EC2Client(config), new ServiceQuotasClient(config), call),
    ...rdsCalls(new RDSClient(config), call),
    ...iamCalls(new IAMClient(config), call),
    ...bucketCalls(new S3Client({ ...config, followRegionRedirects: true }), call),
    ...changeSetCalls(cloudFormation, call),
    ...stackCalls(cloudFormation, call),
    ...stackUpdateCalls(cloudFormation, call),
  };
}

function accountCalls(
  sts: STSClient,
  ec2: EC2Client,
  quotas: ServiceQuotasClient,
  call: Call,
): Pick<AwsApi, 'identity' | 'enabledRegions' | 'vpcQuota'> {
  return {
    async identity() {
      const { Account, Arn } = await call('sts:GetCallerIdentity', () =>
        sts.send(new GetCallerIdentityCommand({})),
      );
      if (!Account || !Arn)
        throw new AwsCallError('sts:GetCallerIdentity', 'Empty', undefined, 'AWS named no account.');
      return { account: Account, arn: Arn };
    },
    async enabledRegions() {
      const { Regions } = await call('ec2:DescribeRegions', () =>
        ec2.send(new DescribeRegionsCommand({ AllRegions: false })),
      );
      return (Regions ?? []).flatMap((region) => (region.RegionName ? [region.RegionName] : [])).sort();
    },
    async vpcQuota() {
      let used = 0;
      let token: string | undefined;
      do {
        const page = await call('ec2:DescribeVpcs', () =>
          ec2.send(new DescribeVpcsCommand({ NextToken: token })),
        );
        used += page.Vpcs?.length ?? 0;
        token = page.NextToken;
      } while (token);
      try {
        const { Quota } = await call('servicequotas:GetServiceQuota', () =>
          quotas.send(new GetServiceQuotaCommand(VPC_QUOTA)),
        );
        return { used, max: Quota?.Value };
      } catch {
        return { used, max: undefined };
      }
    },
  };
}

function rdsCalls(
  rds: RDSClient,
  call: Call,
): Pick<
  AwsApi,
  | 'postgresMajors'
  | 'offersInstance'
  | 'instanceQuota'
  | 'dbInstance'
  | 'allowDbDeletion'
  | 'deleteDbInstance'
> {
  return {
    async postgresMajors() {
      const majors = new Set<number>();
      let marker: string | undefined;
      do {
        const page = await call('rds:DescribeDBEngineVersions', () =>
          rds.send(new DescribeDBEngineVersionsCommand({ Engine: 'postgres', Marker: marker })),
        );
        for (const version of page.DBEngineVersions ?? []) {
          const major = Number.parseInt(version.MajorEngineVersion ?? version.EngineVersion ?? '', 10);
          if (Number.isInteger(major)) majors.add(major);
        }
        marker = page.Marker;
      } while (marker);
      return [...majors].sort((a, b) => a - b);
    },
    async offersInstance(instanceClass, major, multiAz) {
      let marker: string | undefined;
      do {
        const page = await call('rds:DescribeOrderableDBInstanceOptions', () =>
          rds.send(
            new DescribeOrderableDBInstanceOptionsCommand({
              Engine: 'postgres',
              DBInstanceClass: instanceClass,
              Vpc: true,
              Marker: marker,
            }),
          ),
        );
        const offered = (page.OrderableDBInstanceOptions ?? []).some(
          (option) =>
            option.EngineVersion?.split('.')[0] === String(major) &&
            option.StorageType === 'gp3' &&
            (!multiAz || option.MultiAZCapable === true),
        );
        if (offered) return true;
        marker = page.Marker;
      } while (marker);
      return false;
    },
    async instanceQuota() {
      const { AccountQuotas } = await call('rds:DescribeAccountAttributes', () =>
        rds.send(new DescribeAccountAttributesCommand({})),
      );
      const quota = AccountQuotas?.find((entry) => entry.AccountQuotaName === 'DBInstances');
      return quota?.Used === undefined || quota.Max === undefined
        ? undefined
        : { used: quota.Used, max: quota.Max };
    },
    async dbInstance(id) {
      try {
        const { DBInstances } = await call('rds:DescribeDBInstances', () =>
          rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: id })),
        );
        const found = DBInstances?.[0];
        return found === undefined
          ? undefined
          : {
              status: found.DBInstanceStatus ?? 'unknown',
              deletionProtection: found.DeletionProtection === true,
            };
      } catch (error) {
        if (isAwsCallError(error) && /DBInstanceNotFound/.test(error.code)) return undefined;
        throw error;
      }
    },
    async allowDbDeletion(id) {
      await call('rds:ModifyDBInstance', () =>
        rds.send(
          new ModifyDBInstanceCommand({
            DBInstanceIdentifier: id,
            DeletionProtection: false,
            ApplyImmediately: true,
          }),
        ),
      );
    },
    async deleteDbInstance(id, finalSnapshot) {
      await call('rds:DeleteDBInstance', () =>
        rds.send(
          new DeleteDBInstanceCommand({
            DBInstanceIdentifier: id,
            ...(finalSnapshot === undefined
              ? { SkipFinalSnapshot: true }
              : { SkipFinalSnapshot: false, FinalDBSnapshotIdentifier: finalSnapshot }),
            DeleteAutomatedBackups: true,
          }),
        ),
      );
    },
  };
}

function iamCalls(iam: IAMClient, call: Call): Pick<AwsApi, 'roleArn' | 'deniedActions'> {
  return {
    async roleArn(roleName) {
      try {
        const { Role } = await call('iam:GetRole', () =>
          iam.send(new GetRoleCommand({ RoleName: roleName })),
        );
        return Role?.Arn;
      } catch {
        return undefined;
      }
    },
    async deniedActions(principalArn, actions) {
      const denied: string[] = [];
      for (let start = 0; start < actions.length; start += SIMULATION_CHUNK) {
        const names = actions.slice(start, start + SIMULATION_CHUNK);
        let marker: string | undefined;
        do {
          const page = await call('iam:SimulatePrincipalPolicy', () =>
            iam.send(
              new SimulatePrincipalPolicyCommand({
                PolicySourceArn: principalArn,
                ActionNames: names,
                Marker: marker,
              }),
            ),
          );
          for (const result of page.EvaluationResults ?? []) {
            if (result.EvalDecision !== 'allowed' && result.EvalActionName)
              denied.push(result.EvalActionName);
          }
          marker = page.IsTruncated ? page.Marker : undefined;
        } while (marker);
      }
      return denied;
    },
  };
}

function changeSetCalls(
  cloudFormation: CloudFormationClient,
  call: Call,
): Pick<AwsApi, 'createChangeSet' | 'describeChangeSet' | 'executeChangeSet'> {
  return {
    async createChangeSet(request) {
      const { Id, StackId } = await call('cloudformation:CreateChangeSet', () =>
        cloudFormation.send(
          new CreateChangeSetCommand({
            StackName: request.stackName,
            ChangeSetName: request.changeSetName,
            ChangeSetType: 'CREATE',
            TemplateBody: request.templateBody,
            Parameters: Object.entries(request.parameters).map(([ParameterKey, ParameterValue]) => ({
              ParameterKey,
              ParameterValue,
            })),
            Tags: Object.entries(request.tags).map(([Key, Value]) => ({ Key, Value })),
            Description: request.description,
          }),
        ),
      );
      if (!Id || !StackId) {
        throw new AwsCallError(
          'cloudformation:CreateChangeSet',
          'Empty',
          undefined,
          'CloudFormation named no change set.',
        );
      }
      return { stackId: StackId, changeSetId: Id };
    },
    async describeChangeSet(changeSetId) {
      let token: string | undefined;
      let state: Omit<ChangeSetState, 'changes'> | undefined;
      const changes: ChangeSetState['changes'][number][] = [];
      do {
        const page = await call('cloudformation:DescribeChangeSet', () =>
          cloudFormation.send(new DescribeChangeSetCommand({ ChangeSetName: changeSetId, NextToken: token })),
        );
        state ??= {
          status: page.Status ?? 'UNKNOWN',
          ...(page.StatusReason ? { reason: page.StatusReason } : {}),
        };
        for (const change of page.Changes ?? []) {
          const resource = change.ResourceChange;
          if (resource?.LogicalResourceId && resource.ResourceType) {
            changes.push({
              action: resource.Action ?? 'Add',
              logicalId: resource.LogicalResourceId,
              resourceType: resource.ResourceType,
            });
          }
        }
        token = page.NextToken;
      } while (token);
      return { ...(state ?? { status: 'UNKNOWN' }), changes };
    },
    async executeChangeSet(changeSetId) {
      await call('cloudformation:ExecuteChangeSet', () =>
        cloudFormation.send(new ExecuteChangeSetCommand({ ChangeSetName: changeSetId })),
      );
    },
  };
}

/** A stack as aantje reads it: status, outputs, parameters and tags. */
function stateOf(found: Stack): StackState | undefined {
  if (!found.StackId || !found.StackName || !found.StackStatus) return undefined;
  const pairs = <T>(
    items: readonly T[] | undefined,
    key: (item: T) => string | undefined,
    value: (item: T) => string | undefined,
  ) =>
    Object.fromEntries(
      (items ?? []).flatMap((item) => {
        const k = key(item);
        const v = value(item);
        return k !== undefined && v !== undefined ? [[k, v]] : [];
      }),
    );
  return {
    id: found.StackId,
    name: found.StackName,
    status: found.StackStatus,
    ...(found.StackStatusReason ? { reason: found.StackStatusReason } : {}),
    outputs: pairs(
      found.Outputs,
      (o) => o.OutputKey,
      (o) => o.OutputValue,
    ),
    parameters: pairs(
      found.Parameters,
      (p) => p.ParameterKey,
      (p) => p.ParameterValue,
    ),
    tags: pairs(
      found.Tags,
      (t) => t.Key,
      (t) => t.Value,
    ),
  };
}

const doesNotExist = (error: unknown): boolean =>
  isAwsCallError(error) && error.code === 'ValidationError' && /does not exist/i.test(error.message);

function stackCalls(
  cloudFormation: CloudFormationClient,
  call: Call,
): Pick<AwsApi, 'describeStack' | 'stackEvents' | 'deleteStack' | 'setTerminationProtection'> {
  return {
    async describeStack(stack) {
      try {
        const { Stacks } = await call('cloudformation:DescribeStacks', () =>
          cloudFormation.send(new DescribeStacksCommand({ StackName: stack })),
        );
        return Stacks?.[0] === undefined ? undefined : stateOf(Stacks[0]);
      } catch (error) {
        if (doesNotExist(error)) return undefined;
        throw error;
      }
    },
    async stackEvents(stack, after) {
      const events: StackEvent[] = [];
      let token: string | undefined;
      // Newest first: read until the event that was seen last.
      pages: do {
        const page = await call('cloudformation:DescribeStackEvents', () =>
          cloudFormation.send(new DescribeStackEventsCommand({ StackName: stack, NextToken: token })),
        );
        for (const event of page.StackEvents ?? []) {
          if (event.EventId === after) break pages;
          const read = eventOf(event);
          if (read) events.push(read);
        }
        token = after === undefined ? undefined : page.NextToken;
      } while (token);
      return events.reverse();
    },
    async deleteStack(stack, retain) {
      await call('cloudformation:DeleteStack', () =>
        cloudFormation.send(
          new DeleteStackCommand({
            StackName: stack,
            ...(retain === undefined ? {} : { RetainResources: [...retain] }),
          }),
        ),
      );
    },
    async setTerminationProtection(stack, on) {
      await call('cloudformation:UpdateTerminationProtection', () =>
        cloudFormation.send(
          new UpdateTerminationProtectionCommand({ StackName: stack, EnableTerminationProtection: on }),
        ),
      );
    },
  };
}

function stackUpdateCalls(
  cloudFormation: CloudFormationClient,
  call: Call,
): Pick<AwsApi, 'findStackByHost' | 'updateStack'> {
  return {
    async findStackByHost(host) {
      const wanted = host.trim().toLowerCase();
      let token: string | undefined;
      do {
        const page = await call('cloudformation:DescribeStacks', () =>
          cloudFormation.send(new DescribeStacksCommand({ NextToken: token })),
        );
        for (const stack of page.Stacks ?? []) {
          const found = stack.Outputs?.find((entry) => entry.OutputKey === 'PostgresHost')?.OutputValue;
          if (found?.toLowerCase() === wanted) return stateOf(stack);
        }
        token = page.NextToken;
      } while (token);
      return undefined;
    },
    async updateStack(stack, parameters) {
      const { Stacks } = await call('cloudformation:DescribeStacks', () =>
        cloudFormation.send(new DescribeStacksCommand({ StackName: stack })),
      );
      const keys = (Stacks?.[0]?.Parameters ?? []).flatMap((parameter) =>
        parameter.ParameterKey ? [parameter.ParameterKey] : [],
      );
      const missing = Object.keys(parameters).filter((key) => !keys.includes(key));
      if (missing.length > 0) {
        throw new AwsCallError(
          'cloudformation:UpdateStack',
          'ValidationError',
          400,
          `The stack has no parameter ${missing.join(', ')}: it was not created from the template of aantje.`,
        );
      }
      // Not UsePreviousTemplate: for a stack with a transform it is the processed template, where the transform of the
      // first template of aantje (AWS::LanguageExtensions) wrote the parameter values in as literals, so new values would
      // change nothing. The original template is processed again with them.
      const { TemplateBody } = await call('cloudformation:GetTemplate', () =>
        cloudFormation.send(new GetTemplateCommand({ StackName: stack, TemplateStage: 'Original' })),
      );
      if (!TemplateBody) {
        throw new AwsCallError(
          'cloudformation:GetTemplate',
          'Empty',
          undefined,
          'CloudFormation returned no template.',
        );
      }
      try {
        await call('cloudformation:UpdateStack', () =>
          cloudFormation.send(
            new UpdateStackCommand({
              StackName: stack,
              TemplateBody,
              Parameters: keys.map((key) =>
                parameters[key] === undefined
                  ? { ParameterKey: key, UsePreviousValue: true }
                  : { ParameterKey: key, ParameterValue: parameters[key] },
              ),
              // Stacks of the first template use AWS::LanguageExtensions.
              Capabilities: ['CAPABILITY_AUTO_EXPAND'],
            }),
          ),
        );
        return 'updating';
      } catch (error) {
        if (isAwsCallError(error) && /No updates are to be performed/i.test(error.message)) {
          return 'unchanged';
        }
        throw error;
      }
    },
  };
}

function eventOf(event: SdkStackEvent): StackEvent | undefined {
  if (!event.EventId || !event.LogicalResourceId || !event.ResourceStatus) return undefined;
  return {
    id: event.EventId,
    time: event.Timestamp?.toISOString() ?? '',
    logicalId: event.LogicalResourceId,
    resourceType: event.ResourceType ?? '',
    status: event.ResourceStatus,
    ...(event.ResourceStatusReason ? { reason: event.ResourceStatusReason } : {}),
  };
}
