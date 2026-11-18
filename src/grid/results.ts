import type { SqlEvent } from '../sql/session';
import type { ResultsMessage, ResultsUpdate } from './protocol';
import { applyEvent, beginRun, endRun, revealRange } from './results-model';
import type { ResultsRange, ResultsRunState, ResultsRunSummary } from './results-model';

/** The last run of one editor. A hidden or new page gets the whole run on `ready`. */
export class ResultsRun {
  private run: ResultsRunState | undefined;
  private ready = false;
  private begun = 0;

  constructor(private readonly send: (message: ResultsMessage | ResultsUpdate) => void) {}

  /** Counts the runs: what was computed for one run must not reach the page of the next. */
  get generation(): number {
    return this.begun;
  }

  /** The run as the page has it; only the tests read it. */
  get state(): ResultsRunState | undefined {
    return this.run;
  }

  /** A new run replaces the last one; `built` marks a statement that aantje built. */
  begin(script: string, built = false): void {
    this.begun++;
    this.run = beginRun(script, built);
    this.post({ type: 'results-begin', script: this.run.script, ...(built ? { built: true } : {}) });
  }

  /** An event of a run that was not begun (the panel was closed meanwhile) is dropped. */
  event(event: SqlEvent): void {
    if (!this.run) {
      return;
    }
    this.run = applyEvent(this.run, event);
    this.post({ type: 'results-event', event });
  }

  end(summary: ResultsRunSummary): void {
    if (!this.run) {
      return;
    }
    this.run = endRun(this.run, summary);
    this.post({ type: 'results-end', summary });
  }

  /** The page was loaded, or loaded again: it knows nothing yet. */
  pageReady(): void {
    this.ready = true;
    if (this.run) {
      this.post({ type: 'results-state', state: this.run });
    }
  }

  pageGone(): void {
    this.ready = false;
  }

  revealRange(index: number): ResultsRange | undefined {
    return this.run && revealRange(this.run, index);
  }

  /** What the extension computed for a result set of this run; a page that is not ready gets it never. */
  update(update: ResultsUpdate): void {
    this.post(update);
  }

  private post(message: ResultsMessage | ResultsUpdate): void {
    if (this.ready) {
      this.send(message);
    }
  }
}
