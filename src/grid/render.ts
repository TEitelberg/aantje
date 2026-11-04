/// <reference lib="dom" />
// DOM builders of a data grid. They take the state as parameters and report input through callbacks.
import { ROW_MARKS, cellDisplay, changedColumns } from './model';
import type { GridData, GridValue, RowKind } from '../data/types';
import { el } from '../shell/dom';

/** The element that announces the row count and short notices. */
export function statusLine(): HTMLElement {
  const status = el('span', 'status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  return status;
}

/** The sort arrow of a column header; filled in by `refresh`. */
export function sortMark(): HTMLElement {
  const mark = el('span', 'mark');
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

/** Header of a change grid column: no sorting, no filter. */
export function plainHeader(column: GridData['columns'][number]): HTMLTableCellElement {
  const header = el('th');
  header.append(el('span', 'name', column.name), el('span', 'type', column.type));
  return header;
}

interface HeaderHandlers {
  readonly onSort: () => void;
  readonly onFilter: (text: string) => void;
}

/** Header with a sort button and a filter box. */
export function sortableHeader(
  column: GridData['columns'][number],
  mark: HTMLElement,
  filter: string,
  handlers: HeaderHandlers,
): HTMLTableCellElement {
  const sorter = el('button');
  sorter.append(el('span', 'name', column.name), el('span', 'type', column.type), mark);
  sorter.addEventListener('click', handlers.onSort);
  const input = el('input');
  input.placeholder = 'filter';
  input.value = filter;
  input.title = 'Text to find in this column. NULL shows the NULL cells, !NULL the others.';
  input.setAttribute('aria-label', `Filter ${column.name}`);
  input.addEventListener('input', () => handlers.onFilter(input.value));
  const header = el('th');
  header.append(sorter, input);
  return header;
}

/** One data row; `kinds` marks the rows of a change grid. */
export function dataRow(
  data: GridData,
  kinds: readonly RowKind[] | undefined,
  values: readonly GridValue[],
  index: number,
): HTMLTableRowElement {
  const row = el('tr');
  // Only some rows are in the page: the header row is the first, so a data row is its index plus two.
  row.setAttribute('aria-rowindex', String(index + 2));
  row.append(el('td', 'rn', String(index + 1)));
  const kind = kinds?.[index];
  const changed = kinds ? changedColumns(data.rows, kinds, index) : new Set<number>();
  if (kind) {
    const { mark, label } = ROW_MARKS[kind];
    const marker = el('td', 'mk', mark);
    marker.title = label;
    marker.setAttribute('aria-label', label);
    row.className = `chg-${kind}`;
    row.append(marker);
  }
  data.columns.forEach((column, columnIndex) => {
    const { text, isNull, title, label } = cellDisplay(values[columnIndex] ?? null, column.kind);
    const cell = el('td', undefined, text);
    cell.tabIndex = -1;
    cell.classList.toggle('num', column.kind === 'number');
    cell.classList.toggle('null', isNull);
    cell.classList.toggle('changed', changed.has(columnIndex));
    if (title) {
      cell.title = title;
    } else if (changed.has(columnIndex)) {
      cell.title = 'Changed by the update';
    }
    if (label) {
      cell.setAttribute('aria-label', label);
    }
    row.append(cell);
  });
  return row;
}

/** Copy and export buttons followed by the status line. */
export function toolbar(
  actions: readonly (readonly [string, string, () => void])[],
  status: HTMLElement,
): HTMLElement {
  const bar = el('div', 'toolbar');
  for (const [label, title, run] of actions) {
    const button = el('button', undefined, label);
    button.title = title;
    button.addEventListener('click', run);
    bar.append(button);
  }
  bar.append(status);
  return bar;
}

/** A row that takes no space but holds the widest text of each column, so the drawn rows cannot change the widths. */
export function sizerRow(texts: readonly string[]): HTMLTableRowElement {
  const row = el('tr', 'sizer');
  row.setAttribute('aria-hidden', 'true');
  row.append(...texts.map((text) => el('td', undefined, text)));
  return row;
}

/** The scrolling table around the header cells and the body, between spacers that stand for the rows not drawn. */
export function gridTable(
  headers: readonly HTMLElement[],
  body: HTMLTableSectionElement,
  withKind: boolean,
  sizer: HTMLTableRowElement,
): {
  readonly table: HTMLTableElement;
  readonly scroll: HTMLElement;
  readonly above: HTMLElement;
  readonly below: HTMLElement;
} {
  const markHeader = el('th', 'mk');
  markHeader.title = 'Kind of the change';
  const head = el('tr');
  head.setAttribute('aria-rowindex', '1');
  head.append(el('th', 'rn', '#'), ...(withKind ? [markHeader] : []), ...headers);
  const thead = el('thead');
  thead.append(head, sizer);
  const table = el('table');
  table.append(thead, body);
  const above = el('div');
  const below = el('div');
  const scroll = el('div', 'scroll');
  scroll.append(above, table, below);
  return { table, scroll, above, below };
}
