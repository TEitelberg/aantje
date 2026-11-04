import { applyEvents } from './model';
import type { HealthData, PanelEvent } from './model';

const BATCH_MS = 100;

export interface Batched {
  data: HealthData;
  pending: PanelEvent[];
  handle?: unknown;
}

export interface Timer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

interface EventBatcher<S extends Batched> {
  /** Adds an event; findings and progress wait for the next batch, the other events send the batch at once. */
  queue: (key: string, session: S, event: PanelEvent) => void;
  /** Applies the waiting events to the data of the session and sends them to the page. */
  flush: (key: string, session: S) => void;
}

/** Collects the events of a run so that a run with thousands of findings does not flood the page. */
export function createEventBatcher<S extends Batched>(
  timer: Timer,
  isOpen: (key: string, session: S) => boolean,
  send: (key: string, data: HealthData, events: readonly PanelEvent[]) => void,
): EventBatcher<S> {
  function flush(key: string, session: S): void {
    if (session.handle !== undefined) {
      timer.clear(session.handle);
      session.handle = undefined;
    }
    if (session.pending.length === 0 || !isOpen(key, session)) {
      session.pending = [];
      return;
    }
    const events = session.pending;
    session.pending = [];
    session.data = applyEvents(session.data, events);
    send(key, session.data, events);
  }

  function queue(key: string, session: S, event: PanelEvent): void {
    if (event.type === 'progress') {
      // Only the newest position of a group matters.
      session.pending = session.pending.filter(
        (queued) => !(queued.type === 'progress' && queued.group === event.group),
      );
    }
    session.pending.push(event);
    if (event.type === 'finding' || event.type === 'progress') {
      session.handle ??= timer.set(() => {
        session.handle = undefined;
        flush(key, session);
      }, BATCH_MS);
    } else {
      flush(key, session);
    }
  }

  return { queue, flush };
}
