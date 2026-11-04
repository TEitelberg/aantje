import type { SqlEvent, SqlSession } from './session';

/** The place that shows the results of one editor. */
export interface ResultsTarget {
  /** The key of the editor document; one panel per key. */
  readonly key: string;
  readonly title: string;
}

/** Most cells (rows times columns) kept per run; the session stops reading beyond it, or wide results exhaust the host. */
export const MAX_RESULT_CELLS = 2_000_000;

export interface RunSummary {
  readonly cancelled: boolean;
  readonly failed: boolean;
  readonly elapsedMs: number;
  readonly inTransaction: SqlSession['inTransaction'];
}

/** Where the SQL editor shows results; free of the VS Code API. Event positions are UTF-16 offsets into `script.text`. */
export interface ResultsView {
  /** A new run starts: the tabs of the earlier run go. */
  begin(target: ResultsTarget, script: { readonly text: string; readonly startedAt: number }): void;
  /** `start`, `resultSet`, `message` and `error` as the session yields them, in order. */
  event(target: ResultsTarget, event: SqlEvent): void;
  end(target: ResultsTarget, summary: RunSummary): void;
  reveal(target: ResultsTarget): void;
}
