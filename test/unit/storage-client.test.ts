import { beforeAll, describe, expect, it } from 'vitest';
import type { StorageData } from '../../src/storage-report/model';
import { FakeNode } from '../support/fake-dom';
import { buildClientBundle, startPage } from '../support/page-harness';
import { historyStorage, sampleStorage, table } from './storage-support';

/**
 * Runs the real browser bundle against a stand-in for the DOM and for ECharts: the Storage page shows what the
 * extension sends, selects a table by its bar or its name, filters and sorts the list, keeps what the user chose while
 * VS Code takes the page down, and posts only the requests that the extension accepts.
 */

let bundle: string;
let history: StorageData;

beforeAll(async () => {
  bundle = await buildClientBundle();
  history = await historyStorage();
});

const message = (data: StorageData = sampleStorage()) => ({ type: 'storage', data });

function start(saved?: unknown) {
  const page = startPage(bundle, saved);
  const find = (predicate: (node: FakeNode) => boolean) => page.app().find(predicate);
  const view = {
    h1: () => find((node) => node.tag === 'h1').length,
    cards: () => find((node) => node.hasClass('card')).map((card) => card.children.map((c) => c.textContent)),
    warningCards: () => find((node) => node.hasClass('card') && node.hasClass('warning')).length,
    rows: () =>
      find((node) => node.tag === 'tbody')[0]?.children.map((row) => row.children.map((c) => c.textContent)),
    names: () => view.rows()?.map((row) => row[0]),
    button: (label: string) => find((node) => node.tag === 'button' && node.textContent === label)[0],
    click: (label: string) => view.button(label)?.fire('click'),
    filter: () => find((node) => node.tag === 'input')[0] as FakeNode,
    type: (text: string) => {
      const input = view.filter();
      input.value = text;
      input.fire('input');
    },
    tableTab: () => find((node) => node.tag === 'tbody').length > 0,
    pressed: () =>
      find((node) => node.tag === 'button' && node.getAttribute('aria-pressed') === 'true').map(
        (button) => button.textContent,
      ),
    sorted: () =>
      find(
        (node) =>
          node.tag === 'th' && ['ascending', 'descending'].includes(node.getAttribute('aria-sort') ?? ''),
      ).map((cell) => [cell.textContent, cell.getAttribute('aria-sort')]),
    charts: () => page.drawn.filter((chart) => !chart.disposed),
  };
  return { ...page, view, charts: view.charts };
}

describe('the Storage page', () => {
  it('shows the out-of-date note above the report once data is shown, keeps it while the page draws again, and drops it with new data', () => {
    const { send, view, app } = start();
    const note = () => app().find((node) => node.hasClass('stale-note') && node.hidden !== true);
    send({ type: 'stale' });
    expect(note()).toHaveLength(0);

    send(message());
    send({ type: 'stale' });
    expect(note()).toHaveLength(1);
    expect(app().children[0]?.hasClass('stale-note')).toBe(true);
    view.click('Tables');
    expect(note()).toHaveLength(1);

    send(message());
    expect(note()).toHaveLength(0);
  });

  it('says it is ready, ignores data it cannot show, and shows the key figures with a warning for late cleanup', () => {
    const { send, view, posted } = start();
    expect(posted).toEqual([{ type: 'ready' }]);
    send({ type: 'storage', data: { connection: 'x' } });
    expect(view.h1()).toBe(0);
    send(message());
    expect(view.h1()).toBe(1);
    expect(view.cards()).toHaveLength(8);
    expect(view.cards().map((card) => card[1])).toEqual([
      '/lake/data/',
      'no',
      '@12',
      '12',
      '1',
      '~1,240',
      '2',
      '100',
    ]);
    expect(view.warningCards()).toBe(0);
    send({ type: 'properties', data: { connection: 'Lake' } });
    send({ type: 'storage', data: null });
    expect(view.cards()).toHaveLength(8);

    send(message(sampleStorage({ readAt: '2026-11-20T00:00:00.000Z' })));
    expect(view.warningCards()).toBe(1);
    send(message());
    expect(view.warningCards()).toBe(0);

    send(message(history));
    expect(view.cards().map((card) => card[1])).toEqual([
      'sqlite-files/',
      'no',
      '@56',
      '19',
      '1',
      '69',
      '5',
      '0',
    ]);
  });

  it('asks the extension for the header actions by id, the document with the filter text, and refocuses Refresh', () => {
    const { send, view, posted } = start();
    send(message());
    view.click('Clean Up Old Files');
    view.click('Expire Snapshots');
    view.click('Properties');
    view.click('Refresh');
    expect(posted.slice(1)).toEqual([
      { type: 'action', action: 'scriptCleanup' },
      { type: 'action', action: 'scriptExpire' },
      { type: 'action', action: 'showProperties' },
      { type: 'refresh' },
    ]);
    send(message());
    expect(FakeNode.active?.textContent).toBe('Refresh');

    view.click('Open as Markdown');
    view.click('Tables');
    view.type('events');
    view.click('Open as Markdown');
    expect(posted.slice(5)).toEqual([
      { type: 'markdown', view: { filter: '' } },
      { type: 'markdown', view: { filter: 'events' } },
    ]);
  });

  describe('Tables', () => {
    const open = (data: StorageData = sampleStorage(), saved?: unknown) => {
      const page = start(saved);
      page.send(message(data));
      page.view.click('Tables');
      return page;
    };

    it('lists the tables largest first with files, size, share and rows, and draws one bar chart', () => {
      const { view, charts } = open();
      expect(view.rows()?.map((row) => row.slice(0, 5))).toEqual([
        ['shop.events', '10', '6 MB', '75 %', '1,200'],
        ['shop.customers', '2', '2 MB', '25 %', '~40'],
        ['shop.notes', '0', '0 B', '0 %', '0'],
      ]);
      expect(charts()).toHaveLength(1);
      expect(view.pressed()).toEqual([]);
      expect(open(history).view.rows()).toHaveLength(7);
    });

    it('selects a table by its name or its bar, and its actions ask for the table by its id', () => {
      const { view, posted, charts } = open();
      view.click('shop.customers');
      expect(view.pressed()).toEqual(['shop.customers']);
      expect(FakeNode.active?.textContent).toBe('shop.customers');
      view.click('Show Statistics');
      view.click('Show in Tree');
      view.click('Merge Adjacent Files');
      view.click('Rewrite Data Files');
      expect(posted.slice(1)).toEqual([
        { type: 'action', action: 'showStatistics', table: 2 },
        { type: 'action', action: 'revealTable', table: 2 },
        { type: 'action', action: 'scriptMerge', table: 2 },
        { type: 'action', action: 'scriptRewrite', table: 2 },
      ]);

      const big = open(sampleStorage({ tableCount: 5 }));
      big.charts()[0]?.onItemClick?.(1);
      expect(big.view.pressed()).toEqual(['shop.customers']);
      big.charts()[0]?.onItemClick?.(3);
      expect(big.view.pressed()).toEqual(['shop.customers']);
      expect(charts()).toHaveLength(1);

      const tables = Array.from({ length: 40 }, (_, index) =>
        table(index + 1, `t${index}`, { sizeBytes: 100 - index }),
      );
      const many = open(sampleStorage({ tables, tableCount: 40 }));
      many.charts()[0]?.onItemClick?.(30);
      expect(many.view.pressed()).toEqual([]);
      many.charts()[0]?.onItemClick?.(0);
      expect(many.view.pressed()).toEqual(['shop.t0']);
    });

    it('filters the list by a part of the name, and sorts by the pressed heading, then the other way round', () => {
      const { view } = open();
      view.type('CUST');
      expect(view.names()).toEqual(['shop.customers']);
      view.type('zzz');
      expect(view.rows()).toBeUndefined();
      view.type('');
      expect(view.rows()).toHaveLength(3);

      expect(view.sorted()).toEqual([['Size', 'descending']]);
      view.click('Table');
      expect(view.names()).toEqual(['shop.customers', 'shop.events', 'shop.notes']);
      expect(FakeNode.active?.textContent).toBe('Table');
      view.click('Table');
      expect(view.names()).toEqual(['shop.notes', 'shop.events', 'shop.customers']);
      view.click('Files');
      expect(view.names()).toEqual(['shop.events', 'shop.customers', 'shop.notes']);

      const unlike = [
        table(1, 'a', { sizeBytes: 30, files: 1, rows: 5, smallFiles: 1 }),
        table(2, 'b', { sizeBytes: 20, files: 3, rows: 50, smallFiles: 0 }),
        table(3, 'c', { sizeBytes: 10, files: 2, rows: 500, smallFiles: 2 }),
      ];
      const orders: [string, string[]][] = [
        ['Table', ['shop.a', 'shop.b', 'shop.c']],
        ['Files', ['shop.b', 'shop.c', 'shop.a']],
        ['Size', ['shop.a', 'shop.b', 'shop.c']],
        ['Rows', ['shop.c', 'shop.b', 'shop.a']],
        ['Small files', ['shop.a', 'shop.c', 'shop.b']],
      ];
      for (const [heading, order] of orders) {
        const page = open(sampleStorage({ tables: unlike, tableCount: 3 }));
        page.view.click(heading === 'Size' ? 'Files' : 'Size');
        page.view.click(heading);
        expect(page.view.names(), heading).toEqual(order);
      }
    });

    it('shows only the first 200 tables, and shows catalog text as text, never as markup', () => {
      const tables = Array.from({ length: 250 }, (_, index) =>
        table(index + 1, `t${String(index).padStart(3, '0')}`, { sizeBytes: 1000 - index }),
      );
      const { view } = open(sampleStorage({ tables, tableCount: 1300 }));
      expect(view.rows()).toHaveLength(200);
      view.type('t24');
      expect(view.rows()).toHaveLength(10);

      const hostile = '<img src=x onerror=alert(1)>';
      const page = open(sampleStorage({ tables: [table(1, hostile, { schema: hostile })], tableCount: 1 }));
      expect(page.view.names()).toEqual([`${hostile}.${hostile}`]);
      page.view.click(`${hostile}.${hostile}`);
      expect(page.app().find((node) => node.tag === 'img')).toEqual([]);
    });
  });

  describe('Growth', () => {
    it('draws the growth of the lake and lists the last points, newest first, at most 20', () => {
      const { send, view, charts } = start();
      send(message());
      view.click('Growth');
      expect(charts()).toHaveLength(1);
      expect(view.rows()?.map((row) => [row[0], row[2], row[3]])).toEqual([
        ['@12', '8 MB', '13'],
        ['@7', '7 MB', '12'],
        ['@3', '3 MB', '4'],
      ]);

      const growth = Array.from({ length: 40 }, (_, index) => ({
        snapshot: index + 1,
        time: null,
        files: index + 1,
        sizeBytes: (index + 1) * 1024,
        compaction: false,
      }));
      send(message(sampleStorage({ growth, growthMerged: true })));
      expect(view.rows()).toHaveLength(20);
      expect(view.names()?.[0]).toBe('@40');
      expect(view.names()?.at(-1)).toBe('@21');

      send(message(sampleStorage({ growth: [] })));
      expect(view.rows()).toBeUndefined();
      expect(charts()).toHaveLength(0);

      send(message(history));
      view.click('Growth');
      expect(view.rows()).toHaveLength(17);
      expect(view.rows()?.[0]?.filter((_, index) => index !== 1)).toEqual(['@56', '12.7 KB', '19', '']);
    });
  });

  describe('the tabs', () => {
    it('move with the arrow keys, draw a chart only on the tab that has one, and redraw for a theme', () => {
      const { send, view, drawn, resize, changeTheme } = start();
      send(message());
      expect(drawn).toHaveLength(0);
      view.button('Overview')?.fire('keydown', { key: 'ArrowRight' });
      expect(view.tableTab()).toBe(true);
      expect(FakeNode.active?.textContent).toBe('Tables');
      expect(view.charts()[0]?.resized).toBe(0);
      resize();
      expect(view.charts()[0]?.resized).toBe(1);
      changeTheme();
      expect(drawn.map((chart) => chart.disposed)).toEqual([true, false]);

      view.click('Growth');
      view.click('Overview');
      expect(view.charts()).toHaveLength(0);
    });
  });

  describe('what the page keeps while VS Code takes it down', () => {
    it('is the tab, the filter, the sort and the selected table, for the same connection only', () => {
      const first = start();
      first.send(message());
      expect(first.saved()).toBeUndefined();
      first.view.click('Tables');
      first.view.type('s');
      first.view.click('Table');
      first.view.click('shop.notes');
      const saved = first.saved();
      expect(saved).toEqual({
        connection: 'Lake',
        tab: 'tables',
        filter: 's',
        sort: { key: 'name', descending: false },
        selected: 3,
      });

      const back = start(saved);
      back.send(message());
      expect(back.view.tableTab()).toBe(true);
      expect(back.view.filter().value).toBe('s');
      expect(back.view.pressed()).toEqual(['shop.notes']);
      expect(back.view.sorted()).toEqual([['Table', 'ascending']]);

      const other = start({ ...(saved as object), connection: 'Another lake' });
      other.send(message());
      expect(other.view.tableTab()).toBe(false);
      other.view.click('Tables');
      expect([other.view.filter().value, other.view.pressed(), other.view.sorted()]).toEqual([
        '',
        [],
        [['Size', 'descending']],
      ]);

      for (const damaged of [
        { ...(saved as object), tab: 'nowhere' },
        { ...(saved as object), filter: 3 },
        { ...(saved as object), sort: { key: 'bogus', descending: false } },
        { ...(saved as object), sort: { key: 'name', descending: 'yes' } },
        { ...(saved as object), sort: undefined },
        { ...(saved as object), selected: 'b' },
        { ...(saved as object), connection: 4 },
      ]) {
        const page = start(damaged);
        page.send(message());
        expect(page.view.tableTab(), JSON.stringify(damaged)).toBe(false);
      }
    });

    it('drops a selected table the data read again no longer holds, and the state of another connection', () => {
      const page = start();
      page.send(message());
      page.view.click('Tables');
      page.view.click('shop.notes');
      page.send(message(sampleStorage({ tables: sampleStorage().tables.slice(0, 2), tableCount: 2 })));
      expect(page.view.pressed()).toEqual([]);

      page.view.click('shop.customers');
      page.view.type('c');
      page.send(message(sampleStorage({ connection: 'Other' })));
      expect(page.view.tableTab()).toBe(false);
      page.view.click('Tables');
      expect(page.view.pressed()).toEqual([]);
      expect(page.view.filter().value).toBe('');
    });
  });
});
