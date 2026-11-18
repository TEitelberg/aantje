import type { RunRecord } from './history';
import type { ResultsTarget, ResultsView } from './results';
import type { SqlEvent, SqlSession } from './session';

/** One run: it forwards the events to the results and the history, and notes a failure and a committed change. */
export class RunTracker {
  readonly control = new AbortController();
  readonly target: ResultsTarget;
  readonly record: RunRecord | undefined;
  readonly startedAt: number;
  /** The session of the run, once it is open. */
  session: SqlSession | undefined;
  failed = false;
  /** A statement that may change the catalog completed outside a transaction, or a COMMIT did. */
  catalogChanged = false;
  // The statement that started last may change the catalog.
  private changing = false;

  constructor(
    private readonly ports: {
      readonly target: ResultsTarget;
      readonly results: ResultsView;
      readonly now: () => number;
      readonly record: RunRecord | undefined;
      /** The editor's state changed: a failure or a transaction may show. */
      readonly changed: () => void;
    },
  ) {
    this.target = ports.target;
    this.record = ports.record;
    this.startedAt = ports.now();
  }

  elapsed(): number {
    return this.ports.now() - this.startedAt;
  }

  forward(event: SqlEvent): void {
    this.failed ||= event.kind === 'error';
    this.record?.event(event, this.control.signal.aborted);
    this.ports.results.event(this.target, event);
    this.ports.changed();
  }

  /** An event of the script: a statement that ends well notes its change, unless a transaction holds it back. */
  statementEvent(event: SqlEvent): void {
    if (event.kind === 'start') {
      this.changing = event.changesCatalog;
    } else if (event.kind !== 'error') {
      // Inside a transaction the change becomes visible at COMMIT, which counts as a change itself.
      if (this.changing && this.session?.inTransaction === 'none') this.catalogChanged = true;
      this.changing = false;
    }
    this.forward(event);
  }
}
