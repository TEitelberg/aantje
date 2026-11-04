import { LIST_ROWS } from '../../src/shell/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { METRIC_LABEL } from '../../src/growth/model';
import type { GrowthData } from '../../src/growth/model';
import { readGrowth } from '../../src/growth/read';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID } from '../support/expected-history';
import { FakeNode } from '../support/fake-dom';
import { buildClientBundle, startPage } from '../support/page-harness';
import { historyFixture } from '../support/sources/history';
import { historyGrowth } from './growth-support';
import { snapshot, tableChange } from './snapshot-report-support';

/**
 * Runs the real browser bundle against a stand-in for the DOM and for ECharts: the Growth page shows what the
 * extension sends, the table, the value and the x axis change the chart, the list and the key figures, a click on a
 * point or a snapshot selects it, the actions leave the page as the requests that the extension accepts, and the choices
 * survive a hidden panel. The line itself is drawn by ECharts and checked in a real browser.
 */

const catalogs = editedCatalogs();
let bundle: string;
let data: GrowthData;

beforeAll(async () => {
  bundle = await buildClientBundle();
  data = await historyGrowth(catalogs, { authors: [[40, 44, 'ann', 'Backfill']] });
});
afterAll(() => catalogs.dispose());

const message = (growth: GrowthData) => ({ type: 'growth', data: growth });

interface DrawnOption {
  aria: { label: { description: string } };
  xAxis: { type: string };
  series: { data: { value: number | number[]; symbol: string }[] }[];
  tooltip: { formatter(params: unknown): string };
}

function start(saved?: unknown) {
  const page = startPage(bundle, saved);
  const find = (predicate: (node: FakeNode) => boolean) => page.app().find(predicate);
  const byClass = (name: string) => find((node) => node.hasClass(name));
  const rowsOf = (node: FakeNode | undefined) =>
    node?.byTag('tbody')[0]?.children.map((row) => row.children.map((cell) => cell.textContent)) ?? [];
  const view = {
    h1: () => find((node) => node.tag === 'h1')[0]?.textContent,
    subtitle: () => byClass('subtitle')[0]?.textContent,
    headings: () => find((node) => node.tag === 'h2').map((node) => node.textContent),
    cards: () => byClass('card').map((card) => card.children.map((c) => c.textContent)),
    notes: () => byClass('notes')[0]?.children.map((node) => node.textContent) ?? [],
    listNotes: () =>
      byClass('list')[0]
        ?.byClass('note')
        .map((node) => node.textContent) ?? [],
    empty: () => byClass('empty').map((node) => node.textContent),
    list: () => rowsOf(byClass('list')[0]),
    detail: () => byClass('detail')[0] as FakeNode,
    button: (label: string) => find((node) => node.tag === 'button' && node.textContent === label)[0],
    pressed: () =>
      byClass('mode')
        .filter((node) => node.getAttribute('aria-pressed') === 'true')
        .map((node) => node.textContent),
    charts: () => page.drawn.filter((chart) => !chart.disposed),
    chart: () => view.charts().at(-1) as (typeof page.drawn)[number],
    option: () => view.chart().option as unknown as DrawnOption,
    select: () => byClass('choice')[0]?.byTag('select')[0] as FakeNode,
    choose: (value: string) => {
      view.select().value = value;
      view.select().fire('change');
    },
  };
  return { ...page, view };
}

describe('the Growth page', () => {
  it('tells the extension that it is ready, shows the key figures, the line and the list of every snapshot, and ignores data it cannot show', () => {
    const { posted, app, send, view } = start();
    expect(posted).toEqual([{ type: 'ready' }]);
    expect(app().textContent).toBe('Reading...');

    send(message(data));
    expect(view.cards().map(([, value]) => value)).toEqual(['71', '71', '+40', '-2', '57']);
    expect(view.pressed()).toEqual(['Live rows', 'Snapshots']);
    expect(view.select().value).toBe('all');
    expect(view.list()).toHaveLength(57);
    expect(view.list()[0]).toEqual(['@56', '2026-10-25 10:56:00', '71', '+1', '', '']);
    expect(
      view
        .list()
        .find((row) => row[0] === '@17')
        ?.slice(2, 4),
    ).toEqual(['~58', '-1']);
    expect(view.list().find((row) => row[0] === '@25')).toEqual([
      '@25',
      '2026-10-22 10:25:00',
      '64',
      '+1',
      'tillmann',
      'Nightly import',
    ]);
    expect(view.charts()).toHaveLength(1);
    expect(view.option().series[0]?.data).toHaveLength(57);
    expect(view.option().series[0]?.data.at(-1)).toMatchObject({ value: 71, symbol: 'circle' });
    expect(view.option().xAxis.type).toBe('category');

    send({ type: 'properties', data: null });
    send({ type: 'growth', data: null });
    expect(view.list()).toHaveLength(57);

    const broken = start();
    broken.send({ type: 'growth', data: { connection: 'x' } });
    expect(broken.app().textContent).not.toBe('Reading...');
    expect(broken.view.h1()).toBeUndefined();
  });

  it('switches the table, the value and the x axis, and the chart, the list and the key figures follow', () => {
    const { send, view } = start();
    send(message({ ...data, focus: HISTORY_ID.customers }));
    expect(view.select().value).toBe(`k:${HISTORY_ID.customers}`);
    expect(view.cards().map((card) => card[1])).toEqual(['5', '5', '+4', '-1', '57']);
    expect(view.list()[0]).toEqual(['@56', '2026-10-25 10:56:00', '5', '0', '', '']);
    // All tables, the tables of the newest snapshot and the dropped ones.
    expect(view.select().children).toHaveLength(9);

    view.choose(`k:${HISTORY_ID.notes}`);
    expect(
      view
        .list()
        .find((row) => row[0] === '@22')
        ?.slice(2, 4),
    ).toEqual(['2', '-1']);
    expect(view.charts()).toHaveLength(1);
    view.choose(`k:${HISTORY_ID.events}`);

    view.button(METRIC_LABEL.bytes)?.fire('click');
    expect(view.pressed()).toEqual(['Data size', 'Snapshots']);
    expect(view.cards().slice(0, 2)).toEqual([
      ['Now', '6.2 KB', 'at @56'],
      ['Highest', '6.2 KB', 'at @23'],
    ]);
    expect(view.list()[0]?.slice(2, 4)).toEqual(['6.2 KB', '0']);
    expect(view.option().series[0]?.data.at(-1)?.value).toBe(6349);
    expect(view.charts()).toHaveLength(1);
    view.button(METRIC_LABEL.files)?.fire('click');
    expect(view.option().series[0]?.data.at(-1)?.value).toBe(9);
    view.button(METRIC_LABEL.rows)?.fire('click');
    expect(view.cards()[0]?.[1]).toBe('52');

    const before = view.chart();
    view.button('Time')?.fire('click');
    expect(view.pressed()).toEqual(['Live rows', 'Time']);
    expect(before.disposed).toBe(true);
    expect(view.option().xAxis.type).toBe('time');
    expect(view.option().series[0]?.data.at(-1)?.value).toEqual([Date.parse('2026-10-25T10:56:00.000Z'), 52]);
    view.button('Snapshots')?.fire('click');
    expect(view.option().xAxis.type).toBe('category');
  });

  it('selects a snapshot from the list or the chart and posts its actions, and asks for the document and a refresh that keeps the choices', () => {
    const { send, view, posted } = start();
    send(message(data));

    view.button('@25')?.fire('click');
    expect(view.detail().byClass('who-line')[0]?.textContent).toBe('tillmann · Nightly import');
    expect(view.detail().buttons()).toHaveLength(1);
    expect(view.button('@25')?.getAttribute('aria-pressed')).toBe('true');
    view.choose(`k:${HISTORY_ID.customers}`);
    expect(view.detail().buttons()).toHaveLength(2);
    view.button('Show catalog at @25')?.fire('click');
    view.button('Query at @25')?.fire('click');
    expect(posted.slice(1)).toEqual([
      { type: 'action', action: 'showCatalog', snapshot: 25 },
      { type: 'action', action: 'query', snapshot: 25, table: HISTORY_ID.customers },
    ]);

    view.chart().onItemClick?.(10);
    expect(view.detail().byTag('h2')[0]?.textContent).toContain('@10');
    view.chart().onItemClick?.(999);
    expect(view.detail().byTag('h2')[0]?.textContent).toContain('@10');

    posted.length = 0;
    view.choose('all');
    view.button('Open as Markdown')?.fire('click');
    view.choose(`k:${HISTORY_ID.events}`);
    view.button(METRIC_LABEL.files)?.fire('click');
    view.button('Open as Markdown')?.fire('click');
    view.button('Refresh')?.fire('click');
    expect(posted).toEqual([
      { type: 'markdown', view: { metric: 'rows' } },
      { type: 'markdown', view: { table: HISTORY_ID.events, metric: 'files' } },
      { type: 'refresh' },
    ]);
    send(message(data));
    expect(view.select().value).toBe(`k:${HISTORY_ID.events}`);
    expect(view.pressed()).toEqual(['Data files', 'Snapshots']);
    expect(FakeNode.active?.textContent).toBe('Refresh');
  });

  it('comes back with the choices after VS Code took the page down, for the same report only', () => {
    const first = start();
    first.send(message({ ...data, focus: HISTORY_ID.events }));
    first.view.choose('all');
    first.view.button(METRIC_LABEL.bytes)?.fire('click');
    first.view.button('Time')?.fire('click');
    first.view.button('@42')?.fire('click');
    const saved = first.saved();
    expect(saved).toEqual({
      connection: 'History',
      focus: HISTORY_ID.events,
      metric: 'bytes',
      axis: 'time',
      selected: 42,
    });

    const back = start(saved);
    back.send(message({ ...data, focus: HISTORY_ID.events }));
    // "All tables" chosen on a report opened for a table stays chosen.
    expect(back.view.select().value).toBe('all');
    expect(back.view.pressed()).toEqual(['Data size', 'Time']);
    expect(back.view.detail().byTag('h2')[0]?.textContent).toContain('@42');

    const other = start(saved);
    other.send(message({ ...data, focus: HISTORY_ID.events, connection: 'Another lake' }));
    expect(other.view.select().value).toBe(`k:${HISTORY_ID.events}`);
    expect(other.view.pressed()).toEqual(['Live rows', 'Snapshots']);

    const wholeLake = start(saved);
    wholeLake.send(message(data));
    expect(wholeLake.view.pressed()).toEqual(['Live rows', 'Snapshots']);

    const stale = start({ ...(saved as object), table: 999, selected: 999 });
    stale.send(message({ ...data, focus: HISTORY_ID.events }));
    expect(stale.view.select().value).toBe('all');
    expect(stale.view.button('@42')?.getAttribute('aria-pressed')).toBe('false');

    for (const state of [
      { connection: 'History', focus: null, metric: 'speed', axis: 'snapshot' },
      { connection: 'History', focus: null, metric: 'bytes', axis: 'diagonal' },
    ]) {
      const broken = start(state);
      broken.send(message(data));
      expect(broken.view.pressed()).toEqual(['Live rows', 'Snapshots']);
    }
  });

  it('shows notes where values are not exact, lists at most 200 snapshots, redraws on a theme change, and shows catalog text as text', async () => {
    const lake = start();
    lake.send(message(data));
    expect(lake.view.notes()).toHaveLength(1);
    const events = start();
    events.send(message({ ...data, focus: HISTORY_ID.events }));
    expect(events.view.notes()).toEqual([]);
    const inlined = start();
    inlined.send(message({ ...data, focus: HISTORY_ID.events, inlinedMore: true }));
    expect(inlined.view.notes()).toHaveLength(1);
    const failed = start();
    failed.send(message({ ...data, focus: HISTORY_ID.events, inlinedFailed: true }));
    expect(failed.view.notes()).toHaveLength(1);

    const newest = await readGrowth(
      await catalogs.open(historyFixture.sqlite),
      'History',
      null,
      undefined,
      10,
    );
    const older = start();
    older.send(message(newest));
    expect(older.view.notes().length).toBeGreaterThan(0);
    const expired = await readGrowth(await catalogs.open(historyFixture.expired), 'Expired', null);
    const gone = start();
    gone.send(message(expired));
    expect(gone.view.notes().length).toBeGreaterThan(0);
    expect(gone.view.list().map((row) => row[0])).toEqual(['@56', '@55', '@0']);

    const none = start();
    none.send(message({ ...data, snapshots: [], changes: [] }));
    expect(none.view.charts()).toEqual([]);
    expect(none.view.select()).toBeUndefined();

    const many: GrowthData = {
      ...data,
      snapshots: Array.from({ length: 250 }, (_, index) =>
        snapshot(249 - index, [tableChange(3, 'inserted')]),
      ),
      changes: [],
    };
    const big = start();
    big.send(message(many));
    expect(big.view.list()).toHaveLength(LIST_ROWS);
    expect(big.view.list()[0]?.[0]).toBe('@249');
    expect(big.view.option().series[0]?.data).toHaveLength(250);

    const { send, view, app, changeTheme, resize } = start();
    send(message(data));
    const drawn = view.chart();
    resize();
    expect(drawn.resized).toBe(1);
    changeTheme();
    expect(drawn.disposed).toBe(true);
    expect(view.charts()).toHaveLength(1);

    const hostile = '<img src=x onerror=alert(1)>';
    const text = start();
    text.send(
      message({
        connection: hostile,
        scope: { kind: 'lake' },
        focus: 7,
        latest: 1,
        more: false,
        snapshots: [
          snapshot(1, [tableChange(7, 'inserted', hostile, hostile)], {
            author: hostile,
            commitMessage: hostile,
          }),
        ],
        tables: [{ id: 7, schema: hostile, name: hostile }],
        changes: [{ tableId: 7, snapshot: 1, rows: 3, sizeBytes: 30, files: 1, partialFiles: 0 }],
        inlinedMore: false,
        inlinedFailed: false,
      }),
    );
    expect(text.view.select().children.map((option) => option.textContent)).toEqual([
      'All tables',
      `${hostile}.${hostile}`,
    ]);
    expect(text.view.list()[0]).toEqual(['@1', '2026-11-01 00:00:01', '3', '+3', hostile, hostile]);
    expect(text.app().find((node) => node.tag === 'img')).toEqual([]);
    expect(app().find((node) => node.tag === 'img')).toEqual([]);
    const tooltip = text.view.option().tooltip.formatter([{ dataIndex: 0 }]);
    expect(tooltip).not.toContain('<img');
    expect(tooltip).toContain('&lt;img');
  });
});
