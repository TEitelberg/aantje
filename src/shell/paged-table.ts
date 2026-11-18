/// <reference lib="dom" />
// A table that a filter box narrows and that shows its rows a page at a time. The first cell of each row is a button
// that selects it, or its text in a table whose rows are not picked; the page keeps the selection and is told about the
// text of the box and the page shown. The module needs nothing of the shell but `el`; its rules are PAGED_TABLE_CSS,
// which the stylesheet of the shell includes.
import { el } from './dom';

/** The rows of a page when the report names no other number: about one screen of a report. */
export const PAGE_ROWS = 50;

/** A column: its heading, the class of its cells (`number` aligns them right), and a longer name for its heading. */
export interface PagedColumn {
  readonly label: string;
  readonly className?: string;
  /** The tooltip of the heading and what a screen reader says for it. */
  readonly description?: string;
}

/** A row: the key that selects it, the text of its button, the other cells, and the text that the filter box searches. */
export interface PagedRow<Key> {
  readonly key: Key;
  /** The text of the button in the first cell; the filter box searches it too. */
  readonly label: string;
  /** What a screen reader says for the button; the label when absent. */
  readonly description?: string;
  /** The cells after the first, one per column: a text, or an element that goes into the cell. */
  readonly cells: readonly (string | HTMLElement)[];
  /** What else the filter box looks in, regardless of case. */
  readonly search: string;
}

/** The text of the filter box and the page shown, counted from 0. */
export interface PagedView {
  readonly text: string;
  readonly page: number;
}

export interface PagedTableSpec<Key> {
  /** The first column holds the buttons of the rows. */
  readonly columns: readonly PagedColumn[];
  /** In the order of the table. */
  readonly rows: readonly PagedRow<Key>[];
  /** `PAGE_ROWS` when absent. */
  readonly pageSize?: number;
  /** A row in words, one and many: `['snapshot', 'snapshots']`. */
  readonly noun: readonly [string, string];
  /** Instead of the table when the filter box leaves no row. */
  readonly noMatch: string;
  /** Instead of the table when there is no row at all; `noMatch` when absent. */
  readonly none?: string;
  /** The text of the filter box to start with. */
  readonly text?: string;
  /** The page to start with; without one, the page of the selected row, else the first. */
  readonly page?: number | undefined;
  readonly selected?: Key | undefined;
  /** A second row with a mark of its own, such as the second snapshot of a comparison. */
  readonly other?: Key | undefined;
  /**
   * A click on the button of a row, or Enter on it; `extend` when Ctrl or Cmd was held. Without it the first cell holds
   * the label as text, and a click on a row does nothing.
   */
  readonly onSelect?: (key: Key, extend: boolean) => void;
  /** The text of the box or the page changed. */
  readonly onChange?: (view: PagedView) => void;
}

export interface PagedTable<Key> {
  /** The filter box and the pages, for above the table; other blocks may go between them and the table. */
  readonly controls: HTMLElement;
  /** The rows of the page shown, or the note that none are left. */
  readonly table: HTMLElement;
  /** Marks the selected row and the second one; the marks follow to every page. */
  mark(selected: Key | undefined, other?: Key): void;
  readonly view: PagedView;
}

/** The rows whose label or search text holds the text of the box, regardless of case; all rows for an empty box. */
export function filterRows<Row extends Pick<PagedRow<unknown>, 'label' | 'search'>>(
  rows: readonly Row[],
  text: string,
): Row[] {
  const wanted = text.trim().toLowerCase();
  return wanted === ''
    ? [...rows]
    : rows.filter(
        (row) => row.label.toLowerCase().includes(wanted) || row.search.toLowerCase().includes(wanted),
      );
}

/** The pages that `rows` rows fill; one also for none. */
export const pageCount = (rows: number, size: number): number => Math.max(1, Math.ceil(rows / size));

/** The page inside the pages that `rows` rows fill. */
export const clampPage = (page: number, rows: number, size: number): number =>
  Math.min(Math.max(Math.trunc(page), 0), pageCount(rows, size) - 1);

/** The page that holds the row of `key`; undefined when no row has it. */
export function pageOfKey<Key>(
  rows: readonly { readonly key: Key }[],
  key: Key | undefined,
  size: number,
): number | undefined {
  const index = key === undefined ? -1 : rows.findIndex((row) => row.key === key);
  return index < 0 ? undefined : Math.floor(index / size);
}

const NUMBER = new Intl.NumberFormat('en-US');

/** `Page 2 of 3 · 120 snapshots`; `7 of 120 snapshots` while the filter box leaves fewer rows than there are. */
export function pagerText(
  page: number,
  pages: number,
  left: number,
  all: number,
  [one, many]: readonly [string, string],
): string {
  const rows = `${NUMBER.format(all)} ${all === 1 ? one : many}`;
  return `Page ${page + 1} of ${pages} · ${left === all ? rows : `${NUMBER.format(left)} of ${rows}`}`;
}

const MOVES = [
  { move: 'first', text: 'First', name: 'First page' },
  { move: 'previous', text: 'Previous', name: 'Previous page' },
  { move: 'next', text: 'Next', name: 'Next page' },
  { move: 'last', text: 'Last', name: 'Last page' },
] as const;

type Move = (typeof MOVES)[number]['move'];

/**
 * The filter box with the pages, and the table of one page. Typing goes to the first page; the buttons of the pages
 * stay in the tab order and do nothing at the ends, so that the focus stays where it is; the place and the count are
 * a status that a screen reader reads out.
 */
export function pagedTable<Key>(spec: PagedTableSpec<Key>): PagedTable<Key> {
  const size = spec.pageSize ?? PAGE_ROWS;
  let text = spec.text ?? '';
  let left = filterRows(spec.rows, text);
  let page =
    spec.page === undefined
      ? (pageOfKey(left, spec.selected, size) ?? 0)
      : clampPage(spec.page, left.length, size);
  let selected = spec.selected;
  let other = spec.other;
  let marks = new Map<Key, { readonly row: HTMLElement; readonly pick: HTMLElement | undefined }>();

  const input = el('input');
  input.type = 'search';
  input.value = text;
  const search = el('label', 'search');
  search.append('Filter ', input);
  const status = el('span', 'pager-status');
  status.setAttribute('role', 'status');
  const buttons = MOVES.map(({ move, text: label, name }) => {
    const button = el('button', 'action', label);
    button.setAttribute('aria-label', name);
    button.addEventListener('click', () => turn(move));
    return { move, button };
  });
  const pager = el('div', 'pager');
  pager.setAttribute('role', 'group');
  pager.setAttribute('aria-label', 'Pages');
  // The place between Previous and Next.
  const parts: HTMLElement[] = buttons.map(({ button }) => button);
  parts.splice(2, 0, status);
  pager.append(...parts);
  const controls = el('div', 'toolbar paged-controls');
  controls.append(search, pager);

  const head = el('tr');
  for (const column of spec.columns) {
    const heading = el('th', column.className, column.label);
    if (column.description !== undefined) {
      heading.title = column.description;
      heading.setAttribute('aria-label', column.description);
    }
    head.append(heading);
  }
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  const grid = el('table');
  grid.append(thead, tbody);
  const box = el('div', 'table-scroll paged-table');
  box.append(grid);
  const table = el('div', 'paged');

  function pickOf(entry: PagedRow<Key>, onSelect: NonNullable<PagedTableSpec<Key>['onSelect']>): HTMLElement {
    const pick = el('button', 'pick', entry.label);
    pick.setAttribute('aria-label', entry.description ?? entry.label);
    pick.addEventListener('click', (event) => onSelect(entry.key, event.ctrlKey || event.metaKey));
    return pick;
  }

  function rowOf(entry: PagedRow<Key>): HTMLElement {
    const pick = spec.onSelect ? pickOf(entry, spec.onSelect) : undefined;
    const cell = el('td', spec.columns[0]?.className);
    cell.append(pick ?? entry.label);
    const row = el('tr');
    row.append(
      cell,
      ...entry.cells.map((content, index) => {
        const data = el('td', spec.columns[index + 1]?.className);
        data.append(content);
        return data;
      }),
    );
    marks.set(entry.key, { row, pick });
    return row;
  }

  function paint(): void {
    for (const [key, { row, pick }] of marks) {
      row.className = [key === selected ? 'selected' : '', key === other ? 'other' : '']
        .filter(Boolean)
        .join(' ');
      pick?.setAttribute('aria-pressed', String(key === selected));
    }
  }

  function draw(): void {
    const pages = pageCount(left.length, size);
    status.textContent = pagerText(page, pages, left.length, spec.rows.length, spec.noun);
    for (const { move, button } of buttons) {
      const inert = move === 'first' || move === 'previous' ? page === 0 : page === pages - 1;
      button.setAttribute('aria-disabled', String(inert));
    }
    marks = new Map();
    tbody.replaceChildren(...left.slice(page * size, (page + 1) * size).map(rowOf));
    table.replaceChildren(
      left.length > 0
        ? box
        : el('p', 'empty', spec.rows.length === 0 ? (spec.none ?? spec.noMatch) : spec.noMatch),
    );
    paint();
  }

  function changed(): void {
    draw();
    spec.onChange?.({ text, page });
  }

  function turn(move: Move): void {
    const target = clampPage(
      move === 'first' ? 0 : move === 'previous' ? page - 1 : move === 'next' ? page + 1 : Infinity,
      left.length,
      size,
    );
    if (target !== page) {
      page = target;
      changed();
    }
  }

  input.addEventListener('input', () => {
    text = input.value;
    left = filterRows(spec.rows, text);
    page = 0;
    changed();
  });

  draw();
  return {
    controls,
    table,
    mark(nextSelected, nextOther) {
      selected = nextSelected;
      other = nextOther;
      paint();
    },
    get view() {
      return { text, page };
    },
  };
}

/** The filter box and the pages beside it, the inert buttons at the ends, and the marked rows. */
export const PAGED_TABLE_CSS = `
.pager { display: flex; flex-wrap: wrap; align-items: center; margin-left: auto; }
.pager-status { margin: 0 8px 0 4px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.pager button[aria-disabled="true"] { opacity: 0.5; cursor: default; }
.pager button[aria-disabled="true"]:hover { background: var(--vscode-button-secondaryBackground); }
.paged-table { margin-top: var(--aantje-control-gap); }
.paged-table th.number, .paged-table td.number { text-align: right; }
.paged-table tr.selected td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.paged-table tr.other td { border-bottom: 2px dashed var(--aantje-accent, var(--vscode-focusBorder)); }
`;
