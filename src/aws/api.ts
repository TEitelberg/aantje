// What aantje asks of AWS for a DuckLake, in its own terms. `sdk.ts` implements it with the AWS SDK for JavaScript in a
// bundle of its own (`dist/aws-sdk.js`), which only an AWS command loads; the flows and their tests know only this file.

/** Who the credentials belong to (`sts:GetCallerIdentity`). */
export interface AwsIdentity {
  readonly account: string;
  /** `arn:aws:iam::<account>:user/...`, `arn:aws:sts::<account>:assumed-role/<role>/<session>`, or the root. */
  readonly arn: string;
}

/** A failed call to AWS: the operation, AWS's error name (or `Unreachable`, `Credentials`) and its words. */
export class AwsCallError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'AwsCallError';
  }
}

/**
 * Whether an error is an `AwsCallError`. Not `instanceof`: `dist/aws-sdk.js` is a bundle of its own with its own copy of
 * the class, so the errors it throws are no instances of the class in `extension.js`.
 */
export function isAwsCallError(error: unknown): error is AwsCallError {
  if (!(error instanceof Error) || error.name !== 'AwsCallError') return false;
  const { operation, code } = error as Partial<AwsCallError>;
  return typeof operation === 'string' && typeof code === 'string';
}

export interface ChangeSetRequest {
  readonly stackName: string;
  readonly changeSetName: string;
  readonly templateBody: string;
  readonly parameters: Readonly<Record<string, string>>;
  /** Stack tags, which CloudFormation also puts on the resources that take tags. */
  readonly tags: Readonly<Record<string, string>>;
  readonly description: string;
}

export interface ResourceChange {
  readonly action: string;
  readonly logicalId: string;
  readonly resourceType: string;
}

export interface ChangeSetState {
  /** `CREATE_PENDING`, `CREATE_IN_PROGRESS`, `CREATE_COMPLETE`, `FAILED`, ... */
  readonly status: string;
  readonly reason?: string;
  readonly changes: readonly ResourceChange[];
}

export interface StackState {
  readonly id: string;
  readonly name: string;
  /** `REVIEW_IN_PROGRESS`, `CREATE_IN_PROGRESS`, `CREATE_COMPLETE`, `ROLLBACK_COMPLETE`, ... */
  readonly status: string;
  readonly reason?: string;
  readonly outputs: Readonly<Record<string, string>>;
  /** The parameters; a `NoEcho` one shows as `****`. */
  readonly parameters: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
}

export interface StackEvent {
  readonly id: string;
  readonly time: string;
  readonly logicalId: string;
  readonly resourceType: string;
  readonly status: string;
  readonly reason?: string;
}

/** The calls of one session (an AWS profile, or the environment) in one region. */
export interface AwsApi {
  readonly region: string;
  identity(): Promise<AwsIdentity>;
  /** The regions that the account has enabled. */
  enabledRegions(): Promise<string[]>;
  /** The major versions of PostgreSQL that RDS offers in the region. */
  postgresMajors(): Promise<number[]>;
  /** Whether RDS offers the instance class with that major version, gp3 storage and, if asked, Multi-AZ. */
  offersInstance(instanceClass: string, major: number, multiAz: boolean): Promise<boolean>;
  /** DB instances of the account in the region and their quota; undefined when RDS does not say. */
  instanceQuota(): Promise<{ readonly used: number; readonly max: number } | undefined>;
  /** VPCs in the region and their quota; `max` undefined when Service Quotas cannot be read. */
  vpcQuota(): Promise<{ readonly used: number; readonly max: number | undefined }>;
  /** Whether a bucket of that name exists anywhere (bucket names are global). */
  bucketTaken(name: string): Promise<boolean>;
  /** The stack of that name or id; undefined when there is none. */
  describeStack(stack: string): Promise<StackState | undefined>;
  /** The ARN of a role, with its path; undefined when the role cannot be read. */
  roleArn(roleName: string): Promise<string | undefined>;
  /** The actions that IAM's policy simulation denies to the principal. */
  deniedActions(principalArn: string, actions: readonly string[]): Promise<string[]>;
  createChangeSet(
    request: ChangeSetRequest,
  ): Promise<{ readonly stackId: string; readonly changeSetId: string }>;
  describeChangeSet(changeSetId: string): Promise<ChangeSetState>;
  executeChangeSet(changeSetId: string): Promise<void>;
  /** The events of the stack after the event `after` (all when undefined), oldest first. */
  stackEvents(stack: string, after?: string): Promise<StackEvent[]>;
  /** Deletes the stack; `retain` keeps those resources of a stack in DELETE_FAILED. */
  deleteStack(stack: string, retain?: readonly string[]): Promise<void>;
  setTerminationProtection(stack: string, on: boolean): Promise<void>;
  /** The stack of the region whose output `PostgresHost` is the host; undefined when there is none. */
  findStackByHost(host: string): Promise<StackState | undefined>;
  /**
   * Gives parameters of the stack new values, with its original template and the other values as they are.
   * `unchanged` when they have these values already.
   */
  updateStack(stack: string, parameters: Readonly<Record<string, string>>): Promise<'updating' | 'unchanged'>;
  /** Deletes every object, version and delete marker of the bucket and aborts its multipart uploads. */
  emptyBucket(
    bucket: string,
    report?: (deleted: number) => void,
  ): Promise<{ readonly objects: number; readonly uploads: number }>;
  /** A DB instance of the region: its status and deletion protection; undefined when there is none. */
  dbInstance(
    id: string,
  ): Promise<{ readonly status: string; readonly deletionProtection: boolean } | undefined>;
  /** Switches off the deletion protection of a DB instance, at once. */
  allowDbDeletion(id: string): Promise<void>;
  /** Deletes a DB instance, with a final snapshot of that name, or without one. */
  deleteDbInstance(id: string, finalSnapshot: string | undefined): Promise<void>;
}

export interface AwsApiOptions {
  /** A profile of the AWS configuration; undefined uses the credentials of the environment. */
  readonly profile: string | undefined;
  readonly region: string;
  /** One line per request: the operation, the status, the duration and the request id. */
  readonly debug?: (line: string) => void;
}

/** What a token of IAM database authentication is signed for. */
export interface RdsTokenRequest {
  /** A profile of the AWS configuration; undefined uses the credentials of the environment. */
  readonly profile: string | undefined;
  readonly region: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
}

/** What `dist/aws-sdk.js` exports. */
export interface AwsSdkModule {
  readonly createAwsApi: (options: AwsApiOptions) => AwsApi;
  /** A token of IAM database authentication (valid 15 minutes): the password of the PostgreSQL user on RDS. */
  readonly rdsAuthToken: (request: RdsTokenRequest) => Promise<string>;
}

/** CloudFormation's link to a stack in the console. */
export function stackConsoleLink(region: string, stackId: string): string {
  return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/stackinfo?stackId=${encodeURIComponent(stackId)}`;
}
