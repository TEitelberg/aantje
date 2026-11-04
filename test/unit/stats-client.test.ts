import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { TableStatistics } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import type { StatisticsMessage } from '../../src/stats/protocol';
import { HISTORY_ID, HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import type { FakeNode } from '../support/fake-dom';
import { wasmPath } from '../support/fixtures';
import { buildClientBundle, startPage } from '../support/page-harness';
import { historyFixture } from '../support/sources/history';

/**
 * Runs the real browser bundle of the statistics report against a stand-in for the DOM and for ECharts (which needs a
 * canvas): the page answers with `ready`, builds the tabs and the figures from what the extension sends, asks for the
 * charts with the data of the table and draws again when the theme changes. The charts themselves are drawn by ECharts
 * and checked in a real browser (test/e2e/specs/statistics.mjs).
 */

let bundle: string;
let events: TableStatistics;
let notes: TableStatistics;
let customers: TableStatistics;
const reader = createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));

beforeAll(async () => {
  bundle = await buildClientBundle();
  events = await reader.tableStatistics(HISTORY_ID.events, HISTORY_LATEST_SNAPSHOT);
  notes = await reader.tableStatistics(HISTORY_ID.notes, HISTORY_LATEST_SNAPSHOT);
  customers = await reader.tableStatistics(HISTORY_ID.customers, HISTORY_LATEST_SNAPSHOT);
});
afterAll(() => reader.close());

const data = (statistics: TableStatistics): StatisticsMessage => ({
  type: 'statistics',
  data: { table: 'shop.events', connection: 'History', statistics },
});

function start(saved?: unknown) {
  const page = startPage(bundle, saved);
  const find = (predicate: (node: FakeNode) => boolean) => page.app().find(predicate);
  const view = {
    find,
    cards: () =>
      page
        .app()
        .byClass('card')
        .map((card) => ({ value: card.children[1]?.textContent, warning: card.hasClass('warning') })),
    tabs: () => find((node) => node.getAttribute('role') === 'tab'),
    /** The index of the selected tab. */
    selected: () => view.tabs().findIndex((tab) => tab.getAttribute('aria-selected') === 'true'),
    tab: (index: number) => view.tabs()[index] as FakeNode,
    rows: () =>
      page
        .app()
        .byTag('tbody')[0]
        ?.children.map((row) => row.children.map((cell) => cell.textContent)),
    empty: () => page.app().byClass('empty'),
    /** The width of the null bar of every column that has one. */
    fills: () =>
      page
        .app()
        .byClass('bar')
        .map((bar) => (bar.children[0] as FakeNode).style.width),
    live: () => page.drawn.filter((chart) => !chart.disposed),
  };
  return { ...page, view };
}

const COLUMNS = 1;
const PARTITIONING = 2;
const GROWTH = 3;

describe('the statistics page', () => {
  it('tells the extension that it is ready, then shows the key figures, the four tabs and the histogram of shop.events, and asks for the document without a view', () => {
    const { posted, send, view, app } = start();
    expect(posted).toEqual([{ type: 'ready' }]);
    expect(app().textContent).toBe('Reading...');

    send(data(events));
    expect(view.cards()).toEqual([
      { value: '9', warning: false },
      { value: '6.2 KB', warning: false },
      { value: '52', warning: false },
      { value: '0', warning: false },
      { value: '705.4 B', warning: false },
      { value: '100 %', warning: true },
    ]);
    expect(view.tabs()).toHaveLength(4);
    expect(view.selected()).toBe(0);
    expect(view.tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(view.live()).toHaveLength(1);
    expect(view.live()[0]?.option.series).toMatchObject([{ type: 'bar', data: [0, 0, 0, 0, 0, 0, 8, 1] }]);

    // One header button: Open as Markdown. No Refresh, because a snapshot does not change.
    const buttons = view.find((node) => node.tag === 'button' && node.getAttribute('role') !== 'tab');
    expect(buttons).toHaveLength(1);
    buttons[0]?.fire('click');
    expect(posted).toEqual([{ type: 'ready' }, { type: 'markdown' }]);
  });

  it('shows the columns as rows with the null share as a bar and in words, draws no chart there, and a message for a table without columns', () => {
    const { send, view } = start();
    send(data(events));
    view.tab(COLUMNS).fire('click');
    expect(view.selected()).toBe(COLUMNS);
    expect(view.rows()).toEqual([
      ['id', 'int32', 'no', '0 %', '1', '139'],
      ['kind', 'varchar', 'yes', '0 %', 'click', 'view'],
      ['ts', 'timestamp', 'yes', '0 %', '2025-03-01 10:00:00', '2026-04-02 10:00:00'],
      ['amount', 'decimal(10,2)', 'yes', '0 %', '0.00', '58.50'],
    ]);
    expect(view.live()).toEqual([]);

    const nullable = (path: string, nullRatio: number | null) => ({
      id: 1,
      path: [path],
      type: 'varchar',
      nullable: true,
      nullRatio,
      min: null,
      max: null,
    });
    send(
      data({
        ...events,
        columns: [nullable('a', 0.25), nullable('b', 0.5), nullable('c', 1), nullable('d', null)],
      }),
    );
    expect(view.fills()).toEqual(['25%', '50%', '100%']);
    // the warning is in the words as well, for whoever cannot tell the colours apart
    expect(view.rows()?.map((row) => row[3])).toEqual(['25 %', '50 % (high)', '100 % (all NULL)', '–']);

    send(data({ ...events, columns: [] }));
    expect(view.rows()).toBeUndefined();
    expect(view.empty()).toHaveLength(1);
  });

  it('draws the partitions largest first with the evenness, and the growth as the size and the file count after each snapshot', () => {
    const { send, view } = start();
    send(data(events));
    view.tab(PARTITIONING).fire('click');
    expect(view.live()).toHaveLength(1);
    expect(view.live()[0]?.option.yAxis).toMatchObject({
      data: ['click / 3', 'click / 4', 'view / 3', 'view / 4'],
    });
    const notesShown = view.find((node) => node.hasClass('note')).map((node) => node.textContent);
    expect(notesShown).toHaveLength(2);
    expect(notesShown[0]).toContain('Gini 0.01');
    expect(notesShown[1]).toContain('5 data files');

    view.tab(GROWTH).fire('click');
    expect(view.live()).toHaveLength(1);
    expect(view.live()[0]?.option.series).toMatchObject([
      { name: 'Size', data: [1917, 2530, 3858, 5736, 6349] },
      { name: 'Files', data: [3, 4, 5, 8, 9] },
    ]);
  });

  it('shows a message instead of an empty chart when the table is not partitioned, has no data files or no growth', () => {
    const { send, view } = start();
    send(data(customers));
    view.tab(PARTITIONING).fire('click');
    expect(view.live()).toEqual([]);
    expect(view.empty()).toHaveLength(1);

    send(data(notes));
    view.tab(0).fire('click');
    expect(view.cards().map((card) => card.value)).toEqual(['0', '0 B', '0', '0', '–', '–']);
    expect(view.live()).toEqual([]);
    expect(view.empty()).toHaveLength(1);
    view.tab(GROWTH).fire('click');
    expect(view.live()).toEqual([]);
    expect(view.empty()).toHaveLength(1);
  });

  it('draws the charts again when the theme changes and disposes the old ones, resizes them with the window, and keeps the tab and the data', () => {
    const { send, view, changeTheme, resize, drawn } = start();
    send(data(events));
    view.tab(PARTITIONING).fire('click');
    resize();
    expect(view.live()[0]?.resized).toBe(1);

    changeTheme();
    expect(drawn).toHaveLength(3);
    expect(drawn.map((chart) => chart.disposed)).toEqual([true, true, false]);
    expect(view.selected()).toBe(PARTITIONING);
    expect(view.live()[0]?.option.yAxis).toMatchObject({
      data: ['click / 3', 'click / 4', 'view / 3', 'view / 4'],
    });
  });

  it('keeps the tab of a table when VS Code brings a hidden panel back, and starts on the overview for another table', () => {
    const first = start();
    first.send(data(events));
    first.view.tab(GROWTH).fire('click');

    const back = start(first.saved());
    back.send(data(events));
    expect(back.view.selected()).toBe(GROWTH);

    const other = start(first.saved());
    other.send({
      type: 'statistics',
      data: { table: 'shop.notes', connection: 'History', statistics: notes },
    });
    expect(other.view.selected()).toBe(0);
  });

  it('shows the text of the catalog as text, never as markup', () => {
    const { send, view, app } = start();
    const hostile = '<img src=x onerror=alert(1)>';
    const [bucket] = events.partitioning?.partitions ?? [];
    const partitioning = events.partitioning &&
      bucket && {
        ...events.partitioning,
        partitions: [{ ...bucket, values: [hostile, null] }],
      };
    send(
      data({
        ...events,
        partitioning,
        columns: [{ ...events.columns[0]!, path: [hostile], min: hostile, max: hostile }],
      }),
    );
    view.tab(COLUMNS).fire('click');
    expect(view.rows()?.[0]).toContain(hostile);
    expect(app().byTag('img')).toEqual([]);
    view.tab(PARTITIONING).fire('click');
    expect(view.live()[0]?.option.yAxis).toMatchObject({ data: [`${hostile} / NULL`] });
    expect(app().byTag('img')).toEqual([]);
  });

  it('ignores a message that is not statistics or does not fit the model, and shows a later message in place of the first', () => {
    const { send, view } = start();
    send(data(events));
    send({ type: 'something-else' });
    send({ type: 'statistics', data: { table: 'x', connection: 'y', statistics: { ...events, files: -1 } } });
    send({ type: 'statistics', data: null });
    expect(view.cards()[0]?.value).toBe('9');

    send(data(customers));
    expect(view.cards()[0]?.value).toBe('4');
    expect(view.live()).toHaveLength(1);
  });
});
