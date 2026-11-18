import { copyStatement, countQuery, describeQuery, fileWriteFailure, queryOffset } from '../export/copy';
import type { BoundColumn, ExportTarget } from '../export/copy';
import { pendingFile } from '../export/file';
import { groupedPlural } from '../shell/numbers';
import type { EditorRef, QueryEditors, RunAround, RunScript } from './editor';
import type { RunSummary } from './results';

/** The statement that Run to File writes: its text, where it starts in the document, and whether it only reads. */
export interface FileStatement {
  readonly text: string;
  readonly base: number;
  readonly readsOnly: boolean;
}

/**
 * Why Run to File does not run the statement, or undefined when it may: it writes the result of a statement that is known
 * to only read, as Analysis runs only such a statement. A convenience, no permission check: the session runs any SQL.
 */
export function fileRunRefusal(statement: Pick<FileStatement, 'readsOnly'>): string | undefined {
  return statement.readsOnly
    ? undefined
    : 'Run to File writes the result of a statement that only reads, and this one does more than read, or aantje cannot tell that it only reads. Nothing was run. Run it with Run Statement at Cursor, or write the COPY statement yourself.';
}

/**
 * Run to File: the statement runs in the session of its editor as `COPY (<statement>) TO '<file>' (...)`, so it sees the
 * transaction, the temporary tables and the settings of that session; progress, Cancel and the results are those of a
 * run. A CSV file holds every value as DuckDB writes it. The Messages tab gets one line with the rows written and the
 * file, the Query History records the COPY statement as a run, and the explorer is not refreshed, because writing the
 * file changes no catalog. A failed or cancelled run leaves no partial file.
 *
 * For Markdown the session binds the statement (`DESCRIBE`) and counts the rows first, hidden from the results, and
 * `confirmRows` decides about a long table (`MARKDOWN_ASK_ROWS`). The summary of the run, or undefined when nothing ran
 * (no connection chosen, a run already active, a long Markdown table declined).
 */
export async function runToFile(
  editors: Pick<QueryEditors, 'run' | 'quiet' | 'ensureConnection'>,
  editor: EditorRef,
  statement: FileStatement,
  target: ExportTarget,
  confirmRows: (rows: number) => Promise<boolean> = () => Promise.resolve(true),
): Promise<RunSummary | undefined> {
  // Markdown binds and counts first, so that it can ask about a long table before anything is written.
  let bound: readonly BoundColumn[] | undefined;
  if (target.format === 'markdown') {
    if (!(await editors.ensureConnection(editor))) return undefined;
    const { columns, rows } = await editors.quiet(
      editor.key,
      async (run) => ({
        columns: boundColumns((await run(describeQuery(statement.text))).rows),
        rows: Number((await run(countQuery(statement.text))).rows[0]?.[0] ?? 0),
      }),
      { progress: 'Counting the rows of the result...' },
    );
    if (!(await confirmRows(rows))) return undefined;
    bound = columns;
  }
  const file = await pendingFile(target.path);
  const script: RunScript = {
    text: copyStatement(statement.text, target, bound),
    base: statement.base - queryOffset(target),
    record: true,
    toFile: true,
  };
  const summary = await editors.run(editor, script, fileAround(target));
  if (!summary || summary.cancelled || summary.failed) await file.discard();
  return summary;
}

function fileAround(target: ExportTarget): RunAround {
  return {
    before: () => Promise.resolve(),
    event: (event) => {
      if (event.kind === 'start') return { ...event, changesCatalog: false };
      if (event.kind === 'error') {
        // A file that cannot be written is no failure to read a data file, which the session's advice would suggest.
        const failure = fileWriteFailure(event.message, target.path);
        return failure ? { ...event, message: failure } : event;
      }
      if (event.kind !== 'message' || event.rowsAffected === undefined) return event;
      const { index, elapsedMs, rowsAffected } = event;
      return {
        kind: 'message',
        index,
        text: `${groupedPlural(rowsAffected, 'row')} written to ${target.path}.`,
        elapsedMs,
      };
    },
    restore: () => Promise.resolve(true),
    report: () => Promise.resolve([]),
    dispose: () => Promise.resolve(),
  };
}

/** The columns from the rows of `DESCRIBE`: the name, then the type. */
function boundColumns(rows: readonly (readonly unknown[])[]): BoundColumn[] {
  return rows.map(([name, type]) => ({ name: String(name), type: String(type) }));
}
