/// <reference lib="dom" />
// Browser side of the Growth report: state and events; the DOM is built in render.ts.
import { cardGrid, focusPane, pageHeader, tabBar } from '../shell/blocks';
import type { ChartOption } from '../shell/chart-option';
import { el } from '../shell/dom';
import { pagedTable } from '../shell/paged-table';
import type { PagedTable } from '../shell/paged-table';
import { isHighContrast } from '../shell/palette';
import { reportPage } from '../shell/report-page';
import type { PageShell } from '../shell/report-page';
import { reportHeading } from '../shell/report-heading';
import { scopeSchema } from '../shell/scope';
import { readTheme } from '../shell/theme';
import type { Theme } from '../shell/theme';
import type { Model } from '../snapshot-changes/model';
import type { GrowthActionRequest } from './actions';
import { growthOption } from './chart-options';
import type { GrowthMarkdownView } from './markdown';
import {
  METRIC_LABEL,
  growthCards,
  growthColumns,
  growthModelOf,
  growthRows,
  growthScopeLabel,
  growthTableChoices,
  seriesOf,
  subtitle,
} from './model';
import type { GrowthData, GrowthXAxis, Metric, Step, TableChoice } from './model';
import { isGrowthMessage } from './protocol';
import { axisBar, detailChildren, filters, growthPane, noteChildren } from './render';
import { restoreGrowthChoices, savedGrowthState } from './state';
import type { TabId } from './state';

/** The blocks of the page that are filled again: the key figures, the notes, the tabs, the tab shown, the chart, the pane. */
interface Blocks {
  readonly cards: HTMLElement;
  readonly notes: HTMLElement;
  readonly tabRow: HTMLElement;
  readonly panel: HTMLElement;
  readonly plot: HTMLElement;
  readonly detail: HTMLElement;
}

/** What the page holds between events: the data, the steps of the chosen table, the choices, the tab and the selection. */
interface Page {
  readonly shell: PageShell;
  readonly blocks: Blocks;
  readonly data: GrowthData;
  readonly model: Model;
  readonly choices: readonly TableChoice[];
  steps: Step[];
  table: number | undefined;
  metric: Metric;
  axis: GrowthXAxis;
  selected: number | undefined;
  tab: TabId;
  /** The text of the filter box of the table. */
  text: string;
  /** Undefined: the table opens on the page of the selected snapshot. */
  page: number | undefined;
  theme: Theme;
  /** The table of the snapshots, while its tab is shown. */
  grid: PagedTable<number> | undefined;
}

const ask = (page: Page, request: GrowthActionRequest): void =>
  page.shell.context.post({ type: 'action', ...request });

// VS Code may take a hidden panel down; the saved choices bring it back as it was.
const save = (page: Page): void =>
  page.shell.context.state.set(
    savedGrowthState(page.data, {
      table: page.table,
      metric: page.metric,
      axis: page.axis,
      selected: page.selected,
      tab: page.tab,
      text: page.text,
      page: page.page,
    }),
  );

const scopeOf = (page: Page): string => growthScopeLabel(page.choices, page.table);

const chartOption = (page: Page): ChartOption =>
  growthOption(
    {
      steps: page.steps,
      metric: page.metric,
      axis: page.axis,
      scope: scopeOf(page),
      selected: page.selected,
      contrast: isHighContrast(page.theme.mode),
    },
    page.theme.palette,
  );

/** One selection for both tabs; a snapshot picked in the chart is on the page that the table opens with. */
function select(page: Page, id: number, inChart: boolean): void {
  page.selected = id;
  if (inChart) {
    page.page = undefined;
  }
  drawSelection(page);
}

/** The pane of the selection in the tab shown, and its mark in the chart or the table. */
function drawSelection(page: Page, updateChart = true): void {
  page.blocks.detail.replaceChildren(
    ...detailChildren(
      {
        steps: page.steps,
        selected: page.selected,
        table: page.table,
        metric: page.metric,
        scope: scopeOf(page),
        tab: page.tab,
      },
      (request) => ask(page, request),
    ),
  );
  if (updateChart) {
    page.shell.charts.charts[0]?.update(chartOption(page));
  }
  page.grid?.mark(page.selected);
  save(page);
}

// The chart is drawn once its tab is in the page, so that it takes the width of the page.
function drawPlot(page: Page): void {
  const { charts } = page.shell;
  charts.clear();
  page.theme = readTheme();
  page.blocks.plot.replaceChildren(
    ...growthPane(
      page.metric,
      scopeOf(page),
      {
        charts,
        option: chartOption(page),
        onItemClick: (index) => {
          const step = page.steps[index];
          if (step) {
            select(page, step.id, true);
          }
        },
      },
      page.steps.length > 0,
    ),
  );
  charts.drawAll(page.theme);
}

function chartTab(page: Page): HTMLElement[] {
  const bar = axisBar(page.axis, (axis) => {
    page.axis = axis;
    drawPlot(page);
    save(page);
  });
  const { plot, detail } = page.blocks;
  return page.steps.length > 0 ? [bar, plot, detail] : [plot];
}

function snapshotsTab(page: Page): HTMLElement[] {
  const grid = pagedTable({
    columns: growthColumns(page.steps),
    rows: growthRows(page.steps, page.model, page.data.latest),
    noun: ['snapshot', 'snapshots'],
    noMatch: 'No snapshot matches the filter.',
    none: 'This catalog has no snapshots.',
    text: page.text,
    page: page.page,
    selected: page.selected,
    onSelect: (id) => select(page, id, false),
    onChange(next) {
      page.text = next.text;
      page.page = next.page;
      save(page);
    },
  });
  page.grid = grid;
  return page.steps.length > 0 ? [grid.controls, page.blocks.detail, grid.table] : [grid.table];
}

/** The tabs, the first named after the value of the chart, and the tab shown; only the chart tab has a chart. */
function drawTab(page: Page, refocus = false): void {
  const tabs = [
    { id: 'chart', label: METRIC_LABEL[page.metric] },
    { id: 'snapshots', label: 'Snapshots' },
  ] as const;
  const bar = tabBar<TabId>(tabs, page.tab, (id, focus) => {
    page.tab = id;
    drawTab(page, focus);
  });
  page.blocks.tabRow.replaceChildren(bar);
  page.shell.charts.clear();
  page.grid = undefined;
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

/** The key figures, the notes and the tabs for the chosen table and value; the rows of the table stay the same. */
function drawView(page: Page): void {
  page.steps = seriesOf(page.data, page.model, page.table);
  page.blocks.cards.replaceChildren(cardGrid(growthCards(page.steps, page.metric), () => ''));
  page.blocks.notes.replaceChildren(...noteChildren(page.data, page.steps));
  drawTab(page);
}

/**
 * The filters and key figures above two tabs, the chart of the chosen value and the table of the snapshots. One
 * snapshot is selected for both: its pane is below the chart and above the table. Keeps the choices when the same
 * report is read again.
 */
export const growthPage = reportPage<GrowthData>('growth', isGrowthMessage, (shell) => {
  const panel = el('section', 'tab-panel');
  panel.setAttribute('role', 'tabpanel');
  const blocks: Blocks = {
    cards: el('div', 'cards-box'),
    notes: el('div', 'notes'),
    tabRow: el('div', 'tab-row'),
    panel,
    plot: el('div', 'growth'),
    detail: focusPane('detail'),
  };
  let shown: Page | undefined;

  return {
    show(next) {
      const model = growthModelOf(next);
      const choices = growthTableChoices(next, model);
      const kept = restoreGrowthChoices(shell.context.state.get(), next);
      const page: Page = {
        shell,
        blocks,
        data: next,
        model,
        choices,
        steps: [],
        table: kept ? kept.table : choices.find(({ id }) => id === next.focus)?.id,
        metric: kept?.metric ?? 'rows',
        axis: kept?.axis ?? 'snapshot',
        selected: kept?.selected,
        tab: kept?.tab ?? 'chart',
        text: kept?.text ?? '',
        page: kept?.page,
        theme: readTheme(),
        grid: undefined,
      };
      shown = page;
      const header = pageHeader(shell.context, {
        title: reportHeading(
          'Growth',
          choices.find(({ id }) => id === next.focus)?.label ?? scopeSchema(next.scope),
        ),
        subtitle: subtitle(next),
        refresh: 'Read the snapshots again; the choices stay',
        view: (): GrowthMarkdownView => ({ table: page.table, metric: page.metric }),
      });
      const bar = filters(
        { choices, table: page.table, metric: page.metric },
        {
          onTable(chosen) {
            page.table = chosen;
            drawView(page);
          },
          onMetric(chosen) {
            page.metric = chosen;
            drawView(page);
          },
        },
      );
      const main = el('main');
      main.append(
        ...(next.snapshots.length > 0 ? [bar] : []),
        blocks.cards,
        blocks.notes,
        blocks.tabRow,
        blocks.panel,
      );
      shell.mount(header, main);
      drawView(page);
    },
    redraw() {
      if (shown?.tab === 'chart') {
        drawPlot(shown);
      }
    },
  };
});
