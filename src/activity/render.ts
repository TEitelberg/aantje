/// <reference lib="dom" />
// DOM builders of the Activity page. They take the state they show and report user input through callbacks.
import { LIST_ROWS } from '../shell/model';
import { snapshotReportCompareTargets, showsRows } from '../snapshot-report/actions';
import {
  POINT_KINDS,
  SNAPSHOT_REPORT_KIND_LABEL,
  snapshotReportDetailOf,
  summaryOf,
} from '../snapshot-report/model';
import type { Model, PointKind } from '../snapshot-report/model';
import {
  actionButton,
  choiceSelect,
  dataTable,
  empty,
  kindCheckbox,
  note,
  rangeField,
  searchBox,
  tableRow,
  toolbar,
} from '../shell/blocks';
import { barChartHeight } from '../shell/chart-option';
import type { ChartOption } from '../shell/chart-option';
import { el } from '../shell/dom';
import { count, shortUtc } from '../shell/model';
import type { Theme } from '../shell/theme';
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

/** Draws a chart into a new box in `parent`; the page keeps the chart to dispose it. */
export type ChartIn = (
  parent: HTMLElement,
  option: ChartOption,
  height?: number,
  onItemClick?: (index: number) => void,
) => void;

const kindColumns = POINT_KINDS.map((kind) => SNAPSHOT_REPORT_KIND_LABEL[kind]);

export function drawDays(into: HTMLElement, view: ActivityView, chartIn: ChartIn): void {
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
  into.replaceChildren(el('h2', undefined, 'Commits per day'));
  chartIn(into, commitsOption(shown, theme.palette));
  into.append(
    el('h2', undefined, 'Changes by kind'),
    note(
      POINT_KINDS.map((kind) => `${SNAPSHOT_REPORT_KIND_LABEL[kind]}: ${count(summary.kinds[kind])}`).join(
        ' · ',
      ),
    ),
  );
  chartIn(into, kindsOption(shown, theme.palette));
  into.append(alternative);
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
  chartIn: ChartIn,
  pickTable: (key: string) => void,
): void {
  const { summary, theme } = view;
  into.replaceChildren(el('h2', undefined, 'Most changed tables'));
  if (summary.tables.length === 0) {
    into.append(empty('No table was changed by the snapshots that the filters leave.'));
    return;
  }
  chartIn(
    into,
    activityTablesOption(summary.tables, theme.palette),
    barChartHeight(summary.tables.length),
    (index) => {
      const row = summary.tables[index];
      if (row) pickTable(row.key);
    },
  );
  into.append(
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
): Map<number, { readonly row: HTMLElement; readonly pick: HTMLElement }> {
  const { data, model, summary } = view;
  const rows = new Map<number, { readonly row: HTMLElement; readonly pick: HTMLElement }>();
  const shown = summary.commits.slice(0, LIST_ROWS);
  const body = shown.flatMap((commit) => {
    const facts = snapshotReportDetailOf(model, data.latest, commit.id);
    if (!facts) return [];
    const pick = el('button', 'pick', `@${commit.id}`);
    pick.setAttribute('aria-label', `Snapshot ${commit.id}. Select it to see what it changed.`);
    pick.addEventListener('click', () => onSelect(commit.id));
    const first = el('td');
    first.append(pick);
    const row = tableRow([
      first,
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
  ask: (request: ActivityActionRequest) => void,
): void {
  const { data, model } = view;
  const facts = selected === undefined ? undefined : snapshotReportDetailOf(model, data.latest, selected);
  if (!facts) {
    into.replaceChildren(note('Select a snapshot in the list to see what it changed.'));
    return;
  }
  const who = [facts.author, facts.message].filter((part) => part !== null && part !== '');
  const targets = snapshotReportCompareTargets(facts, data.latest, undefined);
  const actions = el('div', 'actions');
  actions.append(
    actionButton(`Show catalog at @${facts.id}`, () => ask({ action: 'showCatalog', snapshot: facts.id })),
    actionButton(
      'Show Snapshot Report',
      () => ask({ action: 'showSnapshotReport' }),
      'Open the snapshot report of this connection',
    ),
    ...(targets.length > 0 ? [el('span', 'label', 'Compare the catalog with')] : []),
    ...targets.flatMap(({ against, snapshot }) =>
      against === 'other'
        ? []
        : [
            actionButton(
              `${against} @${snapshot}`,
              () => ask({ action: 'compareSnapshots', snapshot: facts.id, against }),
              `Compare the catalog at @${facts.id} with ${against} @${snapshot}`,
            ),
          ],
    ),
  );
  const changed = el('ul', 'tables');
  for (const entry of facts.tables) {
    const item = el('li', 'table-row');
    const buttons = el('div', 'actions');
    if (showsRows(facts, entry)) {
      buttons.append(
        actionButton(
          'Rows changed',
          () => ask({ action: 'rowsChanged', snapshot: facts.id, table: entry.tableId }),
          `Show the rows of ${entry.label} that @${facts.id} changed`,
        ),
      );
    }
    item.append(el('span', 'name', entry.label), el('span', 'what', entry.actions.join(', ')), buttons);
    changed.append(item);
  }
  const others = el('ul', 'others');
  others.append(...facts.others.map((entry) => el('li', undefined, entry)));
  into.replaceChildren(
    el('h2', undefined, `@${facts.id} · ${facts.timeText}`),
    ...(who.length > 0 ? [el('p', 'who-line', who.join(' · '))] : []),
    actions,
    ...(facts.tables.length > 0 ? [el('h3', undefined, 'Tables'), changed] : []),
    ...(facts.others.length > 0 ? [el('h3', undefined, 'Schema / views / macros'), others] : []),
  );
}

/** The filters when the bar is built; `kinds` is the set the checkboxes change. */
interface Filters {
  readonly author: string | undefined;
  readonly table: string | undefined;
  readonly kinds: Set<PointKind>;
  readonly text: string;
  readonly rangeAt: (end: 'from' | 'to') => number;
}

interface FilterHandlers {
  readonly onAuthor: (key: string | undefined) => void;
  readonly onTable: (key: string | undefined) => void;
  readonly onText: (text: string) => void;
  readonly onKinds: () => void;
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
  const kindsBox = el('div', 'kinds');
  kindsBox.append(
    ...POINT_KINDS.map((kind) =>
      kindCheckbox(SNAPSHOT_REPORT_KIND_LABEL[kind], kind, filters.kinds, on.onKinds),
    ),
  );
  const element = toolbar(
    authorChoice.element,
    tableChoice.element,
    searchBox('Message', filters.text, on.onText),
    kindsBox,
    ...(['from', 'to'] as const).map((end) =>
      rangeField(
        end === 'from' ? 'From' : 'To',
        first,
        last,
        () => filters.rangeAt(end),
        (next) => on.onRange(end, next),
      ),
    ),
  );
  return { element, showTable: tableChoice.show };
}
