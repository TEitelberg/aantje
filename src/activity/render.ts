/// <reference lib="dom" />
// DOM builders of the Activity page. They take the state they show and report user input through callbacks.
import {
  actionButton,
  choiceSelect,
  dataTable,
  empty,
  kindBoxes,
  note,
  pickCell,
  rangeFields,
  searchBox,
  tableRow,
  toolbar,
} from '../shell/blocks';
import type { ListRow } from '../shell/blocks';
import { barChartHeight } from '../shell/chart-option';
import type { ChartSet } from '../shell/chart-set';
import { el } from '../shell/dom';
import { LIST_ROWS, count, shortUtc } from '../shell/model';
import type { Theme } from '../shell/theme';
import type { SnapshotActionRequest } from '../snapshot-changes/actions';
import { detailPane } from '../snapshot-changes/detail';
import { KIND_LABEL, POINT_KINDS, detailOf, summaryOf } from '../snapshot-changes/model';
import type { Model, PointKind } from '../snapshot-changes/model';
import type { ActivityActionRequest } from './actions';
import { activityTablesOption, commitsOption, kindsOption } from './chart-options';
import { NO_AUTHOR, authorLabel, choices, omittedAuthorsNote, omittedTablesNote } from './model';
import type { ActivityData, ActivitySummary } from './model';

/** What the builders show: the data read, its model and the summary of the filtered part. */
interface ActivityView {
  readonly data: ActivityData;
  readonly model: Model;
  readonly summary: ActivitySummary;
  readonly theme: Theme;
}

const kindColumns = POINT_KINDS.map((kind) => KIND_LABEL[kind]);

export function drawDays(into: HTMLElement, view: ActivityView, charts: ChartSet): void {
  const { data, summary, theme } = view;
  const shown = summary.days;
  if (shown.length === 0) {
    into.replaceChildren(
      el('h2', undefined, 'Commits per day'),
      empty(
        data.snapshots.length === 0 ? 'This catalog has no snapshots.' : 'No snapshot matches the filters.',
      ),
    );
    return;
  }
  const alternative = el('details', 'alternative');
  alternative.append(
    el('summary', undefined, 'Show the days as a table'),
    dataTable(
      ['Day (UTC)', 'Commits', ...kindColumns],
      shown
        .toReversed()
        .map((day) =>
          tableRow([
            day.day,
            el('td', 'number', String(day.commits)),
            ...POINT_KINDS.map((kind) => el('td', 'number', String(day.kinds[kind]))),
          ]),
        ),
    ),
  );
  into.replaceChildren(
    el('h2', undefined, 'Commits per day'),
    charts.box(commitsOption(shown, theme.palette)),
    el('h2', undefined, 'Changes by kind'),
    note(POINT_KINDS.map((kind) => `${KIND_LABEL[kind]}: ${count(summary.kinds[kind])}`).join(' · ')),
    charts.box(kindsOption(shown, theme.palette)),
    alternative,
  );
}

export function drawAuthors(into: HTMLElement, summary: ActivitySummary): void {
  into.replaceChildren(
    el('h2', undefined, 'Authors'),
    summary.authors.length === 0
      ? empty('No snapshot matches the filters.')
      : dataTable(
          ['Author', 'Commits', 'First', 'Latest', 'Latest message'],
          summary.authors.map((row) =>
            tableRow([
              el('td', row.author === NO_AUTHOR ? undefined : 'name', authorLabel(row.author)),
              el('td', 'number', String(row.commits)),
              shortUtc(row.first),
              shortUtc(row.last),
              el('td', 'who', row.message ?? ''),
            ]),
          ),
        ),
    ...(summary.omittedAuthors > 0 ? [note(omittedAuthorsNote(summary.omittedAuthors), 'warning')] : []),
  );
}

export function drawTables(
  into: HTMLElement,
  view: ActivityView,
  charts: ChartSet,
  pickTable: (key: string) => void,
): void {
  const { summary, theme } = view;
  into.replaceChildren(el('h2', undefined, 'Most changed tables'));
  if (summary.tables.length === 0) {
    into.append(empty('No table was changed by the snapshots that the filters leave.'));
    return;
  }
  into.append(
    charts.box(activityTablesOption(summary.tables, theme.palette), {
      height: barChartHeight(summary.tables.length),
      onItemClick: (index) => {
        const row = summary.tables[index];
        if (row) pickTable(row.key);
      },
    }),
    dataTable(
      ['Table', 'Changes', ...kindColumns],
      summary.tables.map((row) => {
        const pick = el('button', 'table-pick', row.label);
        pick.setAttribute('aria-label', `Show only the snapshots that changed ${row.label}`);
        pick.addEventListener('click', () => pickTable(row.key));
        const first = el('td', 'name');
        first.append(pick);
        return tableRow([
          first,
          el('td', 'number', String(row.changes)),
          ...POINT_KINDS.map((kind) => el('td', 'number', String(row.kinds[kind]))),
        ]);
      }),
    ),
    ...(summary.omittedTables > 0 ? [note(omittedTablesNote(summary.omittedTables), 'warning')] : []),
  );
}

/** Fills `into` with the snapshot list; returns each row and its button by snapshot. */
export function drawList(
  into: HTMLElement,
  view: ActivityView,
  onSelect: (id: number) => void,
): Map<number, ListRow> {
  const { data, model, summary } = view;
  const rows = new Map<number, ListRow>();
  const shown = summary.commits.slice(0, LIST_ROWS);
  const body = shown.flatMap((commit) => {
    const facts = detailOf(model, data.latest, commit.id);
    if (!facts) return [];
    const { cell, pick } = pickCell(
      `@${commit.id}`,
      `Snapshot ${commit.id}. Select it to see what it changed.`,
      () => onSelect(commit.id),
    );
    const row = tableRow([
      cell,
      shortUtc(commit.time),
      el('td', 'who', commit.author ?? ''),
      el('td', 'who', commit.message ?? ''),
      summaryOf(facts),
    ]);
    rows.set(commit.id, { row, pick });
    return [row];
  });
  into.replaceChildren(
    el('h2', undefined, 'Snapshots'),
    body.length === 0
      ? empty('No snapshot matches the filters.')
      : dataTable(['Snapshot', 'Time (UTC)', 'Author', 'Message', 'Changes'], body),
    ...(summary.commits.length > shown.length
      ? [
          note(
            `${shown.length} of ${summary.commits.length} snapshots are listed, the newest first. Narrow the filters to see the others.`,
          ),
        ]
      : []),
  );
  return rows;
}

export function drawDetail(
  into: HTMLElement,
  view: Pick<ActivityView, 'data' | 'model'>,
  selected: number | undefined,
  ask: (request: ActivityActionRequest | SnapshotActionRequest) => void,
): void {
  into.replaceChildren(
    ...detailPane(
      {
        model: view.model,
        latest: view.data.latest,
        selected,
        actions: [
          actionButton(
            'Show Snapshot Report',
            () => ask({ action: 'showSnapshotReport' }),
            'Open the snapshot report of this connection',
          ),
        ],
        hint: 'Select a snapshot in the list to see what it changed.',
      },
      ask,
    ),
  );
}

/** The filters when the bar is built; `kinds` is read on every change of a checkbox. */
interface Filters {
  readonly author: string | undefined;
  readonly table: string | undefined;
  readonly kinds: () => ReadonlySet<PointKind>;
  readonly text: string;
  readonly rangeAt: (end: 'from' | 'to') => number;
}

interface FilterHandlers {
  readonly onAuthor: (key: string | undefined) => void;
  readonly onTable: (key: string | undefined) => void;
  readonly onText: (text: string) => void;
  readonly onKinds: (kinds: Set<PointKind>) => void;
  readonly onRange: (end: 'from' | 'to', value: number) => void;
}

/** The filter bar; `showTable` selects a table in its drop-down when the table list picks one. */
export function filterBar(
  model: Model,
  filters: Filters,
  on: FilterHandlers,
): { readonly element: HTMLElement; readonly showTable: (key: string | undefined) => void } {
  const first = model.snapshots[0]?.id ?? 0;
  const last = model.snapshots.at(-1)?.id ?? 0;
  const offered = choices(model);
  const authorChoice = choiceSelect('Author', 'All authors', offered.authors, filters.author, on.onAuthor);
  const tableChoice = choiceSelect('Table', 'All tables', offered.tables, filters.table, on.onTable);
  const element = toolbar(
    authorChoice.element,
    tableChoice.element,
    searchBox('Message', filters.text, on.onText),
    kindBoxes(POINT_KINDS, KIND_LABEL, filters.kinds, on.onKinds),
    ...rangeFields(first, last, filters.rangeAt, on.onRange),
  );
  return { element, showTable: tableChoice.show };
}
