/// <reference lib="dom" />
// DOM builders of the Schema History report; user input comes back through callbacks.
import {
  actionButton,
  empty,
  kindBoxes,
  note,
  rangeFields,
  searchBox,
  toolbar,
  whoLine,
} from '../shell/blocks';
import { el } from '../shell/dom';
import { shortUtcMinutes, tableLabel } from '../shell/model';
import { schemaHistoryCompareTargets } from './actions';
import type { SchemaHistoryActionRequest, SchemaHistoryCompareTarget } from './actions';
import {
  CELL_KINDS,
  SCHEMA_HISTORY_KIND_LABEL,
  OLDER_NOTE,
  columnLabel,
  eventText,
  omittedRowsNote,
  schemaHistoryDetailOf,
} from './model';
import type { CellKind, SchemaHistoryData, SchemaHistoryView } from './model';

/** A selection marks these without redrawing the matrix, so that the focus stays. */
interface MatrixCell {
  readonly button: HTMLElement;
  readonly cell: HTMLElement;
  readonly snapshot: number;
  readonly column: number;
}

export interface MatrixParts {
  readonly element: HTMLElement;
  readonly cells: MatrixCell[];
  readonly headings: Map<number, HTMLElement>;
}

interface FilterView {
  readonly data: SchemaHistoryData;
  /** Read on every change of a checkbox. */
  readonly kinds: () => ReadonlySet<CellKind>;
  readonly text: string;
  readonly range: () => { readonly from: number; readonly to: number };
}

interface FilterHandlers {
  readonly onKinds: (kinds: Set<CellKind>) => void;
  readonly onText: (text: string) => void;
  readonly onRange: (end: 'from' | 'to', value: number) => void;
}

// The matrix column is narrow: the minute is enough there, the detail pane has the second.
const shortTime = (time: string | null): string => (time === null ? 'expired' : shortUtcMinutes(time));

const compareLabel = ({ against, snapshot }: SchemaHistoryCompareTarget): string => `${against} @${snapshot}`;

/** The pane of the selected snapshot, or the hint to select one. */
export function detailChildren(
  data: SchemaHistoryData,
  selected: number | undefined,
  column: number | undefined,
  ask: (request: SchemaHistoryActionRequest) => void,
): HTMLElement[] {
  const facts = selected === undefined ? undefined : schemaHistoryDetailOf(data, selected);
  if (!facts) {
    return [note('Select a cell or a snapshot in the matrix to see what changed.')];
  }
  const { snapshot } = facts;
  const targets = schemaHistoryCompareTargets(facts, data.latest);
  const actions = el('div', 'actions');
  actions.append(
    actionButton(`Show catalog at @${snapshot.id}`, () =>
      ask({ action: 'showCatalog', snapshot: snapshot.id }),
    ),
    ...(snapshot.exists
      ? [
          actionButton(
            'Query...',
            () => ask({ action: 'query', snapshot: snapshot.id }),
            `Query ${tableLabel(data)} at @${snapshot.id}`,
          ),
        ]
      : []),
    ...(targets.length > 0 ? [el('span', 'label', 'Compare Schema with')] : []),
    ...targets.map((target) =>
      actionButton(
        compareLabel(target),
        () => ask({ action: 'compareSchema', snapshot: snapshot.id, against: target.against }),
        `Compare the schema of ${tableLabel(data)} at @${snapshot.id} with ${compareLabel(target)}`,
      ),
    ),
    ...(data.exists
      ? [
          actionButton(
            'Script as ALTER',
            () => ask({ action: 'scriptAlter' }),
            `Open the ALTER template of ${tableLabel(data)} (its newest state)`,
          ),
        ]
      : []),
  );
  const changes = el('ul', 'changes');
  for (const change of facts.changes) {
    const item = el('li', change.columnId === column ? 'selected' : undefined);
    item.append(el('span', 'name', change.column), change.text);
    changes.append(item);
  }
  return [
    el('h2', undefined, `@${snapshot.id} · ${facts.timeText}`),
    ...whoLine(snapshot.author, snapshot.message),
    ...snapshot.events.map((event) => el('p', undefined, `Table ${eventText(event)}`)),
    actions,
    ...(facts.changes.length > 0 ? [el('h3', undefined, 'Changes'), changes] : []),
  ];
}

export function markSelection(
  parts: Pick<MatrixParts, 'cells' | 'headings'>,
  selected: number | undefined,
  column: number | undefined,
): void {
  for (const [id, heading] of parts.headings) {
    heading.className = id === selected ? 'selected' : '';
  }
  for (const entry of parts.cells) {
    entry.button.setAttribute('aria-pressed', String(entry.snapshot === selected && entry.column === column));
    entry.cell.className = entry.snapshot === selected ? 'selected' : '';
  }
}

function matrixTable(
  data: SchemaHistoryData,
  view: SchemaHistoryView,
  onSelect: (snapshot: number, column: number | undefined) => void,
): MatrixParts {
  const cells: MatrixCell[] = [];
  const headings = new Map<number, HTMLElement>();
  const head = el('tr');
  const events = el('tr', 'events-row');
  head.append(el('th', undefined, 'Column'), el('th', undefined, 'Now'));
  events.append(el('th', undefined, 'Table'), el('th'));
  for (const snapshot of view.snapshots) {
    const pick = el('button', 'pick', `@${snapshot.id}`);
    pick.setAttribute('aria-label', `Snapshot ${snapshot.id}, ${shortTime(snapshot.time)}. Select it.`);
    pick.addEventListener('click', () => onSelect(snapshot.id, undefined));
    const heading = el('th');
    heading.append(pick, el('span', 'time', shortTime(snapshot.time)));
    headings.set(snapshot.id, heading);
    head.append(heading);
    const own = el('th', 'events');
    own.append(...snapshot.events.map((event) => el('div', undefined, eventText(event))));
    events.append(own);
  }
  const thead = el('thead');
  thead.append(head, events);
  const tbody = el('tbody');
  for (const { column: current, cells: shown } of view.rows) {
    const row = el('tr');
    const name = el('td', 'name');
    name.style.paddingLeft = `${10 + (current.path.length - 1) * 16}px`;
    name.append(current.path.at(-1) ?? '');
    if (current.formerNames.length > 0) {
      name.append(el('span', 'former', ` (formerly ${current.formerNames.join(', ')})`));
    }
    row.append(name, el('td', 'type', current.now ?? (data.exists ? 'dropped' : 'table dropped')));
    for (const snapshot of view.snapshots) {
      const cell = el('td');
      for (const change of shown.filter((candidate) => candidate.snapshot === snapshot.id)) {
        const button = el('button', 'cell', change.text);
        button.setAttribute('aria-label', `${columnLabel(current)}, snapshot ${snapshot.id}: ${change.text}`);
        button.addEventListener('click', () => onSelect(snapshot.id, current.id));
        cell.append(button);
        cells.push({ button, cell, snapshot: snapshot.id, column: current.id });
      }
      row.append(cell);
    }
    tbody.append(row);
  }
  const table = el('table');
  table.append(thead, tbody);
  return { element: table, cells, headings };
}

export function noteChildren(data: SchemaHistoryData, view: SchemaHistoryView): HTMLElement[] {
  return [
    ...(data.more ? [note(OLDER_NOTE)] : []),
    ...(view.omittedRows > 0 ? [note(omittedRowsNote(view.omittedRows), 'warning')] : []),
    ...(data.exists ? [] : [note('The table was dropped; the columns it had are listed.')]),
  ];
}

/** The matrix, or the reason that there is none. */
export function matrixContent(
  data: SchemaHistoryData,
  view: SchemaHistoryView,
  onSelect: (snapshot: number, column: number | undefined) => void,
): MatrixParts {
  if (view.rows.length === 0 && view.snapshots.length === 0) {
    const element = empty(
      data.snapshots.length === 0
        ? 'No schema change of this table is recorded in the catalog.'
        : 'No column or snapshot matches the filters.',
    );
    return { element, cells: [], headings: new Map() };
  }
  return matrixTable(data, view, onSelect);
}

export function filters(view: FilterView, on: FilterHandlers): HTMLElement {
  const first = view.data.snapshots[0]?.id ?? 0;
  const last = view.data.snapshots.at(-1)?.id ?? 0;
  return toolbar(
    searchBox('Column', view.text, on.onText),
    kindBoxes(CELL_KINDS, SCHEMA_HISTORY_KIND_LABEL, view.kinds, on.onKinds),
    ...rangeFields(first, last, (end) => view.range()[end], on.onRange),
  );
}
