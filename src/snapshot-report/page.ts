/// <reference lib="dom" />
// Browser side of the snapshot report: state and events; the DOM is built in render.ts.
import { focusPane, note, pageHeader, tabBar } from '../shell/blocks';
import type { ChartOption } from '../shell/chart-option';
import { el } from '../shell/dom';
import { pagedTable } from '../shell/paged-table';
import type { PagedTable } from '../shell/paged-table';
import { isHighContrast } from '../shell/palette';
import { boundsOf, fitRange } from '../shell/range-state';
import { reportPage } from '../shell/report-page';
import { reportHeading } from '../shell/report-heading';
import type { PageShell } from '../shell/report-page';
import { readTheme } from '../shell/theme';
import type { Theme } from '../shell/theme';
import type { SnapshotActionRequest } from '../snapshot-changes/actions';
import { POINT_KINDS, buildModel, detailOf } from '../snapshot-changes/model';
import type { Model } from '../snapshot-changes/model';
import { windowSubtitle } from '../snapshot-changes/window';
import { snapshotReportOption } from './chart-options';
import {
  SNAPSHOT_COLUMNS,
  omittedLanesNote,
  snapshotReportOlderNote,
  snapshotReportViewOf,
  snapshotRows,
} from './model';
import type { SnapshotReportData, SnapshotReportView } from './model';
import type { SnapshotReportMarkdownView } from './markdown';
import { isSnapshotReportMessage } from './protocol';
import { chartBar, chartHeight, columnAt, detailChildren, emptyPlot, emptyText, filterBar } from './render';
import type { Choices } from './render';
import { TABS, restoreState, savedState } from './state';
import type { TabId } from './state';

/** The blocks of the page that are filled again: the note above the tabs, the tabs, the tab shown, the chart, the pane. */
interface Blocks {
  readonly notes: HTMLElement;
  readonly tabRow: HTMLElement;
  readonly panel: HTMLElement;
  readonly plot: HTMLElement;
  readonly detail: HTMLElement;
}

/** What the page holds between events: the data, its view, the choices, the tab, the table and the selection. */
interface Page {
  readonly shell: PageShell;
  readonly blocks: Blocks;
  readonly data: SnapshotReportData;
  readonly model: Model;
  view: SnapshotReportView;
  choices: Choices;
  tab: TabId;
  /** The text of the filter box of the table. */
  text: string;
  /** Undefined: the table opens on the page of the selected snapshot. */
  page: number | undefined;
  selected: number | undefined;
  other: number | undefined;
  theme: Theme;
  /** The table, while its tab is shown. */
  table: PagedTable<number> | undefined;
}

const viewOf = (model: Model, choices: Choices): SnapshotReportView =>
  snapshotReportViewOf(model, { lanes: [...choices.lanes], kinds: [...choices.kinds], range: choices.range });

const ask = (page: Page, request: SnapshotActionRequest): void =>
  page.shell.context.post({ type: 'action', ...request });

// VS Code may take a hidden panel down; the saved choices bring it back as it was.
function save(page: Page): void {
  const { choices } = page;
  page.shell.context.state.set(
    savedState(page.data, page.model, {
      lanes: [...choices.lanes],
      kinds: [...choices.kinds],
      range: choices.range,
      axis: choices.axis,
      selected: page.selected,
      other: page.other,
      tab: page.tab,
      text: page.text,
      page: page.page,
    }),
  );
}

const chartOption = (page: Page): ChartOption =>
  snapshotReportOption(
    {
      view: page.view,
      axis: page.choices.axis,
      detail: (id: number) => detailOf(page.model, page.data.latest, id),
      selected: page.selected,
      other: page.other,
      contrast: isHighContrast(page.theme.mode),
    },
    page.theme.palette,
  );

/**
 * A plain click selects a snapshot; Ctrl-click picks or releases the second snapshot of a comparison. A snapshot
 * picked in the chart is on the page that the table opens with.
 */
function select(page: Page, id: number, extend: boolean, inChart: boolean): void {
  if (extend && page.selected !== undefined && id !== page.selected) {
    page.other = page.other === id ? undefined : id;
  } else {
    page.selected = id;
    if (page.other === id) {
      page.other = undefined;
    }
    if (inChart) {
      page.page = undefined;
    }
  }
  drawSelection(page);
}

/** The pane of the selection in the tab shown, and its marks in the chart or the table. */
function drawSelection(page: Page, updateChart = true): void {
  const { detail } = page.blocks;
  detail.replaceChildren(
    ...detailChildren(
      {
        model: page.model,
        latest: page.data.latest,
        selected: page.selected,
        other: page.other,
        tab: page.tab,
      },
      {
        onAction: (request) => ask(page, request),
        onClearOther() {
          page.other = undefined;
          drawSelection(page);
          detail.focus();
        },
      },
    ),
  );
  if (updateChart) {
    page.shell.charts.charts[0]?.update(chartOption(page));
  }
  page.table?.mark(page.selected, page.other);
  save(page);
}

// The chart is drawn once its tab is in the page, so that it takes the width of the page.
function drawPlot(page: Page): void {
  const { charts } = page.shell;
  charts.clear();
  page.theme = readTheme();
  if (page.view.columns.length === 0) {
    page.blocks.plot.replaceChildren(emptyPlot(page.data.snapshots.length));
    return;
  }
  page.blocks.plot.replaceChildren(
    charts.box(chartOption(page), {
      height: chartHeight(page.view.lanes.length),
      onPlotClick: (x, extend) => {
        const id = columnAt(page.view, page.choices.axis, x);
        if (id !== undefined) {
          select(page, id, extend, true);
        }
      },
    }),
  );
  charts.drawAll(page.theme);
}

function chartTab(page: Page): HTMLElement[] {
  const { view, data, blocks } = page;
  const bar = chartBar(page.choices.axis, {
    onAxis(axis) {
      page.choices = { ...page.choices, axis };
      drawPlot(page);
      save(page);
    },
    onAction: (request) => ask(page, request),
  });
  return [
    ...(data.snapshots.length > 0 ? [bar] : []),
    ...(view.omittedLanes > 0 ? [note(omittedLanesNote(view.omittedLanes), 'warning')] : []),
    blocks.plot,
    ...(data.snapshots.length > 0 ? [blocks.detail] : []),
  ];
}

function snapshotsTab(page: Page): HTMLElement[] {
  const table = pagedTable({
    columns: SNAPSHOT_COLUMNS,
    rows: snapshotRows(page.view, page.model, page.data.latest),
    noun: ['snapshot', 'snapshots'],
    noMatch: 'No snapshot matches the filters.',
    none: emptyText(page.data.snapshots.length),
    text: page.text,
    page: page.page,
    selected: page.selected,
    other: page.other,
    onSelect: (id, extend) => select(page, id, extend, false),
    onChange(next) {
      page.text = next.text;
      page.page = next.page;
      save(page);
    },
  });
  page.table = table;
  return page.data.snapshots.length > 0 ? [table.controls, page.blocks.detail, table.table] : [table.table];
}

/** The tabs and the tab shown; only the chart tab has a chart. */
function drawTab(page: Page, refocus = false): void {
  const bar = tabBar(TABS, page.tab, (id, focus) => {
    page.tab = id;
    drawTab(page, focus);
  });
  page.blocks.tabRow.replaceChildren(bar);
  page.shell.charts.clear();
  page.table = undefined;
  page.blocks.panel.replaceChildren(...(page.tab === 'chart' ? chartTab(page) : snapshotsTab(page)));
  if (page.tab === 'chart') {
    drawPlot(page);
  }
  drawSelection(page, false);
  if (refocus) {
    (Array.from(bar.children) as HTMLElement[])
      .find((button) => button.getAttribute('aria-selected') === 'true')
      ?.focus();
  }
}

function drawView(page: Page): void {
  page.view = viewOf(page.model, page.choices);
  page.blocks.notes.replaceChildren(...(page.data.more ? [note(snapshotReportOlderNote(page.data))] : []));
  drawTab(page);
}

/**
 * The filters above two tabs, the chart and the table of the snapshots. One snapshot is selected for both: its pane
 * is below the chart and above the table. Keeps the choices when the same connection is read again.
 */
export const snapshotReportPage = reportPage<SnapshotReportData>(
  'snapshotReport',
  isSnapshotReportMessage,
  (shell) => {
    const panel = el('section', 'tab-panel');
    panel.setAttribute('role', 'tabpanel');
    const blocks: Blocks = {
      notes: el('div', 'notes'),
      tabRow: el('div', 'tab-row'),
      panel,
      plot: el('div', 'plot'),
      detail: focusPane('detail'),
    };
    let shown: Page | undefined;

    return {
      show(next) {
        const model = buildModel(next.snapshots, next.more);
        const kept = restoreState(shell.context.state.get(), next, model);
        const choices: Choices = {
          lanes: new Set(kept?.lanes),
          kinds: new Set(kept ? kept.kinds : POINT_KINDS),
          range: kept?.range ?? fitRange(undefined, boundsOf(model.snapshots)),
          axis: kept?.axis ?? 'order',
        };
        const page: Page = {
          shell,
          blocks,
          data: next,
          model,
          view: viewOf(model, choices),
          choices,
          tab: kept?.tab ?? 'chart',
          text: kept?.text ?? '',
          page: kept?.page,
          selected: kept?.selected,
          other: kept?.other,
          theme: readTheme(),
          table: undefined,
        };
        shown = page;
        const header = pageHeader(shell.context, {
          title: reportHeading('Snapshot Report'),
          subtitle: windowSubtitle(next),
          refresh: 'Read the snapshots again; the choices stay',
          view: (): SnapshotReportMarkdownView => ({
            lanes: [...page.choices.lanes],
            kinds: [...page.choices.kinds],
            range: page.choices.range,
          }),
        });
        const bar = filterBar(model, () => page.choices, {
          onChange(change) {
            page.choices = change;
            // The table starts again at its first page.
            page.page = 0;
            drawView(page);
          },
        });
        const main = el('main');
        main.append(...(next.snapshots.length > 0 ? [bar] : []), blocks.notes, blocks.tabRow, blocks.panel);
        shell.mount(header, main);
        drawView(page);
      },
      redraw() {
        if (shown?.tab === 'chart') {
          drawPlot(shown);
        }
      },
    };
  },
);
