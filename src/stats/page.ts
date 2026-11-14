/// <reference lib="dom" />
// Browser side of the statistics report: tab state and events; the DOM is built in render.ts.
import { isOneOf, isShape, isString } from '../guards';
import { pageHeader, tabBar } from '../shell/blocks';
import type { Frame } from '../shell/chart-set';
import { el } from '../shell/dom';
import { reportPage } from '../shell/report-page';
import { readTheme } from '../shell/theme';
import type { StatisticsData } from './model';
import { isStatisticsMessage } from './protocol';
import { columns, growth, overview, partitioning } from './render';
import type { Statistics } from './render';

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

export const statisticsPage = reportPage<StatisticsData>(
  'statistics',
  isStatisticsMessage,
  ({ context, charts, mount }) => {
    let data: StatisticsData;
    let tab: TabId = 'overview';

    function render(refocus = false): void {
      charts.clear();
      const frame: Frame = { theme: readTheme(), charts };
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
        context.state.set({ connection: data.connection, table: data.table, tab } satisfies Saved);
        render(focus);
      });
      mount(header, tabs, main);
      charts.drawAll(frame.theme);
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
      redraw: () => render(),
    };
  },
);
