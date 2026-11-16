// The dialogs of Create AWS DuckLake and Finish Creating AWS DuckLake, on top of `WizardUi`. Free of the VS Code API.
import type { PickItem, WizardUi } from '../connections/ports';
import type { PostgresProfile } from '../connections/profile';
import type { ConnectionStore } from '../connections/store';
import { currentFirst } from '../connections/wizard';
import { AantjeError, userMessageOf } from '../errors';
import type { Logger } from '../log';
import { isIpv4 } from '../azure/public-ip';
import { uniqueName } from '../azure/lake-profile';
import { elapsed } from '../azure/operations';
import type { AwsApi, AwsApiOptions, ResourceChange } from './api';
import { awsError, credentialsName } from './errors';
import { awsProfileOf } from './lake-profile';
import { validateLakeName } from './names';
import { ADMIN_USER, IAM_ROLE, iamRoleStatements } from './iam-role';
import type { AdminConnection } from './iam-role';
import { awsDataPathOf } from './outputs';
import type { PendingAwsLakes } from './pending';
import type { AwsProfile } from './profiles';
import type { AwsLakeRegistry } from './registry';
import { AWS_SIZE_NAMES, AWS_SIZES, POSTGRES_MAJORS } from './sizes';
import type { AwsLakeSize } from './sizes';
import { createAwsLake, deployedAwsLake, waitForStack } from './stack';
import type { DeployedAwsLake, StackDeps } from './stack';

export interface AwsFlowDeps {
  /** The profiles of the AWS configuration of this machine. */
  readonly profiles: () => Promise<readonly AwsProfile[]>;
  /** Whether the environment holds AWS keys, and its region. */
  readonly environment: { readonly hasKeys: boolean; readonly region: string | undefined };
  /** Loads the SDK on first use and opens a session of a profile (undefined: the environment) in a region. */
  readonly api: (options: Omit<AwsApiOptions, 'debug'>) => Promise<AwsApi>;
  readonly template: string;
  readonly publicIp: () => Promise<string>;
  readonly store: Pick<ConnectionStore, 'list' | 'newId' | 'add'>;
  readonly registry: Pick<AwsLakeRegistry, 'set' | 'markUnattached' | 'markAttached'>;
  readonly pending: Pick<PendingAwsLakes, 'add' | 'remove' | 'list' | 'password'>;
  /** Attaches the new lake, which creates its schema; rejects with the reason. */
  readonly attach: (
    profile: PostgresProfile,
    dataPath: string,
    report: (step: string) => void,
  ) => Promise<void>;
  /** Runs statements as the administrator of the lake, once (the role of IAM database authentication). */
  readonly runAsAdmin: (connection: AdminConnection, statements: readonly string[]) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: Logger;
  readonly password?: () => string;
  readonly suffix?: () => string;
}

const TITLE = 'Create AWS DuckLake';
export const ENVIRONMENT = '$environment';
/** For the calls before a region is chosen (the identity and the list of regions). */
const FALLBACK_REGION = 'us-east-1';
const PRICING = 'https://calculator.aws/';

/** Asks what AWS needs, creates the lake and saves it as a connection. Returns it, or undefined when cancelled. */
export async function createAwsLakeFlow(
  ui: WizardUi,
  deps: AwsFlowDeps,
): Promise<PostgresProfile | undefined> {
  const source = await chooseAwsProfile(ui, `${TITLE} (1/6): AWS profile`, deps);
  if (source === undefined) return undefined;
  const awsProfile = source.name === ENVIRONMENT ? undefined : source.name;
  try {
    return await createWith(ui, deps, awsProfile, source.region);
  } catch (error) {
    throw awsError(error, awsProfile);
  }
}

async function createWith(
  ui: WizardUi,
  deps: AwsFlowDeps,
  awsProfile: string | undefined,
  profileRegion: string | undefined,
): Promise<PostgresProfile | undefined> {
  const first = await deps.api({ profile: awsProfile, region: profileRegion ?? FALLBACK_REGION });
  const { identity, regions } = await ui.withProgress(
    `Signing in with ${credentialsName(awsProfile)}...`,
    async () => ({
      identity: await first.identity(),
      regions: await first.enabledRegions(),
    }),
  );
  const account = await ui.confirm(
    `Create the lake in the AWS account ${identity.account}, signed in as ${identity.arn}? Choose another profile if this is not the intended account.`,
    'Continue',
  );
  if (!account) return undefined;
  const region = await ui.pick(
    `${TITLE} (2/6): region`,
    currentFirst(
      regions.map((name) => ({ label: name, value: name })),
      profileRegion,
    ),
  );
  if (region === undefined) return undefined;
  const api = region === first.region ? first : await deps.api({ profile: awsProfile, region });
  const lakeName = await ui.input({
    title: `${TITLE} (3/6)`,
    prompt: 'Name of the lake: it goes into the names of the stack and the bucket, for example "sales"',
    validate: (value) => validateLakeName(value.trim()),
  });
  if (lakeName === undefined) return undefined;
  const offer = await chooseSize(ui, api);
  if (offer === undefined) return undefined;
  const authentication = await chooseAwsSignIn(ui, `${TITLE} (5/6): sign-in to PostgreSQL`);
  if (authentication === undefined) return undefined;
  const clientIp = await chooseIp(ui, deps);
  if (clientIp === undefined) return undefined;

  const request = { awsProfile, identity, lakeName: lakeName.trim(), ...offer, clientIp, authentication };
  deps.log.info(
    `Create AWS DuckLake "${request.lakeName}": account ${identity.account} as ${identity.arn} (${credentialsName(awsProfile)}), region ${region}, size ${request.size}, PostgreSQL ${request.postgresMajor}, sign-in ${authentication === 'iam' ? 'IAM' : 'password'}, client IP ${clientIp}.`,
  );
  return ui.withProgress('Creating the AWS DuckLake...', async (report) => {
    const stackDeps: StackDeps = {
      api,
      template: deps.template,
      pending: deps.pending,
      confirm: (changes, names) => ui.confirm(summary(request, region, changes, names), 'Create'),
      goOn: (problem) => ui.confirm(problem, 'Go on'),
      sleep: deps.sleep,
      report,
      log: deps.log,
      ...(deps.password ? { password: deps.password } : {}),
      ...(deps.suffix ? { suffix: deps.suffix } : {}),
    };
    const lake = await createAwsLake(request, stackDeps);
    return lake === undefined
      ? undefined
      : addLake(ui, deps, lake, { name: request.lakeName, done: 'Created', report });
  });
}

/**
 * Picks up a stack of Create AWS DuckLake whose wait broke off: waits for it again, then saves and attaches the lake
 * with the names and the password kept before it started. Returns the connection, or undefined when cancelled.
 */
export async function finishAwsLakeFlow(
  ui: WizardUi,
  deps: AwsFlowDeps,
): Promise<PostgresProfile | undefined> {
  const lakes = deps.pending.list();
  if (lakes.length === 0) {
    ui.info('There is no interrupted AWS DuckLake creation to finish.');
    return undefined;
  }
  const stackId = await ui.pick(
    'Finish Creating AWS DuckLake: stack',
    lakes.map((lake) => ({
      label: lake.lakeName,
      description: `${lake.stackName} in ${lake.region}, account ${lake.account}`,
      value: lake.stackId,
    })),
  );
  const lake = lakes.find((candidate) => candidate.stackId === stackId);
  if (lake === undefined) return undefined;
  deps.log.info(
    `Finish Creating AWS DuckLake "${lake.lakeName}": stack "${lake.stackName}" in ${lake.region}.`,
  );
  try {
    const api = await deps.api({ profile: lake.awsProfile, region: lake.region });
    const { account } = await api.identity();
    if (account !== lake.account) {
      throw new AantjeError(
        'AUTH_FAILED',
        `${credentialsName(lake.awsProfile)} signs in to the account ${account}, but the stack is in the account ${lake.account}. Sign in to that account and try again.`,
      );
    }
    return await ui.withProgress(`Finishing the AWS DuckLake "${lake.lakeName}"...`, async (report) => {
      const outputs = await waitForStack(lake, {
        api,
        pending: deps.pending,
        sleep: deps.sleep,
        report,
        log: deps.log,
      });
      const password = await deps.pending.password(lake);
      return addLake(ui, deps, deployedAwsLake(lake, outputs, password), {
        name: lake.lakeName,
        done: 'Finished',
        report,
      });
    });
  } catch (error) {
    throw awsError(error, lake.awsProfile);
  }
}

/** Saves a created lake as a connection, forgets its pending record, then attaches it; a failed attach is reported. */
async function addLake(
  ui: WizardUi,
  deps: Pick<AwsFlowDeps, 'store' | 'registry' | 'pending' | 'attach' | 'log' | 'runAsAdmin'>,
  lake: DeployedAwsLake,
  options: { readonly name: string; readonly done: string; readonly report: (step: string) => void },
): Promise<PostgresProfile> {
  const iam = lake.outputs.authentication === 'iam';
  if (iam) await createIamRole(deps, lake, options.report);
  // The password is kept only in the pending record: save the connection with it before anything else can fail. With
  // IAM the connection keeps none: the password has done its job, and the pending record takes it along.
  const profile = awsProfileOf(
    lake.outputs,
    uniqueName(options.name, deps.store.list()),
    (value) => deps.store.newId(value),
    lake.created.awsProfile,
    lake.outputs.authentication,
  );
  await deps.store.add(profile, iam ? undefined : lake.password);
  await deps.registry.set(profile.id, lake.created);
  const dataPath = awsDataPathOf(lake.outputs);
  await deps.registry.markUnattached(profile.id, dataPath);
  await deps.pending.remove(lake.created.stackId);
  deps.log.info(
    `Saved the connection "${profile.name}": ${profile.host}:${profile.port}/${profile.database} as ${profile.user}, bucket "${lake.created.bucket}", data path ${dataPath}.`,
  );
  const lost =
    lake.password === undefined && !iam
      ? ' Its generated password was not found: set a new master password of the instance in the RDS console and enter it with Edit Connection.'
      : '';
  options.report('Attaching the lake');
  deps.log.info(
    `Attaching "${profile.name}" for the first time: DuckLake creates its tables in the catalog.`,
  );
  const started = Date.now();
  try {
    await deps.attach(profile, dataPath, options.report);
    await deps.registry.markAttached(profile.id);
    deps.log.info(`Attached "${profile.name}" after ${elapsed(Date.now() - started)}.${lost}`);
    ui.info(`${options.done} the AWS DuckLake "${profile.name}" and added it as a connection.${lost}`);
  } catch (error) {
    deps.log.error(`Attaching "${profile.name}" failed; the connection is saved.`, error);
    ui.error(
      `The AWS DuckLake "${profile.name}" exists and is saved as a connection, but attaching it failed: ${userMessageOf(error)}${lost} The resources keep costing money until you delete them.`,
    );
  }
  return profile;
}

/**
 * Creates the role of IAM database authentication with the administrator's password, which only the pending record
 * keeps. Without it the role cannot be made by aantje, and the message says how to make it by hand.
 */
async function createIamRole(
  deps: Pick<AwsFlowDeps, 'runAsAdmin' | 'log'>,
  lake: DeployedAwsLake,
  report: (step: string) => void,
): Promise<void> {
  const { host, port, database } = lake.outputs.postgres;
  if (lake.password === undefined) {
    throw new AantjeError(
      'AUTH_FAILED',
      `The generated password of the administrator was not found, so aantje cannot create the role ${IAM_ROLE}. Set a new master password in the RDS console, connect as ${ADMIN_USER} and run: ${iamRoleStatements(database).join('; ')}; then run Import AWS DuckLake with the output of the stack.`,
    );
  }
  report(`Creating the role ${IAM_ROLE} for IAM`);
  await deps.runAsAdmin(
    { host, port, database, user: ADMIN_USER, password: lake.password },
    iamRoleStatements(database),
  );
  deps.log.info(
    `Created the role ${IAM_ROLE} on ${host}: it signs in with IAM and owns the database ${database}; the password of ${ADMIN_USER} is not kept.`,
  );
}

const SIGN_IN_ITEMS: readonly PickItem<'password' | 'iam'>[] = [
  {
    label: 'Password',
    description: 'A generated password of the administrator, kept in the secret storage',
    value: 'password',
  },
  {
    label: 'AWS IAM',
    description: `Your AWS profile signs a token for every connection, as ${IAM_ROLE}; no password is stored`,
    value: 'iam',
  },
];

/** The sign-in to PostgreSQL; Password stays first until a real account has proven IAM. */
export function chooseAwsSignIn(
  ui: WizardUi,
  title: string,
  preferred: 'password' | 'iam' = 'password',
): Promise<'password' | 'iam' | undefined> {
  return ui.pick(title, currentFirst(SIGN_IN_ITEMS, preferred));
}

/** The credentials to use: a profile of the AWS configuration, or the keys of the environment (`ENVIRONMENT`). */
export async function chooseAwsProfile(
  ui: WizardUi,
  title: string,
  deps: Pick<AwsFlowDeps, 'profiles' | 'environment'>,
): Promise<{ name: string; region: string | undefined } | undefined> {
  const profiles = await deps.profiles();
  const items: PickItem<string>[] = [
    ...profiles.map((profile) => ({
      label: profile.name,
      description: [profile.sso ? 'IAM Identity Center' : '', profile.region ?? '']
        .filter(Boolean)
        .join(', '),
      value: profile.name,
    })),
    ...(deps.environment.hasKeys
      ? [
          {
            label: 'Environment',
            description: 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
            value: ENVIRONMENT,
          },
        ]
      : []),
  ];
  if (items.length === 0) {
    throw new AantjeError(
      'INVALID_PROFILE',
      'No AWS credentials were found: there is no profile in ~/.aws/config or ~/.aws/credentials and no AWS_ACCESS_KEY_ID in the environment. Set up a profile, for example with "aws configure sso", and try again.',
    );
  }
  const name = await ui.pick(title, items);
  if (name === undefined) return undefined;
  const region =
    name === ENVIRONMENT ? deps.environment.region : profiles.find((p) => p.name === name)?.region;
  return { name, region };
}

// A quick pick cannot disable an item, so a size that the region lacks is listed with the reason and refused when picked.
async function chooseSize(
  ui: WizardUi,
  api: AwsApi,
): Promise<{ size: AwsLakeSize; postgresMajor: number } | undefined> {
  const { major, offered } = await ui.withProgress('Checking what RDS offers in the region...', async () => {
    const majors = await api.postgresMajors();
    const newest = POSTGRES_MAJORS.find((candidate) => majors.includes(candidate));
    if (newest === undefined) {
      throw new AantjeError(
        'INVALID_PROFILE',
        `RDS offers none of PostgreSQL ${POSTGRES_MAJORS.join(', ')} in ${api.region}. Choose another region.`,
      );
    }
    const sizes = await Promise.all(
      AWS_SIZE_NAMES.map(
        async (size) =>
          [
            size,
            await api.offersInstance(AWS_SIZES[size].instanceClass, newest, AWS_SIZES[size].multiAz),
          ] as const,
      ),
    );
    return { major: newest, offered: new Map(sizes) };
  });
  const items = AWS_SIZE_NAMES.map((size): PickItem<AwsLakeSize> => ({
    label: AWS_SIZES[size].label,
    description: offered.get(size)
      ? `${AWS_SIZES[size].description}, PostgreSQL ${major}`
      : `Not offered in ${api.region}: ${AWS_SIZES[size].instanceClass}`,
    value: size,
  }));
  for (;;) {
    const size = await ui.pick(`${TITLE} (4/6): size`, items);
    if (size === undefined || offered.get(size))
      return size === undefined ? undefined : { size, postgresMajor: major };
    ui.error(`${AWS_SIZES[size].label} is not offered in ${api.region}. Choose another size.`);
  }
}

async function chooseIp(ui: WizardUi, deps: Pick<AwsFlowDeps, 'publicIp'>): Promise<string | undefined> {
  try {
    return await deps.publicIp();
  } catch {
    return ui.input({
      title: `${TITLE} (6/6)`,
      prompt:
        'aantje could not look up your public IPv4 address. Enter it; only this address may reach PostgreSQL.',
      validate: (value) => (isIpv4(value.trim()) ? undefined : 'Enter an IPv4 address such as 203.0.113.7.'),
    });
  }
}

/** The question before the change set runs: what is created, from where it is reachable, and the cost. */
export function summary(
  request: { lakeName: string; size: AwsLakeSize; postgresMajor: number; clientIp: string },
  region: string,
  changes: readonly ResourceChange[],
  names: { stack: string; bucket: string },
): string {
  const size = AWS_SIZES[request.size];
  const counts = new Map<string, number>();
  for (const change of changes) counts.set(change.resourceType, (counts.get(change.resourceType) ?? 0) + 1);
  const resources = [...counts]
    .map(([type, count]) => (count === 1 ? type : `${count} × ${type}`))
    .join(', ');
  return [
    `Create the DuckLake "${request.lakeName}" in ${region}? The stack "${names.stack}" creates: ${resources}.`,
    `Size ${size.label}: ${size.description}, PostgreSQL ${request.postgresMajor}; the bucket "${names.bucket}" holds the data files.`,
    `Only your public IP address ${request.clientIp} may reach PostgreSQL, over TLS. The password is generated and kept in the secret storage.`,
    `RDS is billed per hour as long as the instance exists, also when idle, plus storage and backups; see ${PRICING} for the price of this size.`,
  ].join('\n\n');
}
