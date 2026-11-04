import { userMessageOf } from '../errors';
import type { FindingScope, HealthReport, HealthRequest, HealthScope } from '../health/model';
import type { HealthRun } from '../health/run';
import type { Logger } from '../log';
import { planHealthAction } from './actions';
import type { HealthPlan } from './actions';
import { createEventBatcher } from './batcher';
import type { Batched, Timer } from './batcher';
import { DEFAULT_DEEP_FILES, freshData, healthKey, healthTitle } from './model';
import type { HealthData } from './model';
import type { HealthAction } from './protocol';

/** The check of a connection, at the snapshot its tree shows. */
export interface HealthTarget {
  readonly connectionId: string;
  readonly connectionName: string;
  readonly scope: FindingScope;
  readonly snapshot: number;
}

/** The part of `ReportPanels` that the controller uses. */
export interface HealthPanels {
  show(key: string, title: string, data: HealthData): void;
  update(key: string, data: HealthData, message: unknown): void;
}

interface HealthControllerEnv {
  readonly panels: HealthPanels;
  readonly logger: Pick<Logger, 'warn'>;
  /** Runs the check of the connection. It rejects only when the run cannot start (a closed connection, the settings). */
  readonly check: (target: HealthTarget, request: HealthRequest, run: HealthRun) => Promise<HealthReport>;
  /** What a finding asks for besides the run. 'rerun' means the setup may have changed: the quick check runs again. */
  readonly perform: (
    plan: Exclude<HealthPlan, { readonly action: 'run' | 'cancel' }>,
    target: HealthTarget,
  ) => Promise<'rerun' | undefined>;
  /** The timer that batches events; tests drive it by hand. */
  readonly timer?: Timer;
}

function requestScope(scope: FindingScope): HealthScope {
  switch (scope.kind) {
    case 'lake':
      return { kind: 'lake' };
    case 'schema':
      return { kind: 'schema', schemaId: scope.id };
    case 'table':
      return { kind: 'table', tableId: scope.id };
  }
}

interface HealthChoice {
  readonly depth: 'quick' | 'deep';
  readonly deepFiles: number;
}

interface HealthController {
  /** Shows the panel of the target; with `run` it starts a quick check unless one is running there already. */
  open(target: HealthTarget, options?: { readonly run?: boolean }): void;
  /** A request of a page. Rejects when the action itself fails. */
  act(key: string, message: HealthAction): Promise<void>;
  /** The user closed the panel: its run is stopped. */
  close(key: string): void;
  dispose(): void;
}

interface Session extends Batched {
  /** Replaced at every open: the connection may have been renamed, the tree may show another snapshot. */
  target: HealthTarget;
  abort?: AbortController;
}

const BY_TIMEOUT = {
  set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clear: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The panels of the health check and their runs, one per connection and scope. Closing a panel stops its run. */
export function createHealthController(env: HealthControllerEnv): HealthController {
  const sessions = new Map<string, Session>();
  const timer = env.timer ?? BY_TIMEOUT;

  const { queue, flush } = createEventBatcher<Session>(
    timer,
    (key, session) => sessions.get(key) === session,
    (key, data, events) => env.panels.update(key, data, { type: 'health', data: { events } }),
  );

  async function run(key: string, session: Session, choice: HealthChoice): Promise<void> {
    const { target } = session;
    const abort = new AbortController();
    session.abort = abort;
    session.pending = [];
    session.data = freshData(target.connectionName, target.scope, choice, 'running');
    env.panels.show(key, healthTitle(target.connectionName, target.scope), session.data);
    const request: HealthRequest = {
      scope: requestScope(target.scope),
      depth: choice.depth,
      snapshot: target.snapshot,
      ...(choice.depth === 'deep' ? { limits: { deepFiles: choice.deepFiles } } : {}),
    };
    try {
      const report = await env.check(target, request, {
        signal: abort.signal,
        onEvent: (event) => queue(key, session, event),
      });
      if (report.snapshot !== undefined) {
        queue(key, session, { type: 'snapshot', snapshot: report.snapshot });
      }
      flush(key, session);
    } catch (error) {
      queue(key, session, { type: 'failed', message: userMessageOf(error) });
    } finally {
      session.abort = undefined;
    }
  }

  function start(key: string, session: Session, choice: HealthChoice): void {
    run(key, session, choice).catch((error: unknown) => {
      env.logger.warn(`The health check ended unexpectedly: ${userMessageOf(error)}`);
    });
  }

  return {
    open(target, options = {}) {
      const key = healthKey(target.connectionId, target.scope);
      const existing = sessions.get(key);
      if (existing) {
        existing.target = target;
        existing.data = { ...existing.data, connection: target.connectionName };
        env.panels.show(key, healthTitle(target.connectionName, target.scope), existing.data);
        if (options.run && existing.abort === undefined) {
          start(key, existing, { depth: 'quick', deepFiles: existing.data.deepFiles });
        }
        return;
      }
      const choice = { depth: 'quick', deepFiles: DEFAULT_DEEP_FILES } as const;
      const session: Session = {
        target,
        data: freshData(target.connectionName, target.scope, choice, 'idle'),
        pending: [],
      };
      sessions.set(key, session);
      if (options.run) {
        start(key, session, choice);
      } else {
        env.panels.show(key, healthTitle(target.connectionName, target.scope), session.data);
      }
    },

    async act(key, message) {
      const session = sessions.get(key);
      const plan = session && planHealthAction(session.data, message);
      if (!session || !plan) {
        env.logger.warn('The health check asked for an action that its data does not offer; it was ignored.');
        return;
      }
      if (plan.action === 'run') {
        await run(key, session, plan);
      } else if (plan.action === 'cancel') {
        session.abort?.abort();
      } else {
        const outcome = await env.perform(plan, session.target);
        if (outcome === 'rerun' && sessions.get(key) === session && session.abort === undefined) {
          await run(key, session, { depth: 'quick', deepFiles: session.data.deepFiles });
        }
      }
    },

    close(key) {
      const session = sessions.get(key);
      session?.abort?.abort();
      sessions.delete(key);
    },

    dispose() {
      for (const session of sessions.values()) {
        session.abort?.abort();
      }
      sessions.clear();
    },
  };
}
