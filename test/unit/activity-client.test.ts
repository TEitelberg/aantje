import { LIST_ROWS } from '../../src/shell/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActivityData } from '../../src/activity/model';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID } from '../support/expected-history';
import { FakeNode } from '../support/fake-dom';
import { buildClientBundle, startPage } from '../support/page-harness';
import { historyActivity } from './activity-support';
import { snapshot, tableChange } from './snapshot-report-support';

/**
 * Runs the real browser bundle against a stand-in for the DOM and for ECharts: the Activity page shows what the
 * extension sends, the filters change the charts and lists, a click on a bar or a snapshot selects it, the actions
 * leave the page as the requests that the extension accepts, and the choices survive a hidden panel. The charts
 * themselves are drawn by ECharts and checked in a real browser.
 */

const catalogs = editedCatalogs();
let bundle: string;
let data: ActivityData;

beforeAll(async () => {
  bundle = await buildClientBundle();
  data = await historyActivity(catalogs, [40, 44, 'ann', 'Backfill']);
});
afterAll(() => catalogs.dispose());

const message = (activity: ActivityData) => ({ type: 'activity', data: activity });

function start(saved?: unknown) {
  const page = startPage(bundle, saved);
  const find = (predicate: (node: FakeNode) => boolean) => page.app().find(predicate);
  const byClass = (name: string) => find((node) => node.hasClass(name));
  const section = (name: string) => byClass(name)[0] as FakeNode;
  const rowsOf = (node: FakeNode | undefined) =>
    node?.byTag('tbody')[0]?.children.map((row) => row.children.map((cell) => cell.textContent)) ?? [];
  const select = (label: string) =>
    byClass('choice')
      .find((node) => node.textContent.startsWith(label))
      ?.byTag('select')[0] as FakeNode;
  const view = {
    h1: () => find((node) => node.tag === 'h1')[0]?.textContent,
    subtitle: () => byClass('subtitle')[0]?.textContent,
    headings: () => find((node) => node.tag === 'h2').map((node) => node.textContent),
    cards: () => byClass('card').map((card) => card.children.map((c) => c.textContent)),
    notes: () => byClass('note').map((node) => node.textContent),
    empty: () => byClass('empty').map((node) => node.textContent),
    days: () => rowsOf(section('days')),
    authors: () => rowsOf(section('authors')),
    tables: () => rowsOf(section('tables-section')),
    list: () => rowsOf(section('list')),
    detail: () => section('detail'),
    button: (label: string) => find((node) => node.tag === 'button' && node.textContent === label)[0],
    charts: () => page.drawn.filter((chart) => !chart.disposed),
    select,
    choose: (label: string, value: string) => {
      const control = select(label);
      control.value = value;
      control.fire('change');
    },
    kind: (label: string) =>
      byClass('check').find((node) => node.textContent === label)?.children[0] as FakeNode,
    toggle: (label: string, on: boolean) => {
      const box = view.kind(label);
      box.checked = on;
      box.fire('change');
    },
    search: () => find((node) => node.tag === 'input' && node.type === 'search')[0] as FakeNode,
    type: (text: string) => {
      view.search().value = text;
      view.search().fire('input');
    },
    range: (end: 'From' | 'To') =>
      byClass('range')
        .find((node) => node.textContent.startsWith(`${end} @`))
        ?.byTag('input')[0] as FakeNode,
    setRange: (end: 'From' | 'To', value: string) => {
      view.range(end).value = value;
      view.range(end).fire('change');
    },
  };
  return { ...page, view };
}

describe('the Activity page', () => {
  it('tells the extension that it is ready, shows the history fixture, draws its charts, and ignores data it cannot show', () => {
    const { posted, app, send, view } = start();
    expect(posted).toEqual([{ type: 'ready' }]);
    expect(app().textContent).toBe('Reading...');

    send(message(data));
    expect(view.cards().map(([, value]) => value)).toEqual(['57', '3', '8', '6', '2026-10-25 10:56:00 UTC']);
    expect(view.authors()).toEqual([
      ['(no author)', '51', '2026-10-20 10:00:00', '2026-10-25 10:56:00', ''],
      ['ann', '5', '2026-10-24 10:40:00', '2026-10-24 10:44:00', 'Backfill'],
      ['tillmann', '1', '2026-10-22 10:25:00', '2026-10-22 10:25:00', 'Nightly import'],
    ]);
    expect(view.tables().slice(0, 2)).toEqual([
      ['main.evolved', '11', '2', '0', '0', '9', '0'],
      ['shop.customers', '8', '3', '1', '1', '3', '0'],
    ]);
    expect(view.days()).toHaveLength(6);
    expect(view.days()[0]).toEqual(['2026-10-25', '7', '5', '0', '0', '1', '1']);
    expect(view.list()).toHaveLength(57);
    expect(view.list().find((row) => row[0] === '@25')).toEqual([
      '@25',
      '2026-10-22 10:25:00',
      'tillmann',
      'Nightly import',
      'shop.customers',
    ]);
    expect(view.list().find((row) => row[0] === '@23')?.[4]).toBe('shop.events, shop.customers');
    expect(view.charts()).toHaveLength(3);

    send({ type: 'properties', data: null });
    send({ type: 'activity', data: null });
    expect(view.list()).toHaveLength(57);

    const broken = start();
    broken.send({ type: 'activity', data: { connection: 'x' } });
    expect(broken.app().textContent).not.toBe('Reading...');
    expect(broken.view.h1()).toBeUndefined();
  });

  it('filters by author, table (also by a click on a bar), kind of change, message words and range, and the page follows', () => {
    const { send, view } = start();
    send(message(data));
    const before = view.charts();

    view.choose('Author', 'k:ann');
    expect(view.list().map((row) => row[0])).toEqual(['@44', '@43', '@42', '@41', '@40']);
    expect(view.authors().map((row) => row[0])).toEqual(['ann']);
    expect(view.days()).toEqual([['2026-10-24', '5', '1', '0', '0', '4', '0']]);
    expect(view.charts()).toHaveLength(3);
    expect(before.every((chart) => chart.disposed)).toBe(true);
    view.choose('Author', 'all');
    view.choose('Author', 'k:');
    expect(view.list()).toHaveLength(51);
    view.choose('Author', 'all');

    view.choose('Table', `k:t${HISTORY_ID.events}`);
    expect(view.list().map((row) => row[0])).toEqual(['@23', '@10', '@9', '@8', '@7', '@6', '@5', '@4']);
    view.choose('Table', 'all');
    const bars = view.charts().find((chart) => chart.onItemClick !== undefined);
    bars?.onItemClick?.(1);
    expect(view.select('Table').value).toBe(`k:t${HISTORY_ID.customers}`);
    expect(view.list().map((row) => row[0])).toEqual([
      '@38',
      '@37',
      '@25',
      '@23',
      '@18',
      '@17',
      '@16',
      '@15',
    ]);
    view.choose('Table', 'all');

    for (const kind of ['Insert', 'Update', 'Schema change', 'Maintenance']) {
      view.toggle(kind, false);
    }
    expect(view.list().map((row) => row[0])).toEqual(['@22', '@18']);
    expect(view.tables().map((row) => row[0])).toEqual(['shop.customers', 'shop.notes']);
    for (const kind of ['Insert', 'Update', 'Schema change', 'Maintenance']) {
      view.toggle(kind, true);
    }

    view.type('nightly');
    expect(view.list().map((row) => row[0])).toEqual(['@25']);
    view.type('zzz');
    expect(view.list()).toEqual([]);
    expect(view.charts()).toEqual([]);
    view.type('');
    view.setRange('From', '24');
    view.setRange('To', '26');
    expect(view.list().map((row) => row[0])).toEqual(['@26', '@25', '@24']);
    view.setRange('To', '999');
    expect(view.range('To').value).toBe('56');
    view.setRange('From', 'abc');
    expect(view.range('From').value).toBe('24');

    const none = start();
    none.send(message({ ...data, snapshots: [] }));
    expect(none.view.list()).toEqual([]);
    expect(none.view.search()).toBeUndefined();
  });

  it('selects a snapshot, and posts the actions that apply to it, none for a creation without rows or before the first snapshot', () => {
    const { send, view, posted } = start();
    send(message(data));

    view.button('@25')?.fire('click');
    expect(view.button('@25')?.getAttribute('aria-pressed')).toBe('true');
    expect(view.detail().byClass('who-line')[0]?.textContent).toBe('tillmann · Nightly import');
    view.button('Show catalog at @25')?.fire('click');
    view.button('Show Snapshot Report')?.fire('click');
    view.button('previous @24')?.fire('click');
    view.button('latest @56')?.fire('click');
    view.button('Rows changed')?.fire('click');
    expect(posted.slice(1)).toEqual([
      { type: 'action', action: 'showCatalog', snapshot: 25 },
      { type: 'action', action: 'showSnapshotReport' },
      { type: 'action', action: 'compareSnapshots', snapshot: 25, against: 'previous' },
      { type: 'action', action: 'compareSnapshots', snapshot: 25, against: 'latest' },
      { type: 'action', action: 'rowsChanged', snapshot: 25, table: HISTORY_ID.customers },
    ]);

    view.button('@45')?.fire('click');
    expect(view.detail().buttons()).toHaveLength(4);
    view.button('@0')?.fire('click');
    expect(view.detail().buttons()).toHaveLength(3);
  });

  it('asks for the document with the choices, refreshes keeping them and the focus, and comes back after VS Code took the page down', () => {
    const { send, view, posted } = start();
    send(message(data));
    view.choose('Author', 'k:ann');
    view.choose('Table', 'k:t12');
    view.toggle('Maintenance', false);
    view.type('x');
    view.setRange('From', '10');
    view.button('Open as Markdown')?.fire('click');
    view.button('Refresh')?.fire('click');
    expect(posted.slice(1)).toEqual([
      {
        type: 'markdown',
        view: {
          author: 'ann',
          table: 't12',
          kinds: ['insert', 'update', 'delete', 'ddl'],
          text: 'x',
          range: { from: 10, to: 56 },
        },
      },
      { type: 'refresh' },
    ]);
    send(message(data));
    expect(view.select('Author').value).toBe('k:ann');
    expect(view.select('Table').value).toBe('k:t12');
    expect(view.kind('Maintenance').checked).toBe(false);
    expect(view.range('From').value).toBe('10');
    expect(FakeNode.active?.textContent).toBe('Refresh');

    const later = start();
    later.send(message({ ...data, snapshots: data.snapshots.slice(1) }));
    expect(later.view.range('To').value).toBe('55');
    later.send(message(data));
    expect(later.view.range('To').value).toBe('56');
    later.view.setRange('To', '55');
    later.send(message(data));
    expect(later.view.range('To').value).toBe('55');

    const first = start();
    first.send(message(data));
    first.view.choose('Author', 'k:ann');
    first.view.type('back');
    first.view.button('@42')?.fire('click');
    const saved = first.saved();
    expect(saved).toMatchObject({ connection: 'History', author: 'ann', text: 'back', selected: 42 });

    const back = start(saved);
    back.send(message(data));
    expect(back.view.select('Author').value).toBe('k:ann');
    expect(back.view.search().value).toBe('back');
    expect(back.view.list().map((row) => row[0])).toEqual(['@44', '@43', '@42', '@41', '@40']);
    expect(back.view.button('@42')?.getAttribute('aria-pressed')).toBe('true');

    const other = start(saved);
    other.send(message({ ...data, connection: 'Another lake' }));
    expect(other.view.search().value).toBe('');
    expect(other.view.list()).toHaveLength(57);

    const stale = start({ ...(saved as object), author: 'nobody', selected: 999 });
    stale.send(message(data));
    expect(stale.view.select('Author').value).toBe('all');

    const gone = start({ ...(saved as object), table: 'tNONE', range: { from: 5, to: 999 } });
    gone.send(message(data));
    expect(gone.view.select('Table').value).toBe('all');
    expect([gone.view.range('From').value, gone.view.range('To').value]).toEqual(['5', '56']);

    const broken = start({ connection: 'History', kinds: 'insert' });
    broken.send(message(data));
    expect(broken.view.list()).toHaveLength(57);
  });

  it('lists at most 200 snapshots, and shows the text of the catalog as text, never as markup', () => {
    const many: ActivityData = {
      ...data,
      snapshots: Array.from({ length: 250 }, (_, index) => snapshot(index, [tableChange(3, 'inserted')])),
    };
    const big = start();
    big.send(message(many));
    expect(big.view.list()).toHaveLength(LIST_ROWS);

    const hostile = '<img src=x onerror=alert(1)>';
    const { send, view, app } = start();
    send(
      message({
        connection: hostile,
        scope: { kind: 'lake' },
        latest: 1,
        more: false,
        snapshots: [
          snapshot(1, [tableChange(7, 'inserted', hostile, hostile)], {
            author: hostile,
            commitMessage: hostile,
          }),
        ],
      }),
    );
    expect(view.authors()).toEqual([[hostile, '1', '2026-11-01 00:00:01', '2026-11-01 00:00:01', hostile]]);
    expect(view.tables()[0]?.[0]).toBe(`${hostile}.${hostile}`);
    expect(view.list()[0]).toEqual(['@1', '2026-11-01 00:00:01', hostile, hostile, `${hostile}.${hostile}`]);
    expect(app().find((node) => node.tag === 'img')).toEqual([]);
    view.type(hostile);
    expect(view.list()).toHaveLength(1);
  });
});
