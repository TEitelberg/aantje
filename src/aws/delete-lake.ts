// Deleting an AWS DuckLake that aantje created: checks that the stack is the lake's, deletes the database itself (its
// deletion protection off, with a final snapshot or none), empties the bucket and deletes the stack. The database is
// changed outside the stack on purpose: the stack goes, and a stack update could not do it (a stack of the first
// template has its parameters written in as literals, and a stack in DELETE_FAILED takes no update). Every step can run
// again, and a delete that stops says what it did before (#83). Free of the VS Code API.
import type { PostgresProfile } from '../connections/profile';
import { elapsed } from '../azure/operations';
import { AantjeError, isAantjeError } from '../errors';
import type { Logger } from '../log';
import type { AwsApi } from './api';
import { awsError, awsMessageOf, isPassingAwsFailure } from './errors';
import { followDelete, newestEvent } from './follow';
import type { FollowedStack } from './follow';
import { parseAwsLakeOutputs } from './outputs';
import type { CreatedAwsLake } from './registry';

/** What a delete does with the database: `Snapshot` keeps a final snapshot, `Delete` none. */
export type DatabaseDeletion = 'Snapshot' | 'Delete';

export interface DeleteDeps {
  readonly api: AwsApi;
  readonly sleep: (ms: number) => Promise<void>;
  readonly report: (step: string) => void;
  readonly log: Logger;
  readonly now?: () => Date;
  /** Told the final snapshot as soon as RDS deletes the database with it, so that a delete that stops still knows it. */
  readonly noteSnapshot?: (snapshot: string) => Promise<void>;
}

export interface DeletedAwsLake {
  /** False when CloudFormation could not delete everything; `failed` says what and why. */
  readonly deleted: boolean;
  readonly failed: readonly string[];
  /** The final snapshot that this run asked RDS for. */
  readonly snapshot?: string;
}

/** How far a delete got, for the message of one that stops. */
interface Progress {
  database?: 'deleting' | 'deleted';
  unprotected?: true;
  emptied?: true;
}

type StepDeps = Pick<DeleteDeps, 'api' | 'sleep' | 'report' | 'log'>;

const POLL_MS = 15_000;
const READY_TIMEOUT_MS = 15 * 60_000;
const DELETE_TIMEOUT_MS = 60 * 60_000;
const TOLERATED_POLL_FAILURES = 3;

/** The name of the final snapshot: the instance and the time, which RDS takes as an identifier. */
export function finalSnapshotName(instance: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${instance}-final-${stamp}`;
}

/**
 * Whether the database of a lake is still there to keep a final snapshot of: not when an earlier delete took it or is
 * taking it, nor when the stack is gone. When AWS does not answer, it may be.
 */
export async function databaseLeft(api: AwsApi, lake: CreatedAwsLake): Promise<boolean> {
  try {
    const stack = await api.describeStack(lake.stackId);
    if (stack === undefined || stack.status === 'DELETE_COMPLETE') return false;
    const instance = stack.outputs.DatabaseInstance;
    if (!instance) return true;
    const state = await api.dbInstance(instance);
    return state !== undefined && state.status !== 'deleting';
  } catch {
    return true;
  }
}

/** Deletes the stack of a lake that aantje created, after checking that it is the stack of this connection. */
export async function deleteAwsLake(
  lake: CreatedAwsLake,
  profile: PostgresProfile,
  database: DatabaseDeletion,
  deps: DeleteDeps,
): Promise<DeletedAwsLake> {
  const { api, log } = deps;
  const { account } = await api.identity();
  if (account !== lake.account) {
    throw new AantjeError(
      'AUTH_FAILED',
      `The credentials sign in to the account ${account}, but the lake is in the account ${lake.account}. Sign in to that account and try again.`,
    );
  }
  const stack = await api.describeStack(lake.stackId);
  if (stack === undefined || stack.status === 'DELETE_COMPLETE') {
    log.info(`The stack "${lake.stackName}" is gone already.`);
    return { deleted: true, failed: [] };
  }
  const instance = stack.outputs.DatabaseInstance;
  if (
    stack.tags['aantje:lake'] === undefined ||
    !hostMatches(stack.outputs.ducklake, profile.host) ||
    !instance
  ) {
    throw new AantjeError(
      'INVALID_PROFILE',
      `The stack "${lake.stackName}" does not look like the stack of "${profile.name}" (the tag aantje:lake, its host or its database is missing), so aantje does not delete it. Delete it in the CloudFormation console.`,
    );
  }
  const followed: FollowedStack = {
    id: stack.id,
    name: stack.name,
    region: lake.region,
    ...(lake.awsProfile === undefined ? {} : { awsProfile: lake.awsProfile }),
  };
  const snapshot =
    database === 'Snapshot' ? finalSnapshotName(instance, (deps.now ?? (() => new Date()))()) : undefined;
  const progress: Progress = {};
  try {
    return await deleteResources(lake, followed, instance, snapshot, progress, deps);
  } catch (error) {
    throw stoppedAfter(error, progress, instance, lake);
  }
}

async function deleteResources(
  lake: CreatedAwsLake,
  stack: FollowedStack,
  instance: string,
  snapshot: string | undefined,
  progress: Progress,
  deps: DeleteDeps,
): Promise<DeletedAwsLake> {
  const { api, report, log } = deps;
  const taken = await deleteDatabase(instance, snapshot, progress, deps);
  await again(
    'cloudformation:UpdateTerminationProtection',
    () => api.setTerminationProtection(stack.id, false),
    deps,
  );
  progress.unprotected = true;
  log.info(`Switched off the termination protection of the stack "${lake.stackName}".`);

  report('Emptying the bucket');
  const emptied = await again(
    `emptying the bucket "${lake.bucket}"`,
    () =>
      api
        .emptyBucket(lake.bucket, (deleted) => report(`Emptying the bucket: ${deleted} objects deleted`))
        .catch((error: unknown) => {
          // A bucket that is gone already leaves nothing to empty.
          if (/NoSuchBucket/.test(awsMessageOf(error, lake.awsProfile))) return { objects: 0, uploads: 0 };
          throw error;
        }),
    deps,
  );
  progress.emptied = true;
  log.info(
    `Emptied the bucket "${lake.bucket}": ${emptied.objects} objects and versions, ${emptied.uploads} unfinished uploads.`,
  );

  report('Deleting the stack');
  let result = await deleteStack(stack, undefined, deps);
  // A stack that failed before still names its database, which is gone now: delete the stack once more without it.
  if (
    !result.deleted &&
    result.failed.some((line) => line.startsWith('Database ')) &&
    !(await again('rds:DescribeDBInstances', () => api.dbInstance(instance), deps))
  ) {
    log.info(
      `The database of "${lake.stackName}" is gone; deleting the stack again and retaining nothing but that record.`,
    );
    result = await deleteStack(stack, ['Database'], deps);
  }
  return { ...result, ...(result.deleted && taken !== undefined ? { snapshot: taken } : {}) };
}

async function deleteStack(
  stack: FollowedStack,
  retain: readonly string[] | undefined,
  deps: StepDeps,
): Promise<{ readonly deleted: boolean; readonly failed: readonly string[] }> {
  const since = await again(
    'cloudformation:DescribeStackEvents',
    () => newestEvent(deps.api, stack.id),
    deps,
  );
  await again('cloudformation:DeleteStack', () => deps.api.deleteStack(stack.id, retain), deps);
  return followDelete(stack, since, deps);
}

/**
 * Switches off the deletion protection of the database if needed, deletes it and waits until it is gone. Returns the
 * final snapshot that it asked RDS for.
 */
async function deleteDatabase(
  id: string,
  snapshot: string | undefined,
  progress: Progress,
  deps: DeleteDeps,
): Promise<string | undefined> {
  const { api, report, log } = deps;
  let instance = await again('rds:DescribeDBInstances', () => api.dbInstance(id), deps);
  if (instance === undefined) {
    progress.database = 'deleted';
    log.info(`The database ${id} is gone already.`);
    return undefined;
  }
  let taken: string | undefined;
  if (instance.status !== 'deleting') {
    if (instance.deletionProtection) {
      report('Switching off the deletion protection of the database');
      await again('rds:ModifyDBInstance', () => api.allowDbDeletion(id), deps);
      log.info(`Switched off the deletion protection of the database ${id}.`);
    }
    // RDS deletes only an instance that is available, and the modification takes a moment.
    instance = await waitFor(
      id,
      (state) => state === undefined || (state.status === 'available' && !state.deletionProtection),
      READY_TIMEOUT_MS,
      deps,
    );
    if (instance === undefined) {
      progress.database = 'deleted';
      return undefined;
    }
    report('Deleting the database');
    // Not asked again: a second request after one that arrived would fail, and the next run finds it deleting.
    await api.deleteDbInstance(id, snapshot);
    taken = snapshot;
    if (snapshot !== undefined) await deps.noteSnapshot?.(snapshot);
    log.info(
      `Deleting the database ${id}${snapshot === undefined ? ' without a final snapshot' : `; its final snapshot is "${snapshot}"`}.`,
    );
  }
  progress.database = 'deleting';
  await waitFor(id, (state) => state === undefined, DELETE_TIMEOUT_MS, deps);
  progress.database = 'deleted';
  log.info(`The database ${id} is deleted.`);
  return taken;
}

/** Asks for the instance until `done` says so; a few failed polls in a row are tried again. */
async function waitFor(
  id: string,
  done: (state: { status: string; deletionProtection: boolean } | undefined) => boolean,
  timeoutMs: number,
  deps: StepDeps,
): Promise<{ status: string; deletionProtection: boolean } | undefined> {
  let waited = 0;
  let failures = 0;
  for (;;) {
    try {
      const state = await deps.api.dbInstance(id);
      failures = 0;
      deps.report(`Database: ${state?.status ?? 'deleted'}`);
      if (done(state)) return state;
    } catch (error) {
      if (!isPassingAwsFailure(error) || ++failures > TOLERATED_POLL_FAILURES) throw error;
      deps.log.warn(`No answer while waiting for the database ${id}: ${awsMessageOf(error, undefined)}`);
    }
    if (waited >= timeoutMs) {
      throw new AantjeError(
        'CONNECTION_FAILED',
        `The database ${id} did not finish within ${elapsed(timeoutMs)}; RDS goes on. Run Delete AWS DuckLake again later.`,
      );
    }
    const pause = POLL_MS * 2 ** failures;
    await deps.sleep(pause);
    waited += pause;
  }
}

/** One call of the delete: no answer, throttling or a server error is asked again, as a poll is. */
async function again<T>(
  what: string,
  call: () => Promise<T>,
  deps: Pick<StepDeps, 'sleep' | 'log'>,
): Promise<T> {
  for (let failures = 1; ; failures++) {
    try {
      return await call();
    } catch (error) {
      if (!isPassingAwsFailure(error) || failures > TOLERATED_POLL_FAILURES) throw error;
      deps.log.warn(`No answer to ${what}; asking again: ${awsMessageOf(error, undefined)}`);
      await deps.sleep(POLL_MS * 2 ** failures);
    }
  }
}

/** The failure of a delete that stopped half way: what it did before, and that running it again goes on from there. */
function stoppedAfter(error: unknown, progress: Progress, instance: string, lake: CreatedAwsLake): unknown {
  const done = [
    progress.database === 'deleting' && `RDS is deleting the database ${instance}`,
    progress.database === 'deleted' && `the database ${instance} is gone`,
    progress.unprotected && 'the termination protection of the stack is off',
    progress.emptied && `the bucket "${lake.bucket}" is empty`,
  ].filter((step): step is string => typeof step === 'string');
  if (done.length === 0) return error;
  const mapped = awsError(error, lake.awsProfile);
  return new AantjeError(
    isAantjeError(mapped) ? mapped.code : 'CONNECTION_FAILED',
    `${awsMessageOf(error, lake.awsProfile)} Done before it stopped: ${done.join('; ')}. The connection stays: run Delete AWS DuckLake again, it goes on from there.`,
    { cause: error },
  );
}

function hostMatches(output: string | undefined, host: string): boolean {
  try {
    return parseAwsLakeOutputs(output).postgres.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
