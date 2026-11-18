/// <reference lib="dom" />
// The data grid in the page: the preview of a table and each result set of the results page. The rules (sorting,
// filtering, copying, the row window) are in model.ts; this file holds the state of one grid (the rows in view, the
// focused cell, sort and filters) and turns it into DOM.
import {
  NULL_NOT_COPIED,
  TOOLTIP_CHARS,
  cellCopyText,
  changeWording,
  clip,
  filterRows,
  nextSort,
  restoreView,
  rowWindow,
  saveView,
  sortRows,
  statusText,
  toCsv,
  toJson,
  toMarkdown,
  toTsv,
} from './model';
import type { RowWindow } from './model';
import { rowKindsOf } from './protocol';
import type { MenuCopy, PageSettings, RowsFormat, SaveFormat, WebviewMessage } from './protocol';
import {
  dataRow,
  gridTable,
  plainHeader,
  sizerRow,
  sortMark,
  sortableHeader,
  statusLine,
  toolIconButton,
  toolbar,
} from './render';
import type { ResultTab } from './result-tab';
import { columnStatistics } from './column-statistics';
import { cutNotice } from './column-summary';
import { el } from '../shell/dom';
import type { Shape } from '../shell/svg-icon';
import type { GridData, GridValue } from '../data/types';

/**
 * What the page gets from VS Code: the messages to the extension, the state that survives a hidden page, and the
 * settings that the extension sent.
 */
export interface HostPort {
  post(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
  settings(): PageSettings;
}

/** What the grid copies itself; the statistics of the columns are copied by their own part. */
type GridCopyScope = Exclude<MenuCopy, 'statistics'>;

/** The extension of a file of each format, for the name that the save dialog proposes. */
const EXTENSIONS: Readonly<Record<SaveFormat, string>> = {
  csv: 'csv',
  json: 'json',
  markdown: 'md',
  png: 'png',
};

/** Asks the extension to save `text` in `format`, proposing `<stem>.<extension>`. */
export function saveAs(host: HostPort, format: SaveFormat, text: string, stem: string): void {
  host.post({ type: 'export', format, text, suggestedName: `${stem}.${EXTENSIONS[format]}` });
}

const FILTER_DELAY_MS = 150;
const NOTICE_MS = 2000;
// The height of a row until the drawn rows are laid out and measured.
const ROW_PX = 22;

// Two sheets, one on the other, as the codicon of copying.
const COPY_ICON: readonly Shape[] = [
  ['rect', { x: '2.5', y: '5.5', width: '8', height: '9', rx: '1' }],
  ['path', { d: 'M5.5 5.5v-3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-2' }],
];
// An arrow out of a tray, as the icons of exporting.
const EXPORT_ICON: readonly Shape[] = [
  ['path', { d: 'M2.5 9.5v3a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-3' }],
  ['path', { d: 'M8 10.5v-9M4.5 5 8 1.5 11.5 5' }],
];

export interface GridOptions {
  /** Only the preview grid keeps sort and filters in the webview state. */
  readonly persist: boolean;
  /** The name that Export as File suggests, without its extension, e.g. `sales.orders`. */
  readonly fileStem: string;
  /** Asks the extension for the statistics of the columns; without it the grid has none. */
  readonly summarize?: () => void;
  /** The result set of the results page that the grid shows; the extension names it in what it asks of the grid. */
  readonly set?: number;
  /** The rows that were read of a result that was cut: its notice stands above the grid, with the statistics in one line. */
  readonly cut?: number;
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
  readonly table: HTMLTableElement;
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
  /** The rows of the header changed: the drawn rows say their place again, and a focused cell stays clear of them. */
  readonly headChanged: () => void;
}

/**
 * The table of a grid with only the rows near the visible ones in the page; spacers stand for the others, and a
 * hidden row with the widest row number keeps the width of the numbers. The selected cell is the one tab stop; while
 * it is not drawn, the body holds the tab stop and the focus instead. `more` are rows of the header below the names, of
 * which `headRows` are shown with the names.
 */
function windowedRows(
  data: GridData,
  headers: readonly HTMLElement[],
  selected: () => readonly [number, number],
  more: readonly HTMLTableRowElement[],
  headRows: () => number,
): WindowedRows {
  const kinds = rowKindsOf(data);
  // Cells before the first data cell: the row number and, in a change grid, the row mark.
  const lead = kinds ? 2 : 1;
  const body = el('tbody');
  const { table, head, scroll, above, below } = gridTable(
    headers,
    body,
    kinds === undefined ? undefined : changeWording(data.rowMode).column,
    sizerRow(data.rows.length),
    more,
  );
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
    const before = headRows();
    body.replaceChildren(
      ...rows
        .slice(next.first, next.last)
        .map((values, offset) => dataRow(data, kinds, values, next.first + offset, before)),
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

  // The rows below the sticky header: a cell that gets the focus scrolls clear of it. The header keeps its height while
  // the rows scroll, so this runs once it is on the page and when its rows change.
  let fitted = -1;
  function fitHead(): void {
    const height = head.offsetHeight;
    if (height > 0 && height !== fitted) {
      fitted = height;
      scroll.style.scrollPaddingTop = `${height}px`;
    }
  }

  const counted = (): void => table.setAttribute('aria-rowcount', String(rows.length + headRows()));
  const at = (top: number, height: number) => ({ top, height, rowHeight });

  return {
    table,
    body,
    scroll,
    cellAt,
    positionOf: (row, cell) => [drawn.first + row.sectionRowIndex, cell.cellIndex - lead],
    show(next) {
      rows = next;
      counted();
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
      if (fitted < 0) fitHead();
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
    headChanged() {
      counted();
      redraw(drawn);
      fitHead();
    },
  };
}

/**
 * The bar above a grid: one group of icon buttons, evenly spaced: the toggle of the statistics of the columns first,
 * where it is found at any width, then Copy as Markdown and Export as File; then the status line. The other copies are
 * in the context menu of the cells.
 */
function gridToolbar(
  toggle: HTMLElement | undefined,
  copyMarkdown: () => void,
  chooseExport: () => void,
  status: HTMLElement,
): HTMLElement {
  return toolbar(
    [
      [
        ...(toggle ? [toggle] : []),
        toolIconButton(
          COPY_ICON,
          'Copy as Markdown',
          'copy the rows shown as a Markdown table',
          copyMarkdown,
        ),
        toolIconButton(
          EXPORT_ICON,
          'Export as File',
          'save the rows shown as CSV, JSON or Markdown',
          chooseExport,
        ),
      ],
    ],
    status,
  );
}

/** Shows the sort in the headers: an arrow, and `aria-sort` on the header of the sorted column. */
function markSort(
  headers: readonly HTMLElement[],
  marks: readonly (HTMLElement | undefined)[],
  sort: { readonly column: number; readonly direction: 'asc' | 'desc' } | undefined,
): void {
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

/**
 * The context of the context menu of the cells (`webview/context` in package.json): the copies instead of the menu of
 * the browser, and Copy Column Statistics while the header shows the statistics.
 */
function menuContext(body: HTMLElement, statistics: boolean): void {
  body.setAttribute(
    'data-vscode-context',
    JSON.stringify({
      webviewSection: 'grid',
      preventDefaultContextMenuItems: true,
      aantjeStatistics: statistics,
    }),
  );
}

/** Ctrl+C or Cmd+C copies the selected cell, unless text is selected: then the browser copies that text. */
const copiesCell = (event: KeyboardEvent): boolean =>
  (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && !window.getSelection()?.toString();

/** The element whose text a pointer is on, when the grid cuts that text: a cell, a name, a type, a figure. */
function cutUnder(target: EventTarget | null): HTMLElement | undefined {
  const found = target instanceof Element ? target.closest('td, .cut') : null;
  return found && found.scrollWidth > found.clientWidth ? (found as HTMLElement) : undefined;
}

/** A text that the grid cuts with an ellipsis shows whole as a tooltip, once the pointer is on it. */
function tipCutTexts(scroll: HTMLElement): void {
  const tipped = new WeakSet<Element>();
  scroll.addEventListener('mouseover', (event) => {
    const cut = cutUnder(event.target);
    if (cut && !tipped.has(cut)) {
      tipped.add(cut);
      cut.title = clip(cut.textContent ?? '', TOOLTIP_CHARS);
    }
  });
}

/**
 * The text that a copy of the grid puts on the clipboard, from the rows shown and the selected cell (`at`): undefined
 * for nothing to copy, null for a NULL cell, which leaves the clipboard alone.
 */
function textToCopy(
  what: GridCopyScope,
  data: GridData,
  shown: Rows,
  at: readonly [number, number],
  nulls: PageSettings['markdownNull'],
): string | null | undefined {
  const values = shown[at[0]];
  const column = data.columns[at[1]];
  switch (what) {
    case 'all':
      return toTsv(data.columns, shown, true);
    case 'markdown':
      return toMarkdown(data.columns, shown, nulls);
    case 'row':
      return values && toTsv(data.columns, [values], false);
    case 'cell': {
      if (!values || !column) {
        return undefined;
      }
      const value = values[at[1]] ?? null;
      return value === null ? null : cellCopyText(value, column.kind);
    }
  }
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
  // The statistics of the columns, in the header; a change grid has none.
  const ask = options.summarize;
  const statistics =
    ask && !kinds
      ? columnStatistics(host, {
          columns: data.columns,
          ask,
          changed: () => statisticsChanged(),
          ...(options.cut === undefined ? {} : { cut: options.cut }),
        })
      : undefined;
  const windowed = windowedRows(
    data,
    headers,
    () => [focusRow, focusColumn],
    statistics ? [statistics.row] : [],
    () => (statistics?.showing() ? 2 : 1),
  );

  function refresh(): void {
    const next = sortRows(filterRows(data.rows, data.columns, filters), data.columns, sort);
    const changed = next.length !== shown.length || next.some((row, index) => row !== shown[index]);
    shown = next;
    focusRow = Math.min(focusRow, Math.max(shown.length - 1, 0));
    if (changed) {
      windowed.show(shown);
    }
    if (options.persist) {
      host.setState({ ...stateOf(host), ...saveView(data, { sort, filters }) });
    }
    status.textContent = statusText(data, shown.length);
    markSort(headers, marks, sort);
  }

  function statisticsChanged(): void {
    windowed.headChanged();
    menuContext(windowed.body, statistics?.showing() === true);
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

  /** Replaces the row count in the status line for a moment. */
  function notice(message: string): void {
    status.textContent = message;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      status.textContent = statusText(data, shown.length);
    }, NOTICE_MS);
  }

  function copy(what: MenuCopy): void {
    const text =
      what === 'statistics'
        ? statistics?.markdown()
        : textToCopy(what, data, shown, [focusRow, focusColumn], host.settings().markdownNull);
    if (text === null) {
      notice(NULL_NOT_COPIED);
    } else if (text !== undefined) {
      host.post({ type: 'copy', text, what });
    }
  }

  /** The cell of a click or a right-click becomes the selected one. */
  function select(target: EventTarget | null): void {
    const cell = target instanceof Element ? target.closest('td') : null;
    const row = cell?.closest('tr');
    if (cell && row) {
      focusCell(...windowed.positionOf(row, cell));
    }
  }

  windowed.body.addEventListener('click', (event) => select(event.target));
  // The context menu of VS Code then acts on this cell; the event goes on to VS Code, which opens the menu.
  windowed.body.addEventListener('contextmenu', (event) => select(event.target));

  windowed.scroll.addEventListener('scroll', windowed.update, { passive: true });
  tipCutTexts(windowed.scroll);

  windowed.body.addEventListener('keydown', (event) => {
    const move = cursorMove(event.key, data.columns.length);
    if (move) {
      event.preventDefault();
      focusCell(focusRow + move[0], focusColumn + move[1]);
    } else if (copiesCell(event)) {
      event.preventDefault();
      copy('cell');
    }
  });

  if (options.set !== undefined) {
    // The context menu names the result set, so that its commands come back to this grid.
    windowed.table.setAttribute('data-vscode-context', JSON.stringify({ aantjeSet: options.set }));
  }
  const bar = gridToolbar(
    statistics?.toggle,
    () => copy('markdown'),
    () => host.post({ type: 'chooseExport', ...(options.set === undefined ? {} : { set: options.set }) }),
    status,
  );
  refresh();
  menuContext(windowed.body, false);
  return {
    elements: [
      bar,
      ...(statistics
        ? [statistics.line]
        : options.cut === undefined
          ? []
          : [el('div', 'banner', cutNotice(options.cut))]),
      ...(data.summary ? [el('div', 'summary', data.summary)] : []),
      windowed.scroll,
    ],
    placed: () => {
      windowed.update();
      statistics?.placed();
    },
    grid: {
      summary: (state) => statistics?.receive(state),
      copy,
      exportAs: (format) => saveAs(host, format, rowsAs(format, data, shown, host), options.fileStem),
    },
  };
}

/** The webview state as an object: the preview keeps its sort and filters there. */
function stateOf(host: HostPort): Record<string, unknown> {
  const state = host.getState();
  return typeof state === 'object' && state !== null && !Array.isArray(state)
    ? { ...(state as Record<string, unknown>) }
    : {};
}

/** The rows shown as the text of a file. */
function rowsAs(format: RowsFormat, data: GridData, shown: Rows, host: HostPort): string {
  if (format === 'csv') return toCsv(data.columns, shown);
  return format === 'json'
    ? toJson(data.columns, shown)
    : toMarkdown(data.columns, shown, host.settings().markdownNull);
}
