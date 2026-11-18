/// <reference lib="dom" />
// DOM builders of a data grid. They take the state as parameters and report input through callbacks.
import { cellDisplay, changeWording, changedColumns } from './model';
import type { GridData, GridValue, RowKind } from '../data/types';
import { el } from '../shell/dom';
import { svgIcon } from '../shell/svg-icon';
import type { Shape } from '../shell/svg-icon';

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

/** The name and the type of a column; each is cut with an ellipsis in the width of the column, the type first. */
function nameAndType(column: GridData['columns'][number]): HTMLElement[] {
  return [el('span', 'name cut', column.name), el('span', 'type cut', column.type)];
}

/** Header of a change grid column: no sorting, no filter. */
export function plainHeader(column: GridData['columns'][number]): HTMLTableCellElement {
  const head = el('div', 'head');
  head.append(...nameAndType(column));
  const header = el('th');
  header.append(head);
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
  const sorter = el('button', 'head');
  sorter.append(...nameAndType(column), mark);
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

/**
 * One data row; `kinds` marks the rows of a change grid. `head` is the number of rows of the header, which come before
 * the first data row for assistive technology.
 */
export function dataRow(
  data: GridData,
  kinds: readonly RowKind[] | undefined,
  values: readonly GridValue[],
  index: number,
  head: number,
): HTMLTableRowElement {
  const row = el('tr');
  // Only some rows are in the page: the position of a data row counts the rows of the header before it.
  row.setAttribute('aria-rowindex', String(index + head + 1));
  row.append(el('td', 'rn', String(index + 1)));
  const kind = kinds?.[index];
  const changed = kinds ? changedColumns(data.rows, kinds, index) : new Set<number>();
  const wording = changeWording(data.rowMode);
  if (kind) {
    const { mark, label } = wording.marks[kind];
    const marker = el('td', 'mk', mark);
    marker.title = label;
    marker.setAttribute('aria-label', label);
    row.className = `chg-${kind}`;
    row.append(marker);
  }
  data.columns.forEach((column, columnIndex) => {
    const { text, isNull, label } = cellDisplay(values[columnIndex] ?? null, column.kind);
    const cell = el('td', undefined, text);
    cell.tabIndex = -1;
    cell.classList.toggle('num', column.kind === 'number');
    cell.classList.toggle('null', isNull);
    cell.classList.toggle('changed', changed.has(columnIndex));
    // A value that the cell cuts gets its tooltip once the pointer is on it (grid-view.ts).
    if (changed.has(columnIndex)) {
      cell.title = wording.changed;
    }
    if (label) {
      cell.setAttribute('aria-label', label);
    }
    row.append(cell);
  });
  return row;
}

/** A button of the toolbar with its tooltip. */
export function toolButton(label: string, title: string, run: () => void): HTMLButtonElement {
  const button = el('button', undefined, label);
  button.title = title;
  button.addEventListener('click', run);
  return button;
}

/**
 * A button of the toolbar that shows only its icon, drawn as a button like the others of the bar: `label` is what a
 * screen reader says, the tooltip starts with it and says what the button does.
 */
export function toolIconButton(
  shapes: readonly Shape[],
  label: string,
  title: string,
  run?: () => void,
): HTMLButtonElement {
  const button = el('button', 'tool-icon');
  button.title = `${label}: ${title}`;
  button.setAttribute('aria-label', label);
  button.append(svgIcon(shapes));
  if (run) button.addEventListener('click', run);
  return button;
}

/**
 * The bar above a grid: groups of controls, then the status line. On a narrow panel the bar wraps between the groups
 * (and inside a group that is wider than the panel), so that no control runs off the edge; a label never breaks.
 */
export function toolbar(groups: readonly (readonly HTMLElement[])[], status: HTMLElement): HTMLElement {
  const bar = el('div', 'toolbar');
  for (const controls of groups) {
    if (controls.length === 0) continue;
    const group = el('div', 'tool-group');
    group.append(...controls);
    bar.append(group);
  }
  bar.append(status);
  return bar;
}

/**
 * A row that takes no space but holds the widest row number, so that the drawn rows cannot change the width of the
 * column of the numbers; the data columns have a fixed width.
 */
export function sizerRow(rows: number): HTMLTableRowElement {
  const row = el('tr', 'sizer');
  row.setAttribute('aria-hidden', 'true');
  row.append(el('td', 'rn', String(rows)));
  return row;
}

/**
 * The scrolling table around the header and the body, between spacers that stand for the rows not drawn. `kindTitle`
 * is the title of the column of the marks of a change grid; there is no such column without it. `more` are rows of the
 * header below the names, such as the statistics of the columns.
 */
export function gridTable(
  headers: readonly HTMLElement[],
  body: HTMLTableSectionElement,
  kindTitle: string | undefined,
  sizer: HTMLTableRowElement,
  more: readonly HTMLTableRowElement[] = [],
): {
  readonly table: HTMLTableElement;
  readonly head: HTMLTableSectionElement;
  readonly scroll: HTMLElement;
  readonly above: HTMLElement;
  readonly below: HTMLElement;
} {
  const markHeader = el('th', 'mk');
  markHeader.title = kindTitle ?? '';
  const names = el('tr');
  names.setAttribute('aria-rowindex', '1');
  names.append(el('th', 'rn', '#'), ...(kindTitle === undefined ? [] : [markHeader]), ...headers);
  const head = el('thead');
  head.append(names, ...more, sizer);
  const table = el('table', 'grid');
  table.append(head, body);
  const above = el('div');
  const below = el('div');
  const scroll = el('div', 'scroll');
  scroll.append(above, table, below);
  return { table, head, scroll, above, below };
}
