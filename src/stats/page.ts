/// <reference lib="dom" />
// Browser side of the statistics report: tab state and events; the DOM is built in render.ts.
import { isOneOf, isShape, isString } from '../guards';
import { chartFrame, pageHeader, tabBar } from '../shell/blocks';
import { drawChart } from '../shell/charts';
import type { Chart } from '../shell/charts';
import type { ChartOption } from '../shell/chart-option';
import { el } from '../shell/dom';
import type { Page, PageContext, PageKind } from '../shell/page';
import { readTheme } from '../shell/theme';
import type { StatisticsData } from './model';
import { isStatisticsMessage } from './protocol';
import { columns, growth, overview, partitioning } from './render';
import type { Frame, Statistics } from './render';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'columns', label: 'Columns' },
  { id: 'partitioning', label: 'Partitioning' },
  { id: 'growth', label: 'Growth' },
] as const;
type TabId = (typeof TABS)[number]['id'];

// The tab is kept for a hidden panel that VS Code restores, like the tab of the Storage page; only for the same table.
interface Saved {
  readonly connection: string;
  readonly table: string;
  readonly tab: TabId;
}

const isSaved = isShape({
  connection: isString,
  table: isString,
  tab: isOneOf(...TABS.map(({ id }) => id)),
}) as (value: unknown) => value is Saved;

function content(id: TabId, stats: Statistics, frame: Frame): HTMLElement[] {
  switch (id) {
    case 'overview':
      return overview(stats, frame);
    case 'columns':
      return columns(stats, frame);
    case 'partitioning':
      return partitioning(stats, frame);
    case 'growth':
      return growth(stats, frame);
  }
}

function createStatisticsPage(context: PageContext): Page<StatisticsData> {
  let data: StatisticsData | undefined;
  let tab: TabId = 'overview';
  let charts: Chart[] = [];
  // Drawn once the new page is in the document: ECharts needs the size of its box.
  let drawings: (() => void)[] = [];

  function render(refocus = false): void {
    for (const chart of charts) {
      chart.dispose();
    }
    charts = [];
    drawings = [];
    const theme = readTheme();
    if (!data) {
      return;
    }
    const frame: Frame = {
      theme,
      chartBox(label: string, option: ChartOption, height?: number): HTMLElement {
        const box = chartFrame(label, height);
        drawings.push(() => charts.push(drawChart(box, theme.chart, option)));
        return box;
      },
    };
    const { statistics } = data;
    const header = pageHeader(context, {
      title: `${data.table} statistics`,
      subtitle: `Snapshot @${statistics.snapshot} · ${data.connection}`,
    });
    const main = el('main');
    main.setAttribute('role', 'tabpanel');
    main.append(...content(tab, statistics, frame));
    const tabs = tabBar(TABS, tab, (id, focus) => {
      tab = id;
      context.state.set({
        connection: data?.connection ?? '',
        table: data?.table ?? '',
        tab,
      } satisfies Saved);
      render(focus);
    });
    context.app.replaceChildren(header.element, tabs, main);
    for (const draw of drawings) {
      draw();
    }
    if (refocus) {
      tabs.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    }
  }

  return {
    show(next) {
      data = next;
      const saved = context.state.get();
      tab =
        isSaved(saved) && saved.connection === next.connection && saved.table === next.table
          ? saved.tab
          : 'overview';
      render();
    },
    redraw: render,
    resize() {
      for (const chart of charts) {
        chart.resize();
      }
    },
  };
}

export const statisticsPage: PageKind<StatisticsData> = {
  type: 'statistics',
  isMessage: isStatisticsMessage,
  create: createStatisticsPage,
};
