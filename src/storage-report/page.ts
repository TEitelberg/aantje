/// <reference lib="dom" />
// Browser side of the Storage report: state and events; the DOM is built in render.ts.
import { manySmallFilesText } from '../catalog/thresholds';
import { isCount, isOneOf, isOptional, isShape, isString } from '../guards';
import { chartFrame, empty, note, pageHeader, searchBox, tabBar, toolbar } from '../shell/blocks';
import { drawChart } from '../shell/charts';
import type { Chart } from '../shell/charts';
import { barChartHeight } from '../shell/chart-option';
import type { ChartOption } from '../shell/chart-option';
import { el } from '../shell/dom';
import { formatUtc, plural } from '../shell/model';
import type { Page, PageContext, PageKind } from '../shell/page';
import { readTheme } from '../shell/theme';
import type { Theme } from '../shell/theme';
import { storageTablesOption } from './chart-options';
import { DEFAULT_SORT, barEntries } from './model';
import type { Sort, SortKey, StorageData, StorageView } from './model';
import { isStorageMessage } from './protocol';
import { growth, headerActions, overview, selectionChildren, tableListChildren } from './render';
import type { Act, Frame } from './render';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'tables', label: 'Tables' },
  { id: 'growth', label: 'Growth' },
] as const;
type TabId = (typeof TABS)[number]['id'];

interface Saved {
  readonly connection: string;
  readonly tab: TabId;
  readonly filter: string;
  readonly sort: Sort;
  readonly selected?: number | undefined;
}

const isSaved = isShape({
  connection: isString,
  tab: isOneOf(...TABS.map(({ id }) => id)),
  filter: isString,
  sort: isShape({
    key: isOneOf('name', 'files', 'size', 'rows', 'small'),
    descending: (value) => typeof value === 'boolean',
  }),
  selected: isOptional(isCount),
}) as (value: unknown) => value is Saved;

function restoredChoices(saved: unknown, data: StorageData): Omit<Saved, 'connection'> {
  return isSaved(saved) && saved.connection === data.connection
    ? saved
    : { tab: 'overview', filter: '', sort: DEFAULT_SORT, selected: undefined };
}

function createStoragePage(context: PageContext): Page<StorageData> {
  let data: StorageData | undefined;
  let tab: TabId = 'overview';
  let filter = '';
  let sort: Sort = DEFAULT_SORT;
  let selected: number | undefined;
  let charts: Chart[] = [];
  // Drawn once the new page is in the document: ECharts needs the size of its box.
  let drawings: (() => void)[] = [];
  let theme: Theme;

  function save(): void {
    if (data) {
      context.state.set({ connection: data.connection, tab, filter, sort, selected } satisfies Saved);
    }
  }

  const act: Act = (action, table) =>
    context.post({ type: 'action', action, ...(table === undefined ? {} : { table }) });

  const frame: Frame = {
    get theme() {
      return theme;
    },
    chartBox(label: string, option: ChartOption, height?: number, onItemClick?: (index: number) => void) {
      const box = chartFrame(label, height);
      drawings.push(() => charts.push(drawChart(box, theme.chart, option, undefined, onItemClick)));
      return box;
    },
  };

  function tables(storage: StorageData): HTMLElement[] {
    if (storage.tableCount === 0) {
      return [empty(`No table exists at snapshot ${storage.snapshot}.`)];
    }
    const entries = barEntries(storage);
    const selection = el('div');
    const list = el('div', 'list');

    const chartOption = (): ChartOption => storageTablesOption(entries, theme.palette, selected);

    const drawSelection = (): void => selection.replaceChildren(...selectionChildren(storage, selected, act));

    function drawList(focus?: { readonly row?: number; readonly heading?: SortKey }): void {
      const drawn = tableListChildren(
        storage,
        { filter, sort, selected },
        {
          onSort(key) {
            sort =
              sort.key === key ? { key, descending: !sort.descending } : { key, descending: key !== 'name' };
            drawList({ heading: key });
            save();
          },
          onPick: (id) => select(id, true),
        },
      );
      list.replaceChildren(...drawn.children);
      if (focus?.row !== undefined) drawn.rowButtons.get(focus.row)?.focus();
      if (focus?.heading !== undefined) drawn.headingButtons.get(focus.heading)?.focus();
    }

    function select(id: number, fromList: boolean): void {
      selected = id;
      drawSelection();
      drawList(fromList ? { row: id } : undefined);
      charts[0]?.update(chartOption());
      save();
    }

    drawSelection();
    drawList();
    return [
      el('h2', undefined, 'Largest tables'),
      frame.chartBox(
        `Size of the ${plural(entries.filter((entry) => entry.tableId !== undefined).length, 'largest table', 'largest tables')}`,
        chartOption(),
        barChartHeight(entries.length),
        (index) => {
          const id = entries[index]?.tableId;
          if (id !== undefined) select(id, false);
        },
      ),
      note(
        `Click a bar to select a table. The sign ⚠ in a name marks a table with many small files: ${manySmallFilesText()} under the small file size.`,
      ),
      el('h2', undefined, 'All tables'),
      toolbar(
        searchBox('Filter', filter, (text) => {
          filter = text;
          drawList();
          save();
        }),
      ),
      selection,
      list,
    ];
  }

  function render(refocus = false): void {
    for (const chart of charts) {
      chart.dispose();
    }
    charts = [];
    drawings = [];
    theme = readTheme();
    if (!data) {
      return;
    }
    const storage = data;
    const header = pageHeader(context, {
      title: storage.scope.kind === 'schema' ? `Storage · schema ${storage.scope.name}` : 'Storage',
      subtitle: `Snapshot @${storage.snapshot} · ${storage.connection} · read ${formatUtc(storage.readAt)}`,
      refresh: 'Read the storage again at the snapshot that the tree shows',
      view: (): StorageView => ({ filter }),
      actions: headerActions(act),
    });
    const main = el('main');
    main.setAttribute('role', 'tabpanel');
    main.append(
      ...(tab === 'overview'
        ? overview(storage, theme)
        : tab === 'tables'
          ? tables(storage)
          : growth(storage, frame)),
    );
    const tabs = tabBar(TABS, tab, (id, focus) => {
      tab = id;
      save();
      render(focus);
    });
    context.app.replaceChildren(header.element, tabs, main);
    for (const draw of drawings) {
      draw();
    }
    header.settle();
    if (refocus) {
      (Array.from(tabs.children) as HTMLElement[])
        .find((button) => button.getAttribute('aria-selected') === 'true')
        ?.focus();
    }
  }

  return {
    show(next) {
      data = next;
      ({ tab, filter, sort, selected } = restoredChoices(context.state.get(), next));
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

export const storagePage: PageKind<StorageData> = {
  type: 'storage',
  isMessage: isStorageMessage,
  create: createStoragePage,
};
