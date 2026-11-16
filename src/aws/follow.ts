// Following a stack while CloudFormation updates or deletes it: the state every few seconds, each event once in the
// log, a few failed polls in a row tolerated. Free of the VS Code API.
import { elapsed } from '../azure/operations';
import { AantjeError } from '../errors';
import type { Logger } from '../log';
import { stackConsoleLink } from './api';
import type { AwsApi, StackEvent, StackState } from './api';
import { awsMessageOf, isPassingAwsFailure } from './errors';
import { logEvent } from './stack';

export interface FollowDeps {
  readonly api: AwsApi;
  readonly sleep: (ms: number) => Promise<void>;
  readonly report: (step: string) => void;
  readonly log: Logger;
  /** Milliseconds since some start, for the time limit. */
  readonly clock?: () => number;
}

export interface FollowedStack {
  readonly id: string;
  readonly name: string;
  readonly region: string;
  readonly awsProfile?: string;
}

const POLL_MS = 10_000;
const TIMEOUT_MS = 60 * 60_000;
const TOLERATED_POLL_FAILURES = 3;

/** The id of the newest event of the stack, so that a follow logs only what comes after it. */
export async function newestEvent(api: AwsApi, stackId: string): Promise<string | undefined> {
  return (await api.stackEvents(stackId)).at(-1)?.id;
}

/** The resources that failed, with CloudFormation's reasons; the stack itself is left out. */
export function failedResources(stack: FollowedStack, events: readonly StackEvent[]): string[] {
  return events
    .filter((event) => event.status.endsWith('_FAILED') && event.logicalId !== stack.name)
    .map((event) => `${event.logicalId} (${event.resourceType}): ${event.reason ?? 'no reason given'}`);
}

/**
 * Follows an update until it is complete; a failed update (rolled back) throws with the resources that failed and why.
 */
export async function followUpdate(
  stack: FollowedStack,
  since: string | undefined,
  deps: FollowDeps,
): Promise<void> {
  const { state, events } = await follow(stack, since, 'update', deps);
  if (state?.status === 'UPDATE_COMPLETE') return;
  const failed = failedResources(stack, events);
  throw new AantjeError(
    'CONNECTION_FAILED',
    `CloudFormation could not update the stack "${stack.name}" (${state?.status ?? 'gone'}): ${failed.join('; ') || (state?.reason ?? 'no reason given')}. Details: ${stackConsoleLink(stack.region, stack.id)}`,
  );
}

/** Follows a delete until it has ended: the last state (DELETE_COMPLETE or DELETE_FAILED) and the events seen. */
export async function followDelete(
  stack: FollowedStack,
  since: string | undefined,
  deps: FollowDeps,
): Promise<{ readonly deleted: boolean; readonly failed: readonly string[] }> {
  const { state, events } = await follow(stack, since, 'delete', deps);
  const deleted = state === undefined || state.status === 'DELETE_COMPLETE';
  return { deleted, failed: deleted ? [] : failedResources(stack, events) };
}

async function follow(
  stack: FollowedStack,
  since: string | undefined,
  goal: 'update' | 'delete',
  deps: FollowDeps,
): Promise<{ state: StackState | undefined; events: StackEvent[] }> {
  const { api, log } = deps;
  const clock = deps.clock ?? (() => performance.now());
  const started = clock();
  const events: StackEvent[] = [];
  let last = since;
  let lastStatus: string | undefined;
  let failures = 0;
  for (;;) {
    try {
      const state = await api.describeStack(stack.id);
      const fresh = await api.stackEvents(stack.id, last);
      for (const event of fresh) logEvent(event, log);
      events.push(...fresh);
      last = fresh.at(-1)?.id ?? last;
      failures = 0;
      const status = state?.status ?? 'DELETE_COMPLETE';
      if (status !== lastStatus) {
        lastStatus = status;
        log.info(`Stack "${stack.name}": ${status} after ${elapsed(clock() - started)}.`);
      }
      deps.report(`Stack: ${status}`);
      if (
        !status.endsWith('_IN_PROGRESS') &&
        (goal === 'delete' ? status.startsWith('DELETE_') : status.startsWith('UPDATE_'))
      ) {
        return { state, events };
      }
      if (goal === 'update' && /^(UPDATE_ROLLBACK_FAILED|DELETE_)/.test(status)) return { state, events };
    } catch (error) {
      if (!isPassingAwsFailure(error) || ++failures > TOLERATED_POLL_FAILURES) throw goesOn(error, stack);
      log.warn(
        `No answer while following the stack "${stack.name}" (${awsMessageOf(error, stack.awsProfile)}); asking again.`,
      );
    }
    if (clock() - started >= TIMEOUT_MS) {
      throw goesOn(
        new AantjeError('CONNECTION_FAILED', `The stack did not finish within ${elapsed(TIMEOUT_MS)}.`),
        stack,
      );
    }
    await deps.sleep(POLL_MS * 2 ** failures);
  }
}

function goesOn(error: unknown, stack: FollowedStack): AantjeError {
  return new AantjeError(
    'CONNECTION_FAILED',
    `${awsMessageOf(error, stack.awsProfile)} The stack "${stack.name}" goes on in AWS: ${stackConsoleLink(stack.region, stack.id)}`,
    { cause: error },
  );
}
