/// <reference lib="dom" />
// The data grid in the page: the preview of a table and each result set of the results page. The rules (sorting,
// filtering, copying, the row window) are in model.ts; this file holds the state of one grid (the rows in view, the
// focused cell, sort and filters) and turns it into DOM.
import {
  NULL_NOT_COPIED,
  cellCopyText,
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
import { rowKindsOf } from './protocol';
import type { CopyScope, WebviewMessage } from './protocol';
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
import type { ResultTab } from './result-tab';
import { el } from '../shell/dom';
import type { GridData, GridValue } from '../data/types';

/** What the page gets from VS Code: the messages to the extension, and the state that survives a hidden page. */
export interface HostPort {
  post(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

/** What the grid copies; the whole text of a profile or plan has its own button. */
type GridCopyScope = Exclude<CopyScope, 'text'>;

const FILTER_DELAY_MS = 150;
const NOTICE_MS = 2000;
// The height of a row until the drawn rows are laid out and measured.
const ROW_PX = 22;

export interface GridOptions {
  /** Only the preview grid keeps sort and filters in the webview state. */
  readonly persist: boolean;
  /** The name that Export CSV suggests. */
  readonly fileName: string;
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

/** The buttons above a grid: the three copies and Export CSV, then the status line. */
function gridToolbar(
  copy: (what: GridCopyScope) => void,
  exportCsv: () => void,
  status: HTMLElement,
): HTMLElement {
  return toolbar(
    [
      ['Copy cell', 'Copy the selected cell (Ctrl+C)', () => copy('cell')],
      ['Copy row', 'Copy the row of the selected cell', () => copy('row')],
      ['Copy all', 'Copy the rows shown, with the column names', () => copy('all')],
      ['Export CSV', 'Save the rows shown as a CSV file', exportCsv],
    ],
    status,
  );
}

export function gridView(host: HostPort, data: GridData, options: GridOptions): ResultTab {
  // The page is not kept alive while its tab is hidden: sort and filters survive in the webview state.
  const view = restoreView(options.persist ? host.getState() : undefined, data);
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
      host.setState(saveView(data, { sort, filters }));
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

  function textToCopy(what: GridCopyScope): string | undefined {
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

  function copy(what: GridCopyScope): void {
    const text = textToCopy(what);
    if (text !== undefined) {
      host.post({ type: 'copy', text, what });
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

  const bar = gridToolbar(
    copy,
    () => host.post({ type: 'export', csv: toCsv(data.columns, shown), suggestedName: options.fileName }),
    status,
  );
  refresh();
  return {
    elements: [bar, ...(data.summary ? [el('div', 'summary', data.summary)] : []), windowed.scroll],
    placed: windowed.update,
  };
}
