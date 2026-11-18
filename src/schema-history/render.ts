/// <reference lib="dom" />
// DOM builders of the Schema History report; user input comes back through callbacks.
import { actionButton, empty, kindBoxes, note, searchBox, toolbar } from '../shell/blocks';
import { el } from '../shell/dom';
import { shortUtc, whoText } from '../shell/model';
import {
  CELL_KINDS,
  LEGEND,
  OLDER_NOTE,
  SCHEMA_HISTORY_KIND_LABEL,
  columnChoices,
  columnHistoryOf,
  omittedRowsNote,
  pointText,
  stateText,
} from './model';
import type { CellKind, ColumnState, ComparePoint, CompareView, SchemaHistoryData } from './model';

interface RangeHandlers {
  readonly onFrom: (id: number) => void;
  readonly onTo: (id: number) => void;
  readonly onCompare: () => void;
}

interface FilterView {
  /** Read on every change of a checkbox. */
  readonly kinds: () => ReadonlySet<CellKind>;
  readonly text: string;
}

interface FilterHandlers {
  readonly onKinds: (kinds: Set<CellKind>) => void;
  readonly onText: (text: string) => void;
}

/** A drop-down of numbered entries; `none` is a first entry for no choice. */
function picker(
  label: string,
  entries: readonly { readonly value: number; readonly text: string }[],
  current: number | undefined,
  onPick: (value: number | undefined) => void,
  none?: string,
): HTMLLabelElement {
  const wrapper = el('label', 'choice');
  const control = el('select');
  for (const { value, text } of [
    ...(none === undefined ? [] : [{ value: '', text: none }]),
    ...entries.map((entry) => ({ value: String(entry.value), text: entry.text })),
  ]) {
    const option = el('option', undefined, text);
    option.value = value;
    control.append(option);
  }
  control.value = current === undefined ? '' : String(current);
  control.addEventListener('change', () => onPick(control.value === '' ? undefined : Number(control.value)));
  wrapper.append(`${label} `, control);
  return wrapper;
}

/**
 * From and To, newest snapshot first, side by side on one line, and Compare Schema for the two. `compare` is the button,
 * so that the page can offer it for the snapshots chosen.
 */
export function rangeBar(
  points: readonly ComparePoint[],
  chosen: { readonly from: number; readonly to: number },
  on: RangeHandlers,
): { readonly element: HTMLElement; readonly compare: HTMLButtonElement } {
  const entries = points.map((point) => ({ value: point.id, text: pointText(point) })).toReversed();
  const pair = el('div', 'range-pair');
  pair.append(
    picker('From', entries, chosen.from, (id) => {
      if (id !== undefined) on.onFrom(id);
    }),
    picker('To', entries, chosen.to, (id) => {
      if (id !== undefined) on.onTo(id);
    }),
  );
  const compare = actionButton(
    'Compare Schema',
    on.onCompare,
    'Open the CREATE TABLE of the table at the two snapshots side by side in a diff editor',
  );
  const bar = toolbar(pair, compare);
  bar.setAttribute('aria-label', 'Snapshots to compare');
  return { element: bar, compare };
}

/** The filters of the comparison: the name of a column, and the kinds of change. */
export function filters(view: FilterView, on: FilterHandlers): HTMLElement {
  return toolbar(
    searchBox('Column', view.text, on.onText),
    kindBoxes(CELL_KINDS, SCHEMA_HISTORY_KIND_LABEL, view.kinds, on.onKinds),
  );
}

export function noteChildren(data: SchemaHistoryData): HTMLElement[] {
  return [
    ...(data.more ? [note(OLDER_NOTE)] : []),
    ...(data.exists ? [] : [note('The table was dropped; the columns it had are listed.')]),
  ];
}

const heading = (label: string, point: ComparePoint): HTMLTableCellElement => {
  const cell = el('th');
  cell.append(label, el('span', 'time', pointText(point)));
  return cell;
};

const stateCell = (state: ColumnState | null | undefined, name: string): HTMLTableCellElement =>
  state ? el('td', 'state', stateText(state, name)) : el('td', 'state absent', '–');

/** The columns with their state at the two snapshots and what changed between them, or why there is none. */
export function comparison(
  view: CompareView,
  points: { readonly from: ComparePoint | undefined; readonly to: ComparePoint | undefined },
): HTMLElement[] {
  const { from, to } = points;
  if (!from || !to) {
    return [empty('No schema change of this table is recorded in the catalog.')];
  }
  if (view.rows.length === 0) {
    return [empty('No column matches the filters.')];
  }
  const head = el('tr');
  head.append(
    el('th', undefined, 'Column'),
    heading('From', from),
    heading('To', to),
    el('th', undefined, 'Changes'),
  );
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  for (const row of view.rows) {
    const { column } = row;
    const name = column.path.at(-1) ?? '';
    const label = el('td', 'name');
    label.style.paddingLeft = `${10 + (column.path.length - 1) * 16}px`;
    label.append(name);
    if (column.formerNames.length > 0) {
      label.append(el('span', 'former', ` (formerly ${column.formerNames.join(', ')})`));
    }
    const changes = el('td', 'changes');
    changes.append(...row.changes.map((change) => el('div', undefined, change.text)));
    const line = el('tr');
    line.append(label, stateCell(row.from, name), stateCell(row.to, name), changes);
    tbody.append(line);
  }
  const table = el('table', 'comparison');
  table.append(thead, tbody);
  const box = el('div', 'table-scroll');
  box.append(table);
  return [
    ...(view.omittedRows > 0 ? [note(omittedRowsNote(view.omittedRows), 'warning')] : []),
    box,
    el('p', 'note legend', LEGEND),
  ];
}

/** The drop-down of every column the table had, for Search Changes. */
export const columnBar = (
  data: SchemaHistoryData,
  column: number | undefined,
  onColumn: (id: number | undefined) => void,
): HTMLElement =>
  toolbar(
    picker(
      'Column',
      columnChoices(data).map(({ id, label }) => ({ value: id, text: label })),
      column,
      onColumn,
      'Choose a column',
    ),
  );

/** Every change of the column, newest first, with its snapshot, time, author and message; or a hint. */
export function columnHistory(data: SchemaHistoryData, column: number | undefined): HTMLElement {
  if (column === undefined) {
    return empty('Choose a column to list every change of its schema, from the newest snapshot back.');
  }
  const rows = columnHistoryOf(data, column);
  if (rows.length === 0) {
    return empty('No change of this column is recorded.');
  }
  const head = el('tr');
  for (const text of ['Snapshot', 'Time (UTC)', 'Change', 'Author and message']) {
    head.append(el('th', undefined, text));
  }
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  for (const { snapshot, text } of rows) {
    const line = el('tr');
    line.append(
      el('td', undefined, `@${snapshot.id}`),
      el('td', undefined, snapshot.time === null ? 'expired' : shortUtc(snapshot.time)),
      el('td', 'change', text),
      el('td', 'who', whoText(snapshot.author, snapshot.message)),
    );
    tbody.append(line);
  }
  const table = el('table', 'column-history');
  table.append(thead, tbody);
  const box = el('div', 'table-scroll');
  box.append(table);
  return box;
}
