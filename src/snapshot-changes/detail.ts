/// <reference lib="dom" />
// The detail pane of one snapshot, shared by the Snapshot Report and Activity; user input comes back through `ask`.
import { actionButton, note, whoLine } from '../shell/blocks';
import { el } from '../shell/dom';
import { compareTargets, isReadable, showsRows } from './actions';
import type { CompareTarget, SnapshotActionRequest } from './actions';
import { OTHER_LABEL, detailOf, tableExistsAt } from './model';
import type { DetailTable, Model, SnapshotDetail } from './model';

export interface DetailPane {
  readonly model: Model;
  readonly latest: number;
  readonly selected: number | undefined;
  /** The second snapshot of a comparison, picked on the page. */
  readonly other?: number | undefined;
  /** Query and Schema vs on each table, besides Rows changed. */
  readonly tableQueries?: boolean;
  /** Buttons after Show catalog. */
  readonly actions?: readonly HTMLElement[];
  /** Blocks between the buttons and the tables. */
  readonly notes?: readonly HTMLElement[];
  /** Shown while no snapshot is selected. */
  readonly hint: string;
}

type Ask = (request: SnapshotActionRequest) => void;

// Only the picked second snapshot travels as its id.
const against = (target: CompareTarget): Pick<SnapshotActionRequest, 'against' | 'other'> =>
  target.against === 'other' ? { against: 'other', other: target.snapshot } : { against: target.against };

const targetLabel = ({ against: kind, snapshot }: CompareTarget): string =>
  kind === 'other' ? `@${snapshot}` : `${kind} @${snapshot}`;

function tableRow(snapshot: SnapshotDetail, table: DetailTable, pane: DetailPane, ask: Ask): HTMLElement {
  const button = (label: string, request: SnapshotActionRequest, description?: string) =>
    actionButton(label, () => ask(request), description);
  const row = el('li', 'table-row');
  const actions = el('div', 'actions');
  const at = { snapshot: snapshot.id, table: table.tableId };
  if (showsRows(snapshot, table)) {
    actions.append(
      button(
        'Rows changed',
        { action: 'rowsChanged', ...at },
        `Show the rows of ${table.label} that @${snapshot.id} changed`,
      ),
    );
  }
  if (pane.tableQueries && isReadable(table)) {
    actions.append(button('Query...', { action: 'query', ...at }, `Query ${table.label} at @${snapshot.id}`));
    const targets = compareTargets(snapshot, pane.latest, pane.other, (id) =>
      tableExistsAt(pane.model, table.key, id),
    );
    if (targets.length > 0) {
      actions.append(el('span', 'label', 'Schema vs'));
    }
    for (const target of targets) {
      const text = targetLabel(target);
      actions.append(
        button(
          text,
          { action: 'compareSchema', ...at, ...against(target) },
          `Compare the schema of ${table.label} at @${snapshot.id} with ${text}`,
        ),
      );
    }
  }
  row.append(el('span', 'name', table.label), el('span', 'what', table.actions.join(', ')), actions);
  return row;
}

function snapshotActions(snapshot: SnapshotDetail, pane: DetailPane, ask: Ask): HTMLElement {
  const targets = compareTargets(snapshot, pane.latest, pane.other);
  const wide = el('div', 'actions');
  wide.append(
    actionButton(`Show catalog at @${snapshot.id}`, () =>
      ask({ action: 'showCatalog', snapshot: snapshot.id }),
    ),
    ...(pane.actions ?? []),
    ...(targets.length > 0 ? [el('span', 'label', 'Compare the catalog with')] : []),
    ...targets.map((target) =>
      actionButton(
        targetLabel(target),
        () => ask({ action: 'compareSnapshots', snapshot: snapshot.id, ...against(target) }),
        `Compare the catalog at @${snapshot.id} with ${targetLabel(target)}`,
      ),
    ),
  );
  return wide;
}

/** The pane of the selected snapshot: what it changed and what can be done with it; or the hint to select one. */
export function detailPane(pane: DetailPane, ask: Ask): HTMLElement[] {
  const snapshot = pane.selected === undefined ? undefined : detailOf(pane.model, pane.latest, pane.selected);
  if (!snapshot) {
    return [note(pane.hint)];
  }
  const tables = el('ul', 'tables');
  tables.append(...snapshot.tables.map((table) => tableRow(snapshot, table, pane, ask)));
  const others = el('ul', 'others');
  others.append(...snapshot.others.map((text) => el('li', undefined, text)));
  return [
    el('h2', undefined, `@${snapshot.id} · ${snapshot.timeText}`),
    ...whoLine(snapshot.author, snapshot.message),
    snapshotActions(snapshot, pane, ask),
    ...(pane.notes ?? []),
    ...(snapshot.tables.length > 0 ? [el('h3', undefined, 'Tables'), tables] : []),
    ...(snapshot.others.length > 0 ? [el('h3', undefined, OTHER_LABEL), others] : []),
  ];
}
