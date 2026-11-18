/// <reference lib="dom" />
// DOM builders of the Activity page. They take the state they show and report user input through callbacks.
import {
  actionButton,
  choiceSelect,
  dataTable,
  empty,
  kindBoxes,
  note,
  rangeFields,
  searchBox,
  tableRow,
  toolbar,
} from '../shell/blocks';
import { barChartHeight } from '../shell/chart-option';
import type { ChartSet } from '../shell/chart-set';
import { el } from '../shell/dom';
import { count, shortUtc } from '../shell/model';
import type { Theme } from '../shell/theme';
import { KIND_LABEL, POINT_KINDS } from '../snapshot-changes/model';
import type { Model, PointKind } from '../snapshot-changes/model';
import type { ActivityActionRequest } from './actions';
import { activityTablesOption, commitsOption, kindsOption } from './chart-options';
import { NO_AUTHOR, authorLabel, choices, omittedAuthorsNote, omittedTablesNote } from './model';
import type { ActivityData, ActivitySummary } from './model';
import type { TabId } from './state';

/** What a tab shows: the data read, the summary of the part that the filters leave, and the theme of the charts. */
interface ActivityView {
  readonly data: ActivityData;
  readonly summary: ActivitySummary;
  readonly theme: Theme;
}

/** The chart set that draws the boxes of a tab, and what a click on a table (its bar or its name) does. */
interface TabFrame {
  readonly charts: ChartSet;
  readonly pickTable: (key: string) => void;
}

const kindColumns = POINT_KINDS.map((kind) => KIND_LABEL[kind]);

/** The button before Refresh: the Snapshot report shows each snapshot, what it changed and what can be done with it. */
export function headerActions(ask: (request: ActivityActionRequest) => void): HTMLElement[] {
  return [
    actionButton(
      'Show Snapshot Report',
      () => ask({ action: 'showSnapshotReport' }),
      'Open the snapshot report of this connection, with each snapshot and what it changed',
    ),
  ];
}

const noSnapshot = (view: ActivityView): HTMLElement =>
  empty(
    view.data.snapshots.length === 0 ? 'This catalog has no snapshots.' : 'No snapshot matches the filters.',
  );

const noTable = (): HTMLElement => empty('No table was changed by the snapshots that the filters leave.');

/** The days, newest first, with their commits and changes: the keyboard route of the charts of the days. */
function daysTable(summary: ActivitySummary): HTMLElement {
  const alternative = el('details', 'alternative');
  alternative.append(
    el('summary', undefined, 'Show the days as a table'),
    dataTable(
      ['Day (UTC)', 'Commits', ...kindColumns],
      summary.days
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
  return alternative;
}

function commitsTab(view: ActivityView, { charts }: TabFrame): HTMLElement[] {
  const { summary, theme } = view;
  if (summary.days.length === 0) return [noSnapshot(view)];
  return [charts.box(commitsOption(summary.days, theme.palette)), daysTable(summary)];
}

function kindsTab(view: ActivityView, { charts }: TabFrame): HTMLElement[] {
  const { summary, theme } = view;
  if (summary.days.length === 0) return [noSnapshot(view)];
  return [
    note(POINT_KINDS.map((kind) => `${KIND_LABEL[kind]}: ${count(summary.kinds[kind])}`).join(' · ')),
    charts.box(kindsOption(summary.days, theme.palette)),
    daysTable(summary),
  ];
}

function authorsTab(view: ActivityView): HTMLElement[] {
  const { summary } = view;
  if (summary.authors.length === 0) return [noSnapshot(view)];
  return [
    dataTable(
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
  ];
}

const omittedTables = (summary: ActivitySummary): HTMLElement[] =>
  summary.omittedTables > 0 ? [note(omittedTablesNote(summary.omittedTables), 'warning')] : [];

function rankingTab(view: ActivityView, { charts, pickTable }: TabFrame): HTMLElement[] {
  const { summary, theme } = view;
  if (summary.tables.length === 0) return [noTable()];
  return [
    charts.box(activityTablesOption(summary.tables, theme.palette), {
      height: barChartHeight(summary.tables.length),
      onItemClick: (index) => {
        const row = summary.tables[index];
        if (row) pickTable(row.key);
      },
    }),
    ...omittedTables(summary),
  ];
}

function tableChangesTab(view: ActivityView, { pickTable }: TabFrame): HTMLElement[] {
  const { summary } = view;
  if (summary.tables.length === 0) return [noTable()];
  return [
    dataTable(
      ['Table', 'Changes', ...kindColumns],
      summary.tables.map((row) => {
        const pick = el('button', 'table-pick', row.label);
        pick.setAttribute('aria-label', `Filter the report to the snapshots that changed ${row.label}`);
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
    ...omittedTables(summary),
  ];
}

const TAB_CONTENT: Readonly<Record<TabId, (view: ActivityView, frame: TabFrame) => HTMLElement[]>> = {
  days: commitsTab,
  kinds: kindsTab,
  authors: authorsTab,
  ranking: rankingTab,
  tables: tableChangesTab,
};

/** The blocks of a tab; the next `drawAll` of the chart set draws its charts, once they are in the page. */
export const tabContent = (tab: TabId, view: ActivityView, frame: TabFrame): HTMLElement[] =>
  TAB_CONTENT[tab](view, frame);

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

/** The filter bar; `showTable` selects a table in its drop-down when a bar or a table name picks one. */
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
