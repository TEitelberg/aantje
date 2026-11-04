import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import * as esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SnapshotReportData } from '../../src/snapshot-report/model';
import type { ShellRequest } from '../../src/shell/protocol';
import type { SnapshotReportPageRequest } from '../../src/snapshot-report/protocol';
import { HISTORY_ID } from '../support/expected-history';
import { historyReport, snapshot, tableChange } from './snapshot-report-support';

/**
 * Runs the real browser bundle against a stand-in for the DOM and for ECharts (which needs a canvas): the page shows
 * the data it is sent, the controls change what is drawn, clicks select snapshots, the actions leave the page as the
 * requests that the extension accepts, and the choices survive a hidden panel. The chart itself is checked in a real
 * browser by the end-to-end suite.
 */

type Listener = (event: Record<string, unknown>) => void;

class FakeNode {
  children: FakeNode[] = [];
  listeners = new Map<string, Listener[]>();
  className = '';
  title = '';
  tabIndex = -1;
  type = '';
  value = '';
  checked = false;
  min = '';
  max = '';
  style: Record<string, string> = {};
  private readonly attributeValues = new Map<string, string>();
  private own = '';

  constructor(
    readonly tag: string,
    private readonly onFocus: (node: FakeNode) => void = () => undefined,
  ) {}

  focus(): void {
    this.onFocus(this);
  }

  get textContent(): string {
    return this.own + this.children.map((child) => child.textContent).join('');
  }
  set textContent(text: string) {
    this.children = [];
    this.own = text;
  }
  hasClass(name: string): boolean {
    return this.className.split(' ').includes(name);
  }
  append(...nodes: (FakeNode | string)[]): void {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new FakeNode('#text') : node;
      if (typeof node === 'string') child.textContent = node;
      this.children.push(child);
    }
  }
  replaceChildren(...nodes: (FakeNode | string)[]): void {
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name: string, value: string): void {
    this.attributeValues.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributeValues.get(name) ?? null;
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target: this, ...event });
    }
  }
  find(predicate: (node: FakeNode) => boolean): FakeNode[] {
    return [this, ...this.children.flatMap((child) => child.find(predicate))].filter(predicate);
  }
}

interface DrawnOption {
  series: { type: string; data: unknown[] }[];
  xAxis: { type: string };
  yAxis: { data: string[] };
}

interface Drawn {
  option: DrawnOption;
  onPlotClick: ((x: number, extend: boolean) => void) | undefined;
  disposed: boolean;
  updates: DrawnOption[];
}

const DARK_VARIABLES: Record<string, string> = {
  '--vscode-editor-background': '#1e1e1e',
  '--vscode-charts-foreground': '#cccccc',
  '--vscode-charts-lines': 'rgba(204, 204, 204, 0.5)',
  '--vscode-charts-blue': '#3794ff',
  '--vscode-charts-green': '#89d185',
  '--vscode-charts-purple': '#b180d7',
  '--vscode-charts-yellow': '#cca700',
  '--vscode-charts-orange': '#d18616',
  '--vscode-charts-red': '#f14c4c',
  '--vscode-font-family': 'Segoe UI',
  '--vscode-font-size': '13px',
};
const HC_VARIABLES: Record<string, string> = {
  ...DARK_VARIABLES,
  '--vscode-editor-background': '#000000',
  '--vscode-charts-foreground': '#ffffff',
};

let bundle: string;
let history: SnapshotReportData;
const { events, customers } = HISTORY_ID;

beforeAll(async () => {
  const stub = fileURLToPath(new URL('../support/shell-charts-stub.ts', import.meta.url));
  const result = await esbuild.build({
    entryPoints: ['src/shell/client.ts'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    plugins: [
      {
        name: 'charts-stand-in',
        setup: (build) => build.onResolve({ filter: /\/charts$/ }, () => ({ path: stub })),
      },
    ],
  });
  bundle = result.outputFiles[0]?.text ?? '';
  history = await historyReport();
});

/** `saved` is the state that VS Code hands to a page that was taken down and comes back. */
function start(saved?: unknown) {
  let focused: FakeNode | undefined;
  let state = saved;
  const body = new FakeNode('body');
  body.className = 'vscode-dark';
  const posted: (ShellRequest | SnapshotReportPageRequest)[] = [];
  const drawn: Drawn[] = [];
  const windowListeners = new Map<string, Listener[]>();
  const observers: { callback: () => void }[] = [];
  const frames = new Map<number, () => void>();
  let nextFrame = 1;
  let current = DARK_VARIABLES;
  const sandbox = {
    document: {
      body,
      documentElement: new FakeNode('html'),
      createElement: (tag: string) =>
        new FakeNode(tag, (node) => {
          focused = node;
        }),
    },
    window: {
      addEventListener: (type: string, listener: Listener) =>
        windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]),
    },
    getComputedStyle: () => ({ getPropertyValue: (name: string) => current[name] ?? '' }),
    MutationObserver: class {
      constructor(private readonly callback: () => void) {}
      observe(): void {
        observers.push({ callback: this.callback });
      }
    },
    requestAnimationFrame: (callback: () => void) => {
      frames.set(nextFrame, callback);
      return nextFrame++;
    },
    cancelAnimationFrame: (id: number) => void frames.delete(id),
    acquireVsCodeApi: () => ({
      postMessage: (message: ShellRequest | SnapshotReportPageRequest) => posted.push(message),
      getState: () => state,
      setState: (next: unknown) => {
        // VS Code keeps the state as JSON.
        state = JSON.parse(JSON.stringify(next));
      },
    }),
    drawn,
  };
  runInNewContext(bundle, sandbox);
  const app = () => body.children[0] as FakeNode;
  const find = (predicate: (node: FakeNode) => boolean) => app().find(predicate);
  const view = {
    find,
    text: () => app().textContent,
    byClass: (name: string) => find((node) => node.hasClass(name)),
    button: (label: string) =>
      find((node) => node.tag === 'button' && node.textContent === label)[0] as FakeNode,
    buttons: (label: string) => find((node) => node.tag === 'button' && node.textContent === label),
    check: (label: string) =>
      (find((node) => node.tag === 'label' && node.textContent === label)[0] as FakeNode)
        .children[0] as FakeNode,
    /** What a click on a checkbox does: the browser flips it and then fires the event. */
    toggle: (label: string) => {
      const box = view.check(label);
      box.checked = !box.checked;
      box.fire('change');
    },
    second: () =>
      view
        .byClass('note')
        .map((node) => node.textContent)
        .find((text) => text.startsWith('Second snapshot')),
    number: (label: string) =>
      (find((node) => node.tag === 'label' && node.textContent === `${label} @`)[0] as FakeNode)
        .children[1] as FakeNode,
    setNumber: (label: string, text: string) => {
      view.number(label).value = text;
      view.number(label).fire('change');
    },
    rows: () =>
      (find((node) => node.tag === 'tbody')[0] as FakeNode).children.map((row) =>
        row.children.map((cell) => cell.textContent),
      ),
    ids: () => view.rows().map((row) => row[0]),
    pick: (label: string) =>
      find((node) => node.hasClass('pick') && node.textContent === label)[0] as FakeNode,
    detailTitle: () => find((node) => node.tag === 'h2' && node.textContent.startsWith('@'))[0]?.textContent,
    tableButtons: () =>
      view
        .byClass('table-row')
        .map((row) =>
          (row.children[2] as FakeNode).children
            .filter((node) => node.tag === 'button')
            .map((node) => node.textContent),
        ),
    live: () => drawn.filter((chart) => !chart.disposed),
    chart: () => view.live().at(-1) as Drawn,
    lanes: () => view.chart().option.yAxis.data,
  };
  const send = (message: unknown) =>
    (windowListeners.get('message') ?? []).forEach((listener) => listener({ data: message }));
  const showReport = (data: SnapshotReportData) => send({ type: 'snapshotReport', data });
  const changeTheme = (next: Record<string, string>, bodyClass: string) => {
    current = next;
    body.className = bodyClass;
    for (const { callback } of observers) callback();
    [...frames.values()].forEach((frame) => frame());
    frames.clear();
  };
  return { posted, view, showReport, send, changeTheme, saved: () => state, focused: () => focused };
}

const kindSeriesLengths = (chart: Drawn): number[] =>
  chart.option.series.filter((series) => series.type === 'scatter').map((series) => series.data.length);

const marker = (id: number) => [
  {
    coords: [
      [id, -0.5],
      [id, 8.5],
    ],
  },
];

describe('the snapshot report in the page client', () => {
  it('shows the history fixture: 57 snapshots newest first, their tables and one swimlane chart, as text and not as markup', () => {
    const { posted, view, showReport } = start();
    expect(posted).toEqual([{ type: 'ready' }]);
    showReport(history);

    expect(view.find((node) => node.getAttribute('role') === 'tab')).toEqual([]);
    expect(view.live()).toHaveLength(1);
    expect(kindSeriesLengths(view.chart())).toEqual([18, 2, 2, 35, 1]);
    expect(view.lanes()).toHaveLength(9);
    expect(view.chart().option.xAxis.type).toBe('value');

    const rows = view.rows();
    expect(rows).toHaveLength(57);
    expect(rows[0]?.[0]).toBe('@56');
    expect(rows.find((row) => row[0] === '@25')?.[2]).toContain('tillmann');
    expect(rows.find((row) => row[0] === '@23')?.[3]).toBe('shop.events, shop.customers');
    expect(view.detailTitle()).toBeUndefined();

    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const bad = start();
    bad.showReport({
      ...history,
      connection: hostile,
      snapshots: [
        snapshot(5, [tableChange(3, 'inserted', hostile, hostile)], {
          author: hostile,
          commitMessage: hostile,
        }),
      ],
    });
    bad.view.pick('@5').fire('click');
    expect(bad.view.find((node) => node.tag === 'img' || node.tag === 'script')).toEqual([]);
    expect(bad.view.text()).toContain(`${hostile}.${hostile}`);
    expect(bad.view.byClass('who').map((node) => node.textContent)).toContain(`${hostile} · ${hostile}`);

    for (const message of [
      { type: 'snapshotReport', data: { connection: 'x' } },
      { type: 'statistics', data: 7 },
    ]) {
      const broken = start();
      broken.send(message);
      expect(broken.view.live(), JSON.stringify(message)).toEqual([]);
      expect(broken.view.text(), JSON.stringify(message)).not.toBe('');
    }
    const empty = start();
    empty.showReport({ ...history, snapshots: [] });
    expect(empty.view.live()).toEqual([]);
    expect(empty.view.byClass('toolbar')).toEqual([]);
  });

  it('selects a snapshot from the list or the chart and posts its actions with the snapshot, table and comparison target', () => {
    const { posted, view, showReport, focused } = start();
    showReport(history);

    view.pick('@23').fire('click');
    expect(view.detailTitle()).toContain('@23 ·');
    expect(view.pick('@23').getAttribute('aria-pressed')).toBe('true');
    expect(view.tableButtons()).toHaveLength(2);

    view.button('Show catalog at @23').fire('click');
    view.button('Show latest snapshot').fire('click');
    view.buttons('previous @22')[0]?.fire('click');
    view.buttons('latest @56')[0]?.fire('click');
    view.buttons('Rows changed')[1]?.fire('click');
    view.buttons('Query...')[0]?.fire('click');
    view.buttons('previous @22')[1]?.fire('click');
    view.buttons('latest @56')[2]?.fire('click');
    expect(posted.slice(1)).toEqual([
      { type: 'action', action: 'showCatalog', snapshot: 23 },
      { type: 'action', action: 'showLatest' },
      { type: 'action', action: 'compareSnapshots', snapshot: 23, against: 'previous' },
      { type: 'action', action: 'compareSnapshots', snapshot: 23, against: 'latest' },
      { type: 'action', action: 'rowsChanged', snapshot: 23, table: customers },
      { type: 'action', action: 'query', snapshot: 23, table: events },
      { type: 'action', action: 'compareSchema', snapshot: 23, table: events, against: 'previous' },
      { type: 'action', action: 'compareSchema', snapshot: 23, table: customers, against: 'latest' },
    ]);

    // A dropped table offers nothing; the catalog can still be compared.
    view.pick('@45').fire('click');
    expect(view.tableButtons()).toEqual([[]]);
    expect(view.button('previous @44')).toBeDefined();
    expect(view.button('Query...')).toBeUndefined();

    // A click on the chart takes the nearest column, clamped to its ends; Ctrl-click takes the second snapshot.
    const chart = view.chart();
    chart.onPlotClick?.(23.2, false);
    expect(view.detailTitle()).toContain('@23 ·');
    expect(chart.updates.at(-1)?.series.at(-1)?.data).toEqual(marker(23));
    chart.onPlotClick?.(29.6, true);
    expect(view.second()).toContain('@30');
    posted.length = 0;
    view.buttons('@30')[0]?.fire('click');
    view.buttons('@30')[2]?.fire('click');
    expect(posted).toEqual([
      { type: 'action', action: 'compareSnapshots', snapshot: 23, against: 'other', other: 30 },
      {
        type: 'action',
        action: 'compareSchema',
        snapshot: 23,
        table: customers,
        against: 'other',
        other: 30,
      },
    ]);
    chart.onPlotClick?.(30, true);
    expect(view.second()).toBeUndefined();
    chart.onPlotClick?.(-4, false);
    expect(view.detailTitle()).toContain('@0 ·');
    chart.onPlotClick?.(999, false);
    expect(view.detailTitle()).toContain('@56 ·');

    // The list takes Ctrl- or Cmd-click as the second snapshot, and Clear removes it.
    const rowClass = (label: string) =>
      view.find((node) => node.tag === 'tr' && node.children[0]?.children[0]?.textContent === label)[0]
        ?.className;
    view.pick('@23').fire('click');
    view.pick('@23').fire('click', { ctrlKey: true });
    expect(view.second()).toBeUndefined();
    view.pick('@40').fire('click', { metaKey: true });
    expect(view.second()).toContain('@40');
    expect([rowClass('@23'), rowClass('@40'), rowClass('@24')]).toEqual(['selected', 'other', '']);
    view.button('Clear').fire('click');
    expect(view.second()).toBeUndefined();
    expect(focused()?.hasClass('detail')).toBe(true);
  });

  it('narrows the chart and the list by tables, kinds, range and time axis, and draws again after a theme change keeping the selection', () => {
    const { view, showReport, changeTheme } = start();
    showReport(history);
    const before = view.chart();

    view.toggle('shop');
    expect(before.disposed).toBe(true);
    expect(view.lanes()).toEqual(['t9', 't3', 't19', 't10', 't6', 't15', 't11']);
    view.toggle('events');
    view.toggle('customers');
    expect(view.lanes()).toEqual(['t19', 't10', 't6', 't15', 't11']);
    view.toggle('events');
    expect(view.check('shop').checked).toBe(false);
    view.button('All tables').fire('click');
    expect(view.lanes()).toHaveLength(9);

    view.toggle('Maintenance');
    expect(kindSeriesLengths(view.chart())).toEqual([18, 2, 2, 35, 0]);
    expect(view.ids()).not.toContain('@55');
    view.toggle('Maintenance');
    expect(view.ids()).toContain('@55');
    for (const label of ['Insert', 'Update', 'Delete', 'Schema change', 'Maintenance']) {
      view.toggle(label);
    }
    expect(view.live()).toEqual([]);
    expect(view.rows()).toEqual([]);
    for (const label of ['Insert', 'Update', 'Delete', 'Schema change', 'Maintenance']) {
      view.toggle(label);
    }

    view.setNumber('From', '50');
    expect(view.ids()).toEqual(['@56', '@55', '@54', '@53', '@52', '@51', '@50']);
    view.setNumber('To', '51');
    expect(view.ids()).toEqual(['@51', '@50']);
    for (const [end, text, kept] of [
      ['From', '-20', '0'],
      ['To', '9999', '56'],
      ['To', 'many', '56'],
      ['To', '', '56'],
      ['From', '12.5', '0'],
      ['From', '  ', '0'],
    ] as const) {
      view.setNumber(end, text);
      expect(view.number(end).value, `${end} = ${JSON.stringify(text)}`).toBe(kept);
    }
    expect(view.rows()).toHaveLength(57);

    view.button('Time').fire('click');
    const chart = view.chart();
    expect(chart.option.xAxis.type).toBe('time');
    const tenth = history.snapshots.find((candidate) => candidate.id === 10);
    chart.onPlotClick?.(Date.parse(tenth?.time ?? '') + 1, false);
    expect(view.detailTitle()).toContain('@10 ·');

    view.pick('@56').fire('click');
    changeTheme(HC_VARIABLES, 'vscode-high-contrast');
    expect(chart.disposed).toBe(true);
    expect(view.live()).toHaveLength(1);
    expect(view.detailTitle()).toContain('@56 ·');
    expect(view.chart().option.series.at(-1)?.data).toHaveLength(1);
  });

  describe('what the user chose', () => {
    const choose = (view: ReturnType<typeof start>['view']) => {
      view.pick('@23').fire('click');
      view.pick('@40').fire('click', { ctrlKey: true });
      view.toggle('Maintenance');
      view.toggle('shop');
      view.button('Time').fire('click');
      view.setNumber('From', '5');
    };

    it('asks for the Markdown document with the choices, never with text', () => {
      const { posted, view, showReport } = start();
      showReport(history);
      view.toggle('events');
      view.button('Open as Markdown').fire('click');
      view.toggle('Maintenance');
      view.toggle('Insert');
      view.setNumber('From', '6');
      view.button('Open as Markdown').fire('click');
      expect(posted.slice(1)).toEqual([
        {
          type: 'markdown',
          view: {
            lanes: ['t3'],
            kinds: ['insert', 'update', 'delete', 'ddl', 'maintenance'],
            range: { from: 0, to: 56 },
          },
        },
        {
          type: 'markdown',
          view: { lanes: ['t3'], kinds: ['update', 'delete', 'ddl'], range: { from: 6, to: 56 } },
        },
      ]);
    });

    it('comes back after VS Code took the page down, stays on Refresh, and starts fresh when the saved state is foreign', () => {
      const first = start();
      first.showReport(history);
      choose(first.view);
      const rowsBefore = first.view.rows();
      const saved = first.saved();

      const again = start(saved);
      again.showReport(history);
      expect(again.view.detailTitle()).toContain('@23 ·');
      expect(again.view.second()).toContain('@40');
      expect(again.view.rows()).toEqual(rowsBefore);
      expect(again.view.button('Time').getAttribute('aria-pressed')).toBe('true');
      expect(again.view.number('From').value).toBe('5');
      expect(again.view.check('Maintenance').checked).toBe(false);
      expect(again.view.lanes()).toHaveLength(7);

      for (const [name, state, data] of [
        ['another connection', saved, { ...history, connection: 'Other' }],
        ...[undefined, null, 'text', 7, {}, { connection: 'History' }].map(
          (value) => [JSON.stringify(value) ?? 'undefined', value, history] as const,
        ),
      ] as const) {
        const fresh = start(state);
        fresh.showReport(data);
        expect(fresh.view.detailTitle(), name).toBeUndefined();
        expect(fresh.view.check('Maintenance').checked, name).toBe(true);
        expect(fresh.view.lanes(), name).toHaveLength(9);
      }

      const { posted, view, showReport, focused } = start();
      showReport({ ...history, snapshots: history.snapshots.slice(1) });
      expect(view.number('To').value).toBe('55');
      choose(view);
      view.button('Refresh').fire('click');
      expect(posted.at(-1)).toEqual({ type: 'refresh' });
      // The snapshot @40 vanished from the data; a new latest snapshot arrived.
      showReport({ ...history, snapshots: history.snapshots.filter(({ id }) => id !== 40) });
      expect(view.detailTitle()).toContain('@23 ·');
      expect(view.second()).toBeUndefined();
      expect(view.number('From').value).toBe('5');
      expect(view.number('To').value).toBe('56');
      expect(focused()?.textContent).toBe('Refresh');
      view.setNumber('To', '55');
      showReport(history);
      expect(view.number('To').value).toBe('55');
      expect(view.ids()).not.toContain('@56');
    });
  });
});
