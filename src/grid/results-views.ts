/// <reference lib="dom" />
// The views of the results page: the Messages tab with a line per statement, and the view of each result set (rows,
// a plan, a profile or a text). The page itself, with its tabs, is in results-page.ts.
import { el } from '../shell/dom';
import { gridView } from './grid-view';
import type { HostPort } from './grid-view';
import { clip } from './model';
import { planOf, planSummary } from './plan';
import { profileText } from './profile-text';
import { lazyChartTab } from './result-tab';
import type { ResultTab } from './result-tab';
import {
  HEADER_CHARS,
  STATUS_MARKS,
  TITLE_CHARS,
  elapsedText,
  endText,
  isPlan,
  oneLine,
  planText,
  statementText,
  transactionText,
  truncatedBanner,
} from './results-model';
import type { ResultSet, ResultsRunState, Statement } from './results-model';
import { profileView } from './statistics-view';

export interface MessagesView {
  readonly element: HTMLElement;
  /** Builds the rows of the statements that changed since the last call and puts the rows in order. */
  update(run: ResultsRunState): void;
}

function statementRows(host: HostPort, run: ResultsRunState, statement: Statement): HTMLElement[] {
  const { mark, label } = STATUS_MARKS[statement.status];
  const status = el('td', `st st-${statement.status}`, mark);
  status.title = label;
  status.setAttribute('aria-label', label);
  const text = el('td', 'sql', statementText(run, statement));
  text.title = clip(statement.sql, TITLE_CHARS);
  const time = el('td', 'num', statement.elapsedMs === undefined ? '' : elapsedText(statement.elapsedMs));
  const row = el('tr', 'stmt');
  row.append(
    status,
    el('td', 'rn', String(statement.index + 1)),
    text,
    el('td', undefined, statement.summary),
    time,
  );
  if (!statement.error) {
    return [row];
  }
  const goTo = el('button', undefined, 'Go to statement');
  goTo.title = 'Show the statement in the editor';
  goTo.addEventListener('click', () => host.post({ type: 'reveal', index: statement.index }));
  const cell = el('td', 'error');
  cell.setAttribute('colspan', '5');
  cell.append(el('div', 'message', statement.error.message), goTo);
  const failed = el('tr', 'err');
  failed.append(cell);
  return [row, failed];
}

export function messagesView(host: HostPort): MessagesView {
  const table = el('table', 'messages');
  const head = el('tr');
  head.append(el('th', undefined, ''), el('th', 'rn', '#'), el('th', undefined, 'Statement'));
  head.append(el('th', undefined, 'Result'), el('th', 'num', 'Time'));
  const thead = el('thead');
  thead.append(head);
  const body = el('tbody');
  table.append(thead, body);
  const end = el('div', 'end');
  const view = el('div', 'messages-view');
  view.append(table, end);
  // The rows of a statement (its line, and the line of its error), kept while the statement is the same object.
  const known = new Map<number, { readonly statement: Statement; readonly rows: HTMLElement[] }>();

  return {
    element: view,
    update(run) {
      let changed = false;
      const groups = run.statements.map((statement) => {
        const group = known.get(statement.index);
        if (group?.statement === statement) {
          return group;
        }
        changed = true;
        const built = { statement, rows: statementRows(host, run, statement) };
        known.set(statement.index, built);
        return built;
      });
      if (changed) {
        body.replaceChildren(...groups.flatMap((group) => group.rows));
      }
      end.replaceChildren(el('div', undefined, endText(run.end)));
      const transaction = transactionText(run.end);
      if (transaction) {
        end.append(el('div', 'transaction', transaction));
      }
    },
  };
}

/** A button that copies the whole text of a profile or plan to the clipboard. */
function copyButton(host: HostPort, text: string, label: string): HTMLButtonElement {
  const copy = el('button', undefined, label);
  copy.title = 'Copies the whole output to the clipboard';
  copy.addEventListener('click', () => host.post({ type: 'copy', text, what: 'text' }));
  return copy;
}

function copyBar(host: HostPort, text: string, label: string): HTMLElement {
  const bar = el('div', 'toolbar');
  bar.append(copyButton(host, text, label));
  return bar;
}

const nothingToPlace = (view: HTMLElement): ResultTab => ({ elements: [view], placed: () => undefined });

// Text in the editor font with its Copy: a plan in text, and Text Statistics.
function textView(host: HostPort, view: HTMLElement, text: string): ResultTab {
  const block = el('pre', 'text', text);
  block.tabIndex = 0;
  view.append(copyBar(host, text, 'Copy'), block);
  return nothingToPlace(view);
}

/** The view of one result set below its statement; a grid, a plan and a profile tab draw once on the page. */
export function resultView(host: HostPort, run: ResultsRunState, index: number): ResultTab {
  const set: ResultSet | undefined = run.resultSets[index];
  const view = el('div', 'result');
  if (!set) {
    return nothingToPlace(view);
  }
  const sql = run.statements.find((statement) => statement.index === set.statement)?.sql ?? '';
  const header = el('div', 'sql', oneLine(sql, HEADER_CHARS));
  header.title = clip(sql, TITLE_CHARS);
  view.append(header);
  if (set.view === 'text' && set.profile !== undefined) return textView(host, view, profileText(set.profile));
  if (set.profile !== undefined) {
    return profileView(view, set.profile, set.view ?? 'table', (text) =>
      copyBar(host, text, 'Copy Statistics'),
    );
  }
  // A plan in JSON (Explain, Analysis) is drawn as a tree; one in text, and a profile, keep their fixed-width text.
  const plan = isPlan(set) ? planOf(set) : undefined;
  if (plan) {
    const drawing = el('div', 'plan');
    view.append(el('div', 'summary', planSummary(plan)), drawing);
    const json = planText(set);
    return lazyChartTab(
      view,
      drawing,
      (target) => window.aantjePlan?.drawPlan(target, plan, copyButton(host, json, 'Copy Plan (JSON)')),
      () => [copyBar(host, json, 'Copy Plan (JSON)'), el('pre', 'text', json)],
    );
  }
  // A plan in text: an EXPLAIN typed in the editor.
  if (isPlan(set)) return textView(host, view, planText(set));
  if (set.truncated) {
    view.append(el('div', 'banner', truncatedBanner(set)));
  }
  const number = index + 1;
  const grid = gridView(
    host,
    {
      table: { schema: 'results', table: `Result ${number}` },
      columns: set.columns,
      rows: set.rows,
      limit: set.rows.length,
      truncated: set.truncated,
      elapsedMs: set.elapsedMs,
    },
    { persist: false, fileName: `result-${number}.csv` },
  );
  view.append(...grid.elements);
  return { elements: [view], placed: grid.placed };
}
