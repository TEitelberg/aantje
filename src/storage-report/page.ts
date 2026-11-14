/// <reference lib="dom" />
// Browser side of the Storage report: state and events; the DOM is built in render.ts.
import { manySmallFilesText } from '../catalog/thresholds';
import { empty, note, pageHeader, searchBox, tabBar, toolbar } from '../shell/blocks';
import { barChartHeight } from '../shell/chart-option';
import type { ChartOption } from '../shell/chart-option';
import type { Frame } from '../shell/chart-set';
import { el } from '../shell/dom';
import { formatUtc, plural } from '../shell/model';
import { reportPage } from '../shell/report-page';
import { scopeSuffix } from '../shell/scope';
import { readTheme } from '../shell/theme';
import { storageTablesOption } from './chart-options';
import { DEFAULT_SORT, barEntries } from './model';
import type { Sort, SortKey, StorageData, StorageView } from './model';
import { isStorageMessage } from './protocol';
import { growth, headerActions, overview, selectionChildren, tableListChildren } from './render';
import type { Act } from './render';
import { TABS, restoredChoices, savedState } from './state';
import type { TabId } from './state';

export const storagePage = reportPage<StorageData>(
  'storage',
  isStorageMessage,
  ({ context, charts, mount }) => {
    let data: StorageData;
    let tab: TabId = 'overview';
    let filter = '';
    let sort: Sort = DEFAULT_SORT;
    let selected: number | undefined;

    const save = (): void => context.state.set(savedState(data, { tab, filter, sort, selected }));

    const act: Act = (action, table) =>
      context.post({ type: 'action', action, ...(table === undefined ? {} : { table }) });

    function tables(storage: StorageData, frame: Frame): HTMLElement[] {
      if (storage.tableCount === 0) {
        return [empty(`No table exists at snapshot ${storage.snapshot}.`)];
      }
      const entries = barEntries(storage);
      const selection = el('div');
      const list = el('div', 'list');

      const chartOption = (): ChartOption => storageTablesOption(entries, frame.theme.palette, selected);

      const drawSelection = (): void =>
        selection.replaceChildren(...selectionChildren(storage, selected, act));

      function drawList(focus?: { readonly row?: number; readonly heading?: SortKey }): void {
        const drawn = tableListChildren(
          storage,
          { filter, sort, selected },
          {
            onSort(key) {
              sort =
                sort.key === key
                  ? { key, descending: !sort.descending }
                  : { key, descending: key !== 'name' };
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
        charts.charts[0]?.update(chartOption());
        save();
      }

      drawSelection();
      drawList();
      return [
        el('h2', undefined, 'Largest tables'),
        charts.box(chartOption(), {
          label: `Size of the ${plural(entries.filter((entry) => entry.tableId !== undefined).length, 'largest table', 'largest tables')}`,
          height: barChartHeight(entries.length),
          onItemClick: (index) => {
            const id = entries[index]?.tableId;
            if (id !== undefined) select(id, false);
          },
        }),
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
      charts.clear();
      const frame: Frame = { theme: readTheme(), charts };
      const storage = data;
      const header = pageHeader(context, {
        title: `Storage${scopeSuffix(storage.scope)}`,
        subtitle: `Snapshot @${storage.snapshot} · ${storage.connection} · read ${formatUtc(storage.readAt)}`,
        refresh: 'Read the storage again at the snapshot that the tree shows',
        view: (): StorageView => ({ filter }),
        actions: headerActions(act),
      });
      const main = el('main');
      main.setAttribute('role', 'tabpanel');
      main.append(
        ...(tab === 'overview'
          ? overview(storage, frame.theme)
          : tab === 'tables'
            ? tables(storage, frame)
            : growth(storage, frame)),
      );
      const tabs = tabBar(TABS, tab, (id, focus) => {
        tab = id;
        save();
        render(focus);
      });
      mount(header, tabs, main);
      charts.drawAll(frame.theme);
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
      redraw: () => render(),
    };
  },
);
