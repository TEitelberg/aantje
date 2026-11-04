/// <reference lib="dom" />
// Browser side of the grid and of the results page. The rules (sorting, filtering, copying, the row window) are in
// model.ts and results-model.ts; this file holds the state of the page (the rows in view, the focused cell, the
// selected tab, the kept grids) and turns it into DOM.
import {
  NULL_NOT_COPIED,
  cellCopyText,
  clip,
  csvFileName,
  filterRows,
  nextSort,
  restoreView,
  rowWindow,
  saveView,
  sortRows,
  statusText,
  toCsv,
  toTsv,
  widestTexts,
} from './model';
import type { RowWindow } from './model';
import { isObject, own } from '../guards';
import { isGridData, isResultsMessage, rowKindsOf } from './protocol';
import type { CopyScope, ResultsMessage, WebviewMessage } from './protocol';
import {
  HEADER_CHARS,
  STATUS_MARKS,
  TITLE_CHARS,
  applyMessage,
  elapsedText,
  endText,
  oneLine,
  selectedTab,
  statementText,
  tabsOf,
  transactionText,
  truncatedBanner,
} from './results-model';
import type { ResultSet, ResultsRunState, Statement, TabId } from './results-model';
import {
  dataRow,
  gridTable,
  plainHeader,
  sizerRow,
  sortMark,
  sortableHeader,
  statusLine,
  toolbar,
} from './render';
import { el } from '../shell/dom';
import { tabAfterKey } from '../shell/blocks';
import { createApp } from '../shell/page';
import type { GridData, GridValue } from '../data/types';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const FILTER_DELAY_MS = 150;
const NOTICE_MS = 2000;
// The height of a row until the drawn rows are laid out and measured.
const ROW_PX = 22;

const vscode = acquireVsCodeApi();
const app = createApp();
document.body.append(app);

/** The elements of a grid, and what to call once they are in the page. */
interface GridView {
  readonly elements: HTMLElement[];
  /** Measures the rows and fits the drawn ones to the scroll area. */
  readonly placed: () => void;
}

interface GridOptions {
  /** Only the preview grid keeps sort and filters in the webview state. */
  readonly persist: boolean;
  /** The name that Export CSV suggests. */
  readonly fileName: string;
}

function show(data: GridData): void {
  const grid = gridView(data, { persist: true, fileName: csvFileName(data.table) });
  app.replaceChildren(...grid.elements);
  grid.placed();
}

function cursorMove(key: string, columns: number): [number, number] | undefined {
  const moves: Record<string, [number, number]> = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
    Home: [0, -columns],
    End: [0, columns],
  };
  return moves[key];
}

type Rows = readonly (readonly GridValue[])[];

interface WindowedRows {
  readonly body: HTMLTableSectionElement;
  readonly scroll: HTMLElement;
  /** The cell of a row of the shown rows, while that row is drawn. */
  readonly cellAt: (row: number, column: number) => HTMLTableCellElement | undefined;
  /** The row of the shown rows and the column of the data that a drawn cell shows. */
  readonly positionOf: (row: HTMLTableRowElement, cell: HTMLTableCellElement) => [number, number];
  /** Takes new rows and draws the ones at the scroll position. */
  readonly show: (rows: Rows) => void;
  /** Draws the selected cell unless it is drawn, makes it the tab stop and focuses it. */
  readonly focusSelected: () => void;
  /** Measures a row once the rows are laid out, and draws other rows when the visible ones leave the drawn ones. */
  readonly update: () => void;
}

/**
 * The table of a grid with only the rows near the visible ones in the page; spacers stand for the others, and a
 * hidden row with the widest texts keeps the widths. The selected cell is the one tab stop; while it is not drawn,
 * the body holds the tab stop and the focus instead.
 */
function windowedRows(
  data: GridData,
  headers: readonly HTMLElement[],
  selected: () => readonly [number, number],
): WindowedRows {
  const kinds = rowKindsOf(data);
  // Cells before the first data cell: the row number and, in a change grid, the row mark.
  const lead = kinds ? 2 : 1;
  const body = el('tbody');
  const sizer = sizerRow([
    String(data.rows.length),
    ...(kinds ? [''] : []),
    ...widestTexts(data.columns, data.rows),
  ]);
  const { table, scroll, above, below } = gridTable(headers, body, kinds !== undefined, sizer);
  let rows: Rows = [];
  let drawn: RowWindow = { first: 0, last: 0 };
  let rowHeight = ROW_PX;
  let measured = false;

  const cellAt = (row: number, column: number): HTMLTableCellElement | undefined =>
    row < drawn.first ? undefined : body.rows[row - drawn.first]?.cells[column + lead];

  function sizeSpacers(): void {
    above.style.height = `${drawn.first * rowHeight}px`;
    below.style.height = `${(rows.length - drawn.last) * rowHeight}px`;
  }

  function draw(next: RowWindow): void {
    drawn = next;
    body.replaceChildren(
      ...rows
        .slice(next.first, next.last)
        .map((values, offset) => dataRow(data, kinds, values, next.first + offset)),
    );
    sizeSpacers();
    const cell = cellAt(...selected());
    cell?.setAttribute('tabindex', '0');
    body.tabIndex = cell === undefined && rows.length > 0 ? 0 : -1;
  }

  // The focus stays in the grid: on the selected cell, or on the body while that cell is not drawn.
  function redraw(next: RowWindow): void {
    const active = document.activeElement;
    const holding = active !== null && (active === body || active === cellAt(...selected()));
    draw(next);
    if (holding) {
      (cellAt(...selected()) ?? body).focus({ preventScroll: true });
    }
  }

  const at = (top: number, height: number) => ({ top, height, rowHeight });

  return {
    body,
    scroll,
    cellAt,
    positionOf: (row, cell) => [drawn.first + row.sectionRowIndex, cell.cellIndex - lead],
    show(next) {
      rows = next;
      table.setAttribute('aria-rowcount', String(rows.length + 1));
      redraw(rowWindow(undefined, rows.length, at(scroll.scrollTop, scroll.clientHeight)));
    },
    focusSelected() {
      const [row, column] = selected();
      if (row < drawn.first || row >= drawn.last) {
        draw(rowWindow(undefined, rows.length, at(row * rowHeight, 0)));
      }
      const cell = cellAt(row, column);
      if (cell) {
        body.tabIndex = -1;
        cell.tabIndex = 0;
        cell.focus();
      }
    },
    update() {
      const count = drawn.last - drawn.first;
      if (!measured && count > 0 && body.offsetHeight > 0) {
        measured = true;
        rowHeight = body.offsetHeight / count;
        sizeSpacers();
      }
      const next = rowWindow(drawn, rows.length, at(scroll.scrollTop, scroll.clientHeight));
      if (next !== drawn) {
        redraw(next);
      }
    },
  };
}

function gridView(data: GridData, options: GridOptions): GridView {
  // The page is not kept alive while its tab is hidden: sort and filters survive in the webview state.
  const view = restoreView(options.persist ? vscode.getState() : undefined, data);
  // A change grid keeps the order of the changes (an update is two rows), so it has no sorting or filters.
  const kinds = rowKindsOf(data);
  let sort = view.sort;
  let shown: Rows = [];
  let focusRow = 0;
  let focusColumn = 0;
  let filterTimer: ReturnType<typeof setTimeout> | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const filters = [...view.filters];
  const status = statusLine();
  const marks: HTMLElement[] = [];
  const headers = data.columns.map((column, index) => {
    if (kinds) {
      return plainHeader(column);
    }
    const mark = sortMark();
    marks[index] = mark;
    return sortableHeader(column, mark, filters[index] ?? '', {
      onSort: () => {
        sort = nextSort(sort, index);
        refresh();
      },
      onFilter: (text) => {
        filters[index] = text;
        clearTimeout(filterTimer);
        filterTimer = setTimeout(refresh, FILTER_DELAY_MS);
      },
    });
  });
  const windowed = windowedRows(data, headers, () => [focusRow, focusColumn]);

  function refresh(): void {
    const next = sortRows(filterRows(data.rows, data.columns, filters), data.columns, sort);
    const changed = next.length !== shown.length || next.some((row, index) => row !== shown[index]);
    shown = next;
    focusRow = Math.min(focusRow, Math.max(shown.length - 1, 0));
    if (changed) {
      windowed.show(shown);
    }
    if (options.persist) {
      vscode.setState(saveView(data, { sort, filters }));
    }
    status.textContent = statusText(data, shown.length);
    headers.forEach((header, index) => {
      const direction = sort?.column === index ? sort.direction : undefined;
      marks[index]?.replaceChildren(direction === 'asc' ? '▲' : direction === 'desc' ? '▼' : '');
      if (direction) {
        header.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending');
      } else {
        header.removeAttribute('aria-sort');
      }
    });
  }

  function focusCell(row: number, column: number): void {
    if (shown.length === 0 || data.columns.length === 0) {
      return;
    }
    windowed.cellAt(focusRow, focusColumn)?.setAttribute('tabindex', '-1');
    focusRow = Math.min(Math.max(row, 0), shown.length - 1);
    focusColumn = Math.min(Math.max(column, 0), data.columns.length - 1);
    windowed.focusSelected();
  }

  function textToCopy(what: CopyScope): string | undefined {
    const values = shown[focusRow];
    const column = data.columns[focusColumn];
    switch (what) {
      case 'all':
        return toTsv(data.columns, shown, true);
      case 'row':
        return values && toTsv(data.columns, [values], false);
      case 'cell': {
        if (!values || !column) {
          return undefined;
        }
        const value = values[focusColumn] ?? null;
        if (value === null) {
          notice(NULL_NOT_COPIED);
          return undefined;
        }
        return cellCopyText(value, column.kind);
      }
    }
  }

  /** Replaces the row count in the status line for a moment. */
  function notice(message: string): void {
    status.textContent = message;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      status.textContent = statusText(data, shown.length);
    }, NOTICE_MS);
  }

  function copy(what: CopyScope): void {
    const text = textToCopy(what);
    if (text !== undefined) {
      vscode.postMessage({ type: 'copy', text, what });
    }
  }

  windowed.body.addEventListener('click', (event) => {
    const cell = event.target instanceof Element ? event.target.closest('td') : null;
    const row = cell?.closest('tr');
    if (cell && row) {
      focusCell(...windowed.positionOf(row, cell));
    }
  });

  windowed.scroll.addEventListener('scroll', windowed.update, { passive: true });

  windowed.body.addEventListener('keydown', (event) => {
    const move = cursorMove(event.key, data.columns.length);
    if (move) {
      event.preventDefault();
      focusCell(focusRow + move[0], focusColumn + move[1]);
    } else if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'c' &&
      !window.getSelection()?.toString()
    ) {
      event.preventDefault();
      copy('cell');
    }
  });

  const bar = toolbar(
    [
      ['Copy cell', 'Copy the selected cell (Ctrl+C)', () => copy('cell')],
      ['Copy row', 'Copy the row of the selected cell', () => copy('row')],
      ['Copy all', 'Copy the rows shown, with the column names', () => copy('all')],
      [
        'Export CSV',
        'Save the rows shown as a CSV file',
        () => {
          vscode.postMessage({
            type: 'export',
            csv: toCsv(data.columns, shown),
            suggestedName: options.fileName,
          });
        },
      ],
    ],
    status,
  );
  refresh();
  return {
    elements: [bar, ...(data.summary ? [el('div', 'summary', data.summary)] : []), windowed.scroll],
    placed: windowed.update,
  };
}

function results(): (message: ResultsMessage) => void {
  let run: ResultsRunState | undefined;
  let chosen: TabId | undefined;
  // Built when its tab is first selected and kept, so that sort and filters stay.
  let grids = new Map<number, GridView>();
  let shown: TabId | undefined;
  // Kept for the whole run: a script of thousands of statements sends two events for each, and each one renders.
  let messages: MessagesView | undefined;
  const tabButtons = new Map<TabId, HTMLButtonElement>();
  let buttons: HTMLButtonElement[] = [];
  const tablist = el('div', 'tabs');
  tablist.setAttribute('role', 'tablist');
  const runLine = el('span', 'run');
  runLine.setAttribute('role', 'status');
  runLine.setAttribute('aria-live', 'polite');
  const bar = el('div', 'tabbar');
  bar.append(tablist, runLine);
  const pane = el('div', 'pane');
  pane.setAttribute('role', 'tabpanel');
  app.replaceChildren(bar, pane);

  tablist.addEventListener('keydown', (event) => {
    const ids = run ? tabsOf(run).map((tab) => tab.id) : [];
    const current = run ? ids.indexOf(selectedTab(run, chosen)) : 0;
    const position = tabAfterKey(event.key, current, ids.length);
    if (position !== undefined) {
      event.preventDefault();
      chosen = ids[position];
      render();
      buttons[position]?.focus();
    }
  });

  function render(): void {
    if (!run) {
      return;
    }
    const current = run;
    const selected = selectedTab(current, chosen);
    buttons = tabsOf(current).map((tab) => {
      const on = tab.id === selected;
      let button = tabButtons.get(tab.id);
      if (!button) {
        button = el('button', undefined, tab.label);
        button.setAttribute('role', 'tab');
        button.addEventListener('click', () => {
          chosen = tab.id;
          render();
        });
        tabButtons.set(tab.id, button);
      }
      button.className = on ? 'tab selected' : 'tab';
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      return button;
    });
    tablist.replaceChildren(...buttons);
    runLine.textContent = [endText(current.end), transactionText(current.end)]
      .filter((part) => part !== '')
      .join(' · ');
    if (selected === 'messages') {
      messages ??= messagesView();
      messages.update(current);
      if (shown !== selected) {
        pane.replaceChildren(messages.element);
        shown = selected;
      }
    } else if (shown !== selected) {
      let grid = grids.get(selected);
      if (!grid) {
        grid = resultView(current, selected);
        grids.set(selected, grid);
      }
      pane.replaceChildren(...grid.elements);
      grid.placed();
      shown = selected;
    }
  }

  return (message) => {
    if (message.type === 'results-begin') {
      chosen = undefined;
    }
    if (message.type === 'results-begin' || message.type === 'results-state') {
      grids = new Map();
      shown = undefined;
      messages = undefined;
      tabButtons.clear();
    }
    run = applyMessage(run, message);
    render();
  };
}

interface MessagesView {
  readonly element: HTMLElement;
  /** Builds the rows of the statements that changed since the last call and puts the rows in order. */
  update(run: ResultsRunState): void;
}

function messagesView(): MessagesView {
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
        const built = { statement, rows: statementRows(run, statement) };
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

function statementRows(run: ResultsRunState, statement: Statement): HTMLElement[] {
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
  goTo.addEventListener('click', () => vscode.postMessage({ type: 'reveal', index: statement.index }));
  const cell = el('td', 'error');
  cell.setAttribute('colspan', '5');
  cell.append(el('div', 'message', statement.error.message), goTo);
  const failed = el('tr', 'err');
  failed.append(cell);
  return [row, failed];
}

function resultView(run: ResultsRunState, index: number): GridView {
  const set: ResultSet | undefined = run.resultSets[index];
  const view = el('div', 'result');
  if (!set) {
    return { elements: [view], placed: () => undefined };
  }
  const sql = run.statements.find((statement) => statement.index === set.statement)?.sql ?? '';
  const header = el('div', 'sql', oneLine(sql, HEADER_CHARS));
  header.title = clip(sql, TITLE_CHARS);
  view.append(header);
  if (set.truncated) {
    view.append(el('div', 'banner', truncatedBanner(set)));
  }
  const number = index + 1;
  const grid = gridView(
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

let showResults: ((message: ResultsMessage) => void) | undefined;
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (isObject(message) && own(message, 'type') === 'data') {
    const data = own(message, 'data');
    if (isGridData(data)) {
      show(data);
    }
  } else if (isResultsMessage(message)) {
    showResults ??= results();
    showResults(message);
  }
});
vscode.postMessage({ type: 'ready' });
