/// <reference lib="dom" />
// DOM builders of the Details page. They take the state they show and report user input through callbacks.
import { MAINTENANCE_LABEL } from '../maintenance/labels';
import { actionButton, dataTable, empty, note } from '../shell/blocks';
import { el } from '../shell/dom';
import { LIST_ROWS } from '../shell/model';
import { shownList } from './model';
import type { Column, DetailsData, DetailsMacro, DetailsObject, DetailsView, Sort } from './model';
import type { DetailsActionId, RowKind } from './protocol';

type Row = DetailsObject | DetailsMacro;

export const rowKind = (row: Row): RowKind =>
  row.kind === 'table' || row.kind === 'view' ? row.kind : 'macro';

/** The key of a row in the selection and the saved state: its kind and id. */
export const rowKey = (row: Row): string => `${rowKind(row)}:${row.id}`;

// The actions of a row by its kind: what the menu of its node in the tree offers.
const ROW_ACTIONS: readonly {
  readonly id: Exclude<DetailsActionId, 'copy'>;
  readonly label: string;
  readonly kinds: readonly RowKind[];
}[] = [
  { id: 'showInTree', label: 'Show in Tree', kinds: ['table', 'view', 'macro'] },
  { id: 'preview', label: 'Select Top 1000 Rows', kinds: ['table', 'view'] },
  { id: 'showStatistics', label: 'Statistics', kinds: ['table'] },
  { id: 'showSchemaHistory', label: 'Schema History', kinds: ['table'] },
  { id: 'showDependencies', label: 'Dependencies', kinds: ['table', 'view', 'macro'] },
  { id: 'scriptMerge', label: MAINTENANCE_LABEL.merge, kinds: ['table'] },
  { id: 'scriptRewrite', label: MAINTENANCE_LABEL.rewrite, kinds: ['table'] },
  { id: 'scriptFlush', label: MAINTENANCE_LABEL.flush, kinds: ['table'] },
];

/** The box of the selected row with the buttons of its actions; a hint while none is selected. */
function selectionBox(row: Row | undefined, act: (action: DetailsActionId, row: Row) => void): HTMLElement {
  if (!row) return note('Select a row by its name to see what you can do with it.');
  const name = `${row.schema}.${row.name}`;
  const box = el('div', 'selection');
  const actions = el('div', 'actions');
  actions.append(
    ...ROW_ACTIONS.filter(({ kinds }) => kinds.includes(rowKind(row))).map(({ id, label }) =>
      actionButton(label, () => act(id, row), `${label} of ${name}`),
    ),
  );
  box.append(el('h3', undefined, name), actions);
  return box;
}

function headingCell(
  column: Column<never>,
  sort: Sort,
  onSort: (sort: Sort) => void,
  buttons: Map<string, HTMLElement>,
): HTMLTableCellElement {
  const th = el('th', column.number ? 'number' : undefined);
  const sortedBy = sort.key === column.key;
  th.setAttribute('aria-sort', sortedBy ? (sort.descending ? 'descending' : 'ascending') : 'none');
  const button = el('button', 'sort', column.label);
  // A number sorts the largest first, a text from A.
  button.addEventListener('click', () =>
    onSort({ key: column.key, descending: sortedBy ? !sort.descending : column.number === true }),
  );
  buttons.set(column.key, button);
  th.append(button);
  return th;
}

interface ListHandlers {
  readonly onSort: (sort: Sort) => void;
  readonly onPick: (key: string) => void;
  readonly act: (action: DetailsActionId, row: Row) => void;
}

/** The selection, the sortable list and its truncation; the buttons come back by row and column to restore the focus. */
export function listChildren(
  data: DetailsData,
  view: DetailsView,
  selected: string | undefined,
  on: ListHandlers,
): {
  readonly children: HTMLElement[];
  readonly picks: ReadonlyMap<string, HTMLElement>;
  readonly headings: ReadonlyMap<string, HTMLElement>;
} {
  const { columns, rows, cells } = shownList(data, view);
  const headings = new Map<string, HTMLElement>();
  const picks = new Map<string, HTMLElement>();
  const shown = rows.slice(0, LIST_ROWS);
  const tableRows = shown.map((row, index) => {
    const tr = el('tr');
    tr.className = rowKey(row) === selected ? 'selected' : '';
    (cells[index] ?? []).forEach((cell, at) => {
      const column = columns[at];
      if (column?.key !== 'name') {
        tr.append(el('td', column?.number ? 'number' : undefined, cell.text));
        return;
      }
      const td = el('td', 'name');
      const pick = el('button', 'pick', cell.text);
      pick.setAttribute('aria-pressed', String(rowKey(row) === selected));
      pick.addEventListener('click', () => on.onPick(rowKey(row)));
      picks.set(rowKey(row), pick);
      td.append(pick);
      tr.append(td);
    });
    return tr;
  });
  const filter = view.filter.trim();
  const children = [
    selectionBox(
      rows.find((row) => rowKey(row) === selected),
      on.act,
    ),
    rows.length === 0
      ? empty(filter === '' ? 'Nothing to show.' : `No object matches "${filter}".`)
      : dataTable(
          (columns as readonly Column<never>[]).map((column) =>
            headingCell(column, view.sort, on.onSort, headings),
          ),
          tableRows,
        ),
    ...(rows.length > shown.length
      ? [note(`${shown.length} of ${rows.length} rows are shown. Type in the filter box to find the others.`)]
      : []),
  ];
  return { children, picks, headings };
}
