import { runInNewContext } from 'node:vm';
import * as esbuild from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GridData } from '../../src/data/types';
import type { ExtensionMessage, ResultsMessage, WebviewMessage } from '../../src/grid/protocol';
import { applyMessage } from '../../src/grid/results-model';
import type { ResultsRunState, ResultsRunSummary } from '../../src/grid/results-model';
import { engineSkipReason } from './data-support';
import { HOSTILE_SQL, realRun } from './results-support';
import type { RealRun } from './results-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`The results page tests with a real session are skipped: ${skipReason}`);
}

/**
 * Runs the real browser bundle against a stand-in for the DOM. It proves that the bundle loads, answers with
 * `ready`, renders what the extension sends, keeps the focus and the ARIA attributes in step with what is shown,
 * and posts the messages for copy and export. The stand-in follows the DOM where the client depends on it (a
 * `tabindex` attribute and `tabIndex` are one value, `getAttribute` returns null for a missing attribute,
 * `focus()` moves `document.activeElement`), so that the tests can fail. How it looks and scrolling are covered
 * by the end-to-end suite (test/e2e/specs/data-features.mjs), which drives the page in a real browser.
 */

type Listener = (event: Record<string, unknown>) => void;

const FOCUSABLE = new Set(['input', 'button', 'select', 'textarea', 'a']);
/** The height of a drawn row in the stand-in, as the browser would lay it out. */
const ROW_PX = 20;

class FakeNode {
  static active: FakeNode | null = null;

  children: FakeNode[] = [];
  parentElement: FakeNode | null = null;
  listeners = new Map<string, Listener[]>();
  classes = new Set<string>();
  className = '';
  title = '';
  placeholder = '';
  value = '';
  /** How often the children were replaced: a rebuild of the table body counts one. */
  replacements = 0;
  style: Record<string, string> = {};
  scrollTop = 0;
  clientHeight = 0;
  private readonly attributeValues = new Map<string, string>();
  private own = '';

  constructor(readonly tag: string) {}

  get textContent(): string {
    return this.own + this.children.map((child) => child.textContent).join('');
  }
  set textContent(text: string) {
    this.children = [];
    this.own = text;
  }
  get tabIndex(): number {
    const value = this.attributeValues.get('tabindex');
    return value === undefined ? (FOCUSABLE.has(this.tag) ? 0 : -1) : Number(value);
  }
  set tabIndex(value: number) {
    this.attributeValues.set('tabindex', String(value));
  }
  get classList() {
    return {
      toggle: (name: string, on: boolean) => void (on ? this.classes.add(name) : this.classes.delete(name)),
    };
  }
  get rows(): FakeNode[] {
    return this.children;
  }
  get offsetHeight(): number {
    return this.tag === 'tbody' ? this.children.length * ROW_PX : 0;
  }
  get cells(): FakeNode[] {
    return this.children;
  }
  get sectionRowIndex(): number {
    return this.parentElement?.children.indexOf(this) ?? -1;
  }
  get cellIndex(): number {
    return this.sectionRowIndex;
  }
  hasClass(name: string): boolean {
    return this.classes.has(name) || this.className.split(' ').includes(name);
  }
  append(...nodes: (FakeNode | string)[]): void {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new FakeNode('#text') : node;
      if (typeof node === 'string') child.textContent = node;
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...nodes: (FakeNode | string)[]): void {
    this.replacements++;
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name: string, value: string): void {
    this.attributeValues.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributeValues.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributeValues.has(name);
  }
  removeAttribute(name: string): void {
    this.attributeValues.delete(name);
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  closest(tag: string): FakeNode | null {
    return this.tag === tag ? this : (this.parentElement?.closest(tag) ?? null);
  }
  /** Like the DOM: an element takes the focus only when it is focusable by itself or has a tabindex. */
  focus(): void {
    if (FOCUSABLE.has(this.tag) || this.attributeValues.has('tabindex')) {
      FakeNode.active = this;
    }
  }
  fire(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ target: this, preventDefault() {}, ...event });
    }
  }
  find(predicate: (node: FakeNode) => boolean): FakeNode[] {
    return [this, ...this.children.flatMap((child) => child.find(predicate))].filter(predicate);
  }
}

const COLUMNS = [
  { name: 'id', type: 'INTEGER', kind: 'number' },
  { name: 'customer', type: 'STRUCT(name VARCHAR, tags VARCHAR[])', kind: 'nested' },
  { name: 'amount', type: 'DECIMAL(10,2)', kind: 'number' },
] as const;
const DATA: GridData = {
  table: { schema: 'sales', table: 'orders' },
  columns: COLUMNS,
  rows: [
    [1, '{"name":"a","tags":["x"]}', '1.50'],
    [2, '{"name":"b","tags":[]}', '2.50'],
    [3, null, '3.00'],
  ],
  limit: 1000,
  truncated: true,
  elapsedMs: 12.4,
};
const ROW_1_CUSTOMER = '{"name":"a","tags":["x"]}';
const ROW_2_CUSTOMER = '{"name":"b","tags":[]}';

let bundle: string;
beforeAll(async () => {
  const result = await esbuild.build({
    entryPoints: ['src/grid/client.ts'],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  });
  bundle = result.outputFiles[0]?.text ?? '';
});

/** `state` is what the webview state of VS Code keeps: pass the same object to a second page to reload it. */
function start(state: { value: unknown } = { value: undefined }) {
  FakeNode.active = null;
  const body = new FakeNode('body');
  const posted: WebviewMessage[] = [];
  const windowListeners: Listener[] = [];
  const selection = { text: '' };
  const timers = new Map<number, { run: () => void; due: number }>();
  let now = 0;
  let nextTimer = 1;
  const created = { count: 0 };
  const sandbox = {
    document: {
      body,
      createElement: (tag: string) => {
        created.count++;
        return new FakeNode(tag);
      },
      get activeElement() {
        return FakeNode.active;
      },
    },
    window: {
      addEventListener: (_type: string, listener: Listener) => windowListeners.push(listener),
      getSelection: () => ({ toString: () => selection.text }),
    },
    setTimeout: (run: () => void, delay: number) => {
      timers.set(nextTimer, { run, due: now + delay });
      return nextTimer++;
    },
    clearTimeout: (id: number | undefined) => void (id === undefined ? 0 : timers.delete(id)),
    acquireVsCodeApi: () => ({
      postMessage: (message: WebviewMessage) => posted.push(message),
      getState: () => state.value,
      setState: (value: unknown) => void (state.value = value),
    }),
    Element: FakeNode,
    HTMLTableRowElement: {
      [Symbol.hasInstance]: (value: unknown) => value instanceof FakeNode && value.tag === 'tr',
    },
  };
  runInNewContext(bundle, sandbox);
  const send = (message: ExtensionMessage) =>
    windowListeners.forEach((listener) => listener({ data: message }));
  const advance = (milliseconds: number) => {
    now += milliseconds;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].due - b[1].due)) {
      if (timer.due <= now && timers.delete(id)) timer.run();
    }
  };
  const page = () => {
    const app = body.children[0] as FakeNode;
    const tbody = app.find((node) => node.tag === 'tbody')[0] as FakeNode;
    return {
      app,
      tbody,
      status: app.find((node) => node.hasClass('status'))[0] as FakeNode,
      scroll: app.find((node) => node.hasClass('scroll'))[0] as FakeNode,
      sorter: (name: string) =>
        app.find((node) => node.tag === 'button' && node.children[0]?.textContent === name)[0] as FakeNode,
      /** The header cell of a data column. */
      header: (index: number) => app.find((node) => node.tag === 'th')[index + 1] as FakeNode,
      filter: (index: number) => app.find((node) => node.tag === 'input')[index] as FakeNode,
      button: (label: string) =>
        app.find((node) => node.tag === 'button' && node.textContent === label)[0] as FakeNode,
      table: () => tbody.children.map((row) => row.children.slice(1).map((cell) => cell.textContent)),
      /** The cell of row and column (without the row number), as the user sees it. */
      cell: (row: number, column: number) => tbody.children[row]?.children[column + 1] as FakeNode,
      /** The tab index of every data cell, row by row. */
      tabIndexes: () => tbody.children.map((row) => row.children.slice(1).map((cell) => cell.tabIndex)),
    };
  };
  const type = (index: number, text: string) => {
    const input = page().filter(index);
    input.value = text;
    input.fire('input');
  };
  const press = (key: string, extra: Record<string, unknown> = {}) => {
    const prevented: boolean[] = [];
    page().tbody.fire('keydown', { key, preventDefault: () => prevented.push(true), ...extra });
    return prevented.length > 0;
  };
  return { body, posted, send, page, selection, advance, timers, type, press, windowListeners, created };
}

/** One column of the shown rows. */
const column = (view: ReturnType<ReturnType<typeof start>['page']>, index: number): string[] =>
  view.table().map((row) => row[index] ?? '');

describe('the grid client bundle', () => {
  it('is a self-contained script that says ready and renders the rows with NULL marked', () => {
    expect(bundle).not.toMatch(/\brequire\(|^import |\bexport /m);
    const { posted, send, page } = start();
    expect(posted).toEqual([{ type: 'ready' }]);
    send({ type: 'data', data: DATA });
    const view = page();
    expect(view.table()).toEqual([
      ['1', ROW_1_CUSTOMER, '1.50'],
      ['2', ROW_2_CUSTOMER, '2.50'],
      ['3', 'NULL', '3.00'],
    ]);
    expect(view.cell(2, 1).hasClass('null')).toBe(true);
    expect(view.cell(0, 1).hasClass('null')).toBe(false);
    expect(view.cell(0, 2).hasClass('num')).toBe(true);
  });

  it('ignores a message it cannot read instead of throwing, and keeps what it shows', () => {
    const { windowListeners, send, page } = start();
    send({ type: 'data', data: DATA });
    const invalid: [string, unknown][] = [
      ['null', null],
      ['a string', 'data'],
      ['an array', [{ type: 'data', data: DATA }]],
      ['no type', {}],
      ['a data message without data', { type: 'data' }],
      ['data that is null', { type: 'data', data: null }],
      ['data without columns', { type: 'data', data: { ...DATA, columns: undefined } }],
      ['rows that are not lists', { type: 'data', data: { ...DATA, rows: ['x'] } }],
      ['a row with an object in a cell', { type: 'data', data: { ...DATA, rows: [[{}]] } }],
      [
        'a column of an unknown kind',
        { type: 'data', data: { ...DATA, columns: [{ ...COLUMNS[0], kind: 'x' }] } },
      ],
      ['a data message that is only inherited', Object.create({ type: 'data', data: DATA }) as object],
    ];
    for (const [name, message] of invalid) {
      expect(() => windowListeners.forEach((listener) => listener({ data: message })), name).not.toThrow();
      expect(page().table(), name).toHaveLength(3);
    }
  });

  it('sorts by a click on the header: ascending, descending, original order; the sign moves to the last header', () => {
    const { send, page } = start();
    send({ type: 'data', data: DATA });
    expect(page().header(2).hasAttribute('aria-sort')).toBe(false);
    page().sorter('amount').fire('click');
    expect(column(page(), 2)).toEqual(['1.50', '2.50', '3.00']);
    expect(page().header(2).getAttribute('aria-sort')).toBe('ascending');
    page().sorter('amount').fire('click');
    expect(column(page(), 2)).toEqual(['3.00', '2.50', '1.50']);
    expect(page().header(2).getAttribute('aria-sort')).toBe('descending');
    page().sorter('amount').fire('click');
    expect(column(page(), 2)).toEqual(['1.50', '2.50', '3.00']);
    expect(page().header(2).hasAttribute('aria-sort')).toBe(false);

    page().sorter('amount').fire('click');
    page().sorter('id').fire('click');
    expect(page().header(2).hasAttribute('aria-sort')).toBe(false);
    expect(page().header(0).getAttribute('aria-sort')).toBe('ascending');

    // Only rows after the first change their place.
    const rows = [
      [1, 'a', '1.50'],
      [3, 'c', '3.00'],
      [2, 'b', '2.50'],
    ];
    send({ type: 'data', data: { ...DATA, rows, elapsedMs: 5 } });
    expect(column(page(), 0)).toEqual(['1', '3', '2']);
    page().sorter('id').fire('click');
    expect(column(page(), 0)).toEqual(['1', '2', '3']);

    // Another result shows unsorted and unfiltered.
    send({ type: 'data', data: { ...DATA, rows: [[9, 'x', '0.00']], truncated: false } });
    expect(page().table()).toEqual([['9', 'x', '0.00']]);
    expect(page().header(0).hasAttribute('aria-sort')).toBe(false);
    expect(page().filter(1).value).toBe('');
  });

  it('filters after a pause in typing, and rebuilds the table only when the shown rows change', () => {
    const { send, page, type, advance } = start();
    send({ type: 'data', data: DATA });
    const before = page().tbody.replacements;
    type(1, 'n');
    advance(100);
    type(1, 'nu');
    advance(100);
    type(1, 'null');
    advance(149);
    expect(page().tbody.replacements).toBe(before);
    expect(page().table()).toHaveLength(3);
    advance(1);
    expect(page().tbody.replacements).toBe(before + 1);
    expect(page().table()).toEqual([['3', 'NULL', '3.00']]);
    type(1, '');
    advance(150);
    expect(page().table()).toHaveLength(3);

    const same = page().tbody.replacements;
    type(2, '.');
    advance(150);
    expect(page().tbody.replacements).toBe(same);
    type(2, '.50');
    advance(150);
    expect(page().tbody.replacements).toBe(same + 1);
    type(2, '.5');
    advance(150);
    expect(page().tbody.replacements).toBe(same + 1);
    expect(column(page(), 0)).toEqual(['1', '2']);
  });

  it('adds a tooltip from 61 characters, bounds a huge value, and tells a real NULL from the text NULL', () => {
    const wide: GridData = {
      ...DATA,
      columns: [{ name: 't', type: 'VARCHAR', kind: 'text' }],
      rows: [['x'.repeat(60)], ['y'.repeat(61)], ['NULL'], [null], ['z'.repeat(1_000_000)]],
    };
    const { send, page } = start();
    send({ type: 'data', data: wide });
    expect(page().cell(0, 0).title).toBe('');
    expect(page().cell(1, 0).title).toBe('y'.repeat(61));
    expect(page().cell(4, 0).textContent).toBe(`${'z'.repeat(2000)}…`);
    expect(page().cell(4, 0).title).toBe(`${'z'.repeat(1000)}…`);
    expect(page().cell(2, 0).hasAttribute('aria-label')).toBe(false);
    expect(page().cell(2, 0).hasClass('null')).toBe(false);
    expect(page().cell(3, 0).textContent).toBe('NULL');
    expect(page().cell(3, 0).hasAttribute('aria-label')).toBe(true);
    expect(page().cell(3, 0).hasClass('null')).toBe(true);
  });

  it('keeps one tab stop on the selected cell through moving, sorting, filtering and clicks', () => {
    const { send, page, press, type, advance } = start();
    send({ type: 'data', data: DATA });
    expect(page().tabIndexes()).toEqual([
      [0, -1, -1],
      [-1, -1, -1],
      [-1, -1, -1],
    ]);
    const cells = page().tbody.find((node) => node.tag === 'td' && !node.hasClass('rn'));
    expect(cells.filter((cell) => !cell.hasAttribute('tabindex'))).toEqual([]);

    press('ArrowDown');
    press('ArrowRight');
    expect(page().tabIndexes()[1]).toEqual([-1, 0, -1]);
    expect(FakeNode.active).toBe(page().cell(1, 1));
    page().sorter('amount').fire('click');
    page().sorter('amount').fire('click');
    expect(
      page()
        .tabIndexes()
        .flat()
        .filter((index) => index === 0),
    ).toHaveLength(1);
    expect(page().cell(1, 1).tabIndex).toBe(0);
    type(1, 'null');
    advance(150);
    expect(page().tabIndexes()).toEqual([[-1, 0, -1]]);

    type(1, '');
    advance(150);
    page().tbody.fire('click', { target: page().cell(2, 2) });
    expect(FakeNode.active).toBe(page().cell(2, 2));
    page().tbody.fire('click', { target: page().tbody.children[1]?.children[0] });
    expect(page().tabIndexes()[1]).toEqual([0, -1, -1]);
  });

  it('moves with the arrow keys, Home and End, stops at the edges, and does not scroll the page', () => {
    const { send, press, posted } = start();
    send({ type: 'data', data: DATA });
    posted.length = 0;
    const copied = () => {
      press('c', { ctrlKey: true });
      return posted.splice(0).map((message) => (message.type === 'copy' ? message.text : message.type));
    };

    expect(copied()).toEqual(['1']);
    press('ArrowUp');
    press('ArrowLeft');
    press('Home');
    expect(copied()).toEqual(['1']);
    for (const key of [
      'ArrowDown',
      'ArrowDown',
      'ArrowDown',
      'ArrowRight',
      'ArrowRight',
      'ArrowRight',
      'End',
    ]) {
      press(key);
    }
    expect(copied()).toEqual(['3.00']);
    press('ArrowUp');
    expect(copied()).toEqual(['2.50']);
    press('ArrowLeft');
    expect(copied()).toEqual([ROW_2_CUSTOMER]);
    press('Home');
    expect(copied()).toEqual(['2']);
    press('End');
    expect(copied()).toEqual(['2.50']);
    for (const key of ['ArrowUp', 'ArrowUp', 'ArrowUp']) press(key);
    expect(copied()).toEqual(['1.50']);

    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      expect(press(key), key).toBe(true);
    }
    expect(press('x')).toBe(false);
    expect(press('Tab')).toBe(false);
  });

  it('copies the selected cell, the row, all rows and a CSV export, in the order shown, and only what is shown', () => {
    const { send, page, posted, press, type, advance } = start();
    send({ type: 'data', data: DATA });
    posted.length = 0;
    page().tbody.fire('click', { target: page().cell(1, 2) });
    press('c', { ctrlKey: true });
    page().button('Copy row').fire('click');
    page().button('Copy all').fire('click');
    page().button('Export CSV').fire('click');
    expect(posted).toEqual([
      { type: 'copy', text: '2.50', what: 'cell' },
      { type: 'copy', text: '2\t"{""name"":""b"",""tags"":[]}"\t2.50', what: 'row' },
      {
        type: 'copy',
        what: 'all',
        text: 'id\tcustomer\tamount\n1\t"{""name"":""a"",""tags"":[""x""]}"\t1.50\n2\t"{""name"":""b"",""tags"":[]}"\t2.50\n3\t\t3.00',
      },
      {
        type: 'export',
        suggestedName: 'sales.orders.csv',
        csv: 'id,customer,amount\r\n1,"{""name"":""a"",""tags"":[""x""]}",1.50\r\n2,"{""name"":""b"",""tags"":[]}",2.50\r\n3,,3.00\r\n',
      },
    ]);

    type(1, 'null');
    advance(150);
    posted.length = 0;
    page().tbody.fire('click', { target: page().cell(0, 0) });
    page().button('Copy row').fire('click');
    page().button('Copy all').fire('click');
    page().button('Export CSV').fire('click');
    expect(posted).toEqual([
      { type: 'copy', text: '3\t\t3.00', what: 'row' },
      { type: 'copy', text: 'id\tcustomer\tamount\n3\t\t3.00', what: 'all' },
      { type: 'export', suggestedName: 'sales.orders.csv', csv: 'id,customer,amount\r\n3,,3.00\r\n' },
    ]);

    type(1, '');
    advance(150);
    page().sorter('amount').fire('click');
    page().sorter('amount').fire('click');
    posted.length = 0;
    page().tbody.fire('click', { target: page().cell(0, 2) });
    press('c', { ctrlKey: true });
    page().button('Export CSV').fire('click');
    expect(posted[0]).toEqual({ type: 'copy', text: '3.00', what: 'cell' });
    expect(posted[1]).toMatchObject({
      type: 'export',
      csv: expect.stringMatching(/^id,customer,amount\r\n3,,3\.00\r\n2,.*\r\n1,/) as string,
    });
  });

  it('copies only on Ctrl+C or Cmd+C, leaves it to the browser while text is selected, and copies nothing empty', () => {
    const { send, posted, press, selection } = start();
    send({ type: 'data', data: DATA });
    posted.length = 0;
    expect(press('a', { ctrlKey: true })).toBe(false);
    expect(press('f', { ctrlKey: true })).toBe(false);
    expect(press('c')).toBe(false);
    expect(posted).toEqual([]);
    expect(press('C', { ctrlKey: true })).toBe(true);
    expect(press('c', { metaKey: true })).toBe(true);
    expect(posted).toEqual([
      { type: 'copy', text: '1', what: 'cell' },
      { type: 'copy', text: '1', what: 'cell' },
    ]);

    posted.length = 0;
    selection.text = 'nam';
    expect(press('c', { ctrlKey: true })).toBe(false);
    expect(posted).toEqual([]);

    const empty = start();
    empty.send({ type: 'data', data: { ...DATA, rows: [], truncated: false } });
    empty.posted.length = 0;
    empty.press('c', { ctrlKey: true });
    empty.page().button('Copy cell').fire('click');
    empty.page().button('Copy row').fire('click');
    expect(empty.posted).toEqual([]);
  });

  it('copies nothing from a NULL cell and says so for two seconds after the last try, but copies a row with a NULL', () => {
    const { send, page, posted, press, advance } = start();
    send({ type: 'data', data: DATA });
    const normal = page().status.textContent;
    page().tbody.fire('click', { target: page().cell(2, 1) });
    posted.length = 0;
    press('c', { ctrlKey: true });
    expect(posted).toEqual([]);
    expect(page().status.textContent).not.toBe(normal);
    const notice = page().status.textContent;

    advance(1500);
    press('c', { ctrlKey: true });
    advance(1500);
    expect(page().status.textContent).toBe(notice);
    advance(500);
    expect(page().status.textContent).toBe(normal);
    page().button('Copy cell').fire('click');
    expect(posted).toEqual([]);

    const other = start();
    other.send({ type: 'data', data: { ...DATA, rows: [[1, 'NULL', null]] } });
    other.posted.length = 0;
    other.page().tbody.fire('click', { target: other.page().cell(0, 1) });
    other.press('c', { ctrlKey: true });
    other.page().button('Copy row').fire('click');
    expect(other.posted).toEqual([
      { type: 'copy', text: 'NULL', what: 'cell' },
      { type: 'copy', text: '1\tNULL\t', what: 'row' },
    ]);
  });

  it('draws only the rows around the visible ones of a long result, follows the scroll and the keys, and filters and exports all rows', () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => [index + 1, `n${index + 1}`, `${index}.50`]);
    const { send, page, press, type, advance, posted } = start();
    send({ type: 'data', data: { ...DATA, rows, truncated: false } });
    const drawn = (): number[] => column(page(), 0).map(Number);
    expect(page().tbody.children.length).toBeLessThan(1000);
    expect(drawn()[0]).toBe(1);
    // The widths come from all rows, and assistive technology hears how many rows there are.
    const sizer = page().app.find((node) => node.hasClass('sizer'))[0];
    expect(sizer?.children.map((cell) => cell.textContent)).toEqual([
      '100000',
      '100000',
      'n100000',
      '10000.50',
    ]);
    expect(
      page()
        .app.find((node) => node.tag === 'table')[0]
        ?.getAttribute('aria-rowcount'),
    ).toBe('100001');

    const { scroll } = page();
    scroll.clientHeight = 400;
    scroll.scrollTop = 50_000 * ROW_PX;
    scroll.fire('scroll');
    expect(drawn()).toContain(50_001);
    expect(drawn()).not.toContain(1);
    expect(page().tbody.children.length).toBeLessThan(1000);

    const last = drawn().at(-1) ?? 0;
    page().tbody.fire('click', { target: page().cell(page().tbody.children.length - 1, 0) });
    press('ArrowDown');
    expect(FakeNode.active?.textContent).toBe(String(last + 1));
    scroll.scrollTop = 0;
    scroll.fire('scroll');
    expect(drawn()[0]).toBe(1);
    expect(FakeNode.active).toBe(page().tbody);
    press('ArrowDown');
    expect(FakeNode.active?.textContent).toBe(String(last + 2));

    type(1, 'n99999');
    advance(150);
    expect(page().table()).toEqual([['99999', 'n99999', '99998.50']]);
    type(1, '');
    advance(150);
    posted.length = 0;
    page().button('Export CSV').fire('click');
    const csv = posted[0]?.type === 'export' ? posted[0].csv.split('\r\n') : [];
    expect(csv).toHaveLength(100_002);
    expect(csv[100_000]).toBe('100000,n100000,99999.50');
  });

  it('brings back sort and filters for the same result in a fresh page, and starts fresh for a new result', () => {
    const state = { value: undefined as unknown };
    const first = start(state);
    first.send({ type: 'data', data: DATA });
    first.page().sorter('amount').fire('click');
    first.page().sorter('amount').fire('click');
    first.type(1, 'a');
    first.advance(150);
    expect(column(first.page(), 0)).toEqual(['2', '1']);

    const second = start(state);
    second.send({ type: 'data', data: DATA });
    expect(column(second.page(), 0)).toEqual(['2', '1']);
    expect(second.page().filter(1).value).toBe('a');
    expect(second.page().header(2).getAttribute('aria-sort')).toBe('descending');

    const third = start(state);
    third.send({ type: 'data', data: { ...DATA, elapsedMs: 99 } });
    expect(third.page().table()).toHaveLength(3);
    expect(third.page().filter(1).value).toBe('');
    expect(third.page().header(2).hasAttribute('aria-sort')).toBe(false);
  });
});

const HOSTILE = '<img src=x onerror=alert(1)>';
const CHANGES: GridData = {
  table: { schema: 'shop', table: 'customers' },
  columns: [
    { name: 'snapshot_id', type: 'BIGINT', kind: 'number' },
    { name: 'rowid', type: 'BIGINT', kind: 'number' },
    { name: 'change_type', type: 'VARCHAR', kind: 'text' },
    { name: 'id', type: 'INTEGER', kind: 'number' },
    { name: 'name', type: 'VARCHAR', kind: 'text' },
    { name: 'tier', type: 'VARCHAR', kind: 'text' },
  ],
  rows: [
    ['16', '2', 'insert', 3, 'cy', 'silver'],
    ['17', '1', 'update_preimage', 2, 'bob', null],
    ['17', '1', 'update_postimage', 2, 'bob', 'gold'],
    ['18', '3', 'delete', 4, HOSTILE, 'silver'],
  ],
  rowKinds: ['insert', 'update-before', 'update-after', 'delete'],
  summary: '1 inserted, 1 updated, 1 deleted (3 changes) after @15 until @18',
  limit: 1000,
  truncated: false,
  elapsedMs: 7,
};

describe('the grid client bundle for the changes of a table', () => {
  const rowsOf = (view: ReturnType<ReturnType<typeof start>['page']>): string[][] =>
    view.tbody.children.map((row) => row.children.map((cell) => cell.textContent));

  it('marks each row by its kind, marks the cells an update changed, shows the summary, and has no sort or filter', () => {
    const { send, page } = start();
    send({ type: 'data', data: CHANGES });
    const view = page();

    expect(view.tbody.children.map((row) => row.className)).toEqual([
      'chg-insert',
      'chg-update-before',
      'chg-update-after',
      'chg-delete',
    ]);
    expect(view.tbody.children.map((row) => (row.children[1] as FakeNode).hasClass('mk'))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(rowsOf(view)[0]).toEqual(['1', '+', '16', '2', 'insert', '3', 'cy', 'silver']);
    // Cell 7 is tier: NULL before, gold after. change_type differs too, but it is not a column of the table.
    expect(
      view.tbody.children.map((row) =>
        row.children.flatMap((cell, index) => (cell.hasClass('changed') ? [index] : [])),
      ),
    ).toEqual([[], [7], [7], []]);
    expect(view.app.find((node) => node.tag === 'input')).toHaveLength(0);
    expect(view.app.find((node) => node.tag === 'th')).toHaveLength(8);
    expect(view.app.find((node) => node.hasClass('summary')).map((node) => node.textContent)).toEqual([
      CHANGES.summary,
    ]);

    send({ type: 'data', data: DATA });
    expect(page().tbody.children.map((row) => row.className)).toEqual(['', '', '']);
    expect(page().tbody.children[0]?.children).toHaveLength(4);
    expect(page().app.find((node) => node.hasClass('summary') || node.hasClass('mk'))).toEqual([]);
  });

  it('copies and exports snapshot_id, rowid and change_type with the data, and not the mark', () => {
    const { send, page, posted } = start();
    send({ type: 'data', data: CHANGES });
    posted.length = 0;
    page().tbody.fire('click', { target: page().tbody.children[2]?.children[7] });
    page().button('Copy cell').fire('click');
    page().button('Copy row').fire('click');
    page().button('Copy all').fire('click');
    page().button('Export CSV').fire('click');

    expect(posted).toEqual([
      { type: 'copy', text: 'gold', what: 'cell' },
      { type: 'copy', text: '17\t1\tupdate_postimage\t2\tbob\tgold', what: 'row' },
      {
        type: 'copy',
        what: 'all',
        text: `snapshot_id\trowid\tchange_type\tid\tname\ttier\n16\t2\tinsert\t3\tcy\tsilver\n17\t1\tupdate_preimage\t2\tbob\t\n17\t1\tupdate_postimage\t2\tbob\tgold\n18\t3\tdelete\t4\t${HOSTILE}\tsilver`,
      },
      {
        type: 'export',
        suggestedName: 'shop.customers.csv',
        csv: `snapshot_id,rowid,change_type,id,name,tier\r\n16,2,insert,3,cy,silver\r\n17,1,update_preimage,2,bob,\r\n17,1,update_postimage,2,bob,gold\r\n18,3,delete,4,${HOSTILE},silver\r\n`,
      },
    ]);
  });

  it('moves the focus over the data cells only, and draws catalog text as text, never as markup', () => {
    const { send, page, press } = start();
    send({ type: 'data', data: CHANGES });
    const cellOf = (row: number, cell: number): FakeNode | undefined =>
      page().tbody.children[row]?.children[cell];

    page().tbody.fire('click', { target: cellOf(0, 1) });
    expect(FakeNode.active).toBe(cellOf(0, 2));
    press('End');
    expect(FakeNode.active).toBe(cellOf(0, 7));
    press('ArrowDown');
    expect(FakeNode.active).toBe(cellOf(1, 7));
    press('Home');
    expect(FakeNode.active).toBe(cellOf(1, 2));
    expect(rowsOf(page())[3]?.[6]).toBe(HOSTILE);
    expect(bundle).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it('draws an ordinary grid when the row kinds do not fit the rows, instead of tinting the wrong rows', () => {
    const wrong: unknown[][] = [
      ['insert', 'update-before'],
      ['insert', 'update-before', 'insert', 'delete'],
      ['insert', 'oops', 'update-after', 'delete'],
    ];
    for (const rowKinds of wrong) {
      const { send, page } = start();
      send({ type: 'data', data: { ...CHANGES, rowKinds: rowKinds as GridData['rowKinds'] } });

      expect(page().tbody.children.map((row) => row.className)).toEqual(['', '', '', '']);
      expect(page().app.find((node) => node.tag === 'input')).toHaveLength(6);
      expect(rowsOf(page())[0]).toEqual(['1', '16', '2', 'insert', '3', 'cy', 'silver']);
    }
  });
});

describe.skipIf(skipReason)('the grid client bundle for the results of the SQL editor', () => {
  let real: RealRun;
  beforeAll(async () => {
    real = await realRun();
  });

  const END: ResultsRunSummary = { cancelled: false, failed: true, elapsedMs: 1234.4, inTransaction: 'open' };

  /** What the user sees of the tabs and the Messages tab; `body` is the body of the page. */
  const look = (body: FakeNode) => {
    const app = body.children[0] as FakeNode;
    const tabs = app.find((node) => node.tag === 'button' && node.hasClass('tab'));
    return {
      app,
      tabs,
      selected: tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true'),
      tab: (index: number) => tabs[index] as FakeNode,
      runLine: app.find((node) => node.hasClass('run'))[0]?.textContent,
      rows: app
        .find((node) => node.hasClass('stmt'))
        .map((row) => row.children.map((cell) => cell.textContent)),
      errors: app.find((node) => node.hasClass('err')),
      header: app.find((node) => node.hasClass('sql') && node.tag === 'div')[0],
      banner: app.find((node) => node.hasClass('banner'))[0]?.textContent,
    };
  };

  /** A page that has seen a run: the messages of `real.events` after a begin, and an end when `ended`. */
  function played(count = real.events.length, ended = true, state?: { value: unknown }) {
    const page = start(state);
    page.send({ type: 'results-begin', script: real.script });
    for (const event of real.events.slice(0, count)) {
      page.send({ type: 'results-event', event });
    }
    if (ended) {
      page.send({ type: 'results-end', summary: END });
    }
    return page;
  }

  /** The whole page as text, to compare two pages. */
  function snapshot(page: ReturnType<typeof start>) {
    const view = look(page.body);
    return {
      tabs: view.tabs.map((tab) => tab.textContent),
      selected: view.selected,
      runLine: view.runLine,
      rows: view.rows,
      table: page.page().table(),
    };
  }

  /** A run of one statement with one result set; `sql` is the statement. */
  function playOne(page: ReturnType<typeof start>, sql: string, name: string, value: number) {
    page.send({ type: 'results-begin', script: sql });
    page.send({
      type: 'results-event',
      event: { kind: 'start', index: 0, statementType: 'SELECT', sql, offset: 0 },
    });
    page.send({
      type: 'results-event',
      event: {
        kind: 'resultSet',
        index: 0,
        columns: [{ name, type: 'INTEGER', kind: 'number' }],
        rows: [[value]],
        truncated: false,
        elapsedMs: 1,
      },
    });
    page.send({ type: 'results-end', summary: { ...END, failed: false } });
  }

  it('builds the line and the tab of a statement once: a later event of a long script creates a few elements, not the whole table again', () => {
    const { body, send, created } = start();
    const messagesView = () => look(body).app.find((node) => node.hasClass('messages-view'))[0];
    const STATEMENTS = 300;
    const sql = (index: number) => `INSERT INTO t VALUES (${index})`;
    const cost: number[] = [];
    send({ type: 'results-begin', script: 'script' });
    for (let index = 0; index < STATEMENTS; index++) {
      const before = created.count;
      send({
        type: 'results-event',
        event: { kind: 'start', index, statementType: 'INSERT', sql: sql(index), offset: 0 },
      });
      send({
        type: 'results-event',
        event: { kind: 'message', index, text: 'Inserted 1 row.', rowsAffected: 1, elapsedMs: 1 },
      });
      cost.push(created.count - before);
    }
    const view = messagesView();

    // Every statement has its line, in order, and the scrolling part of the page is the same element throughout.
    expect(look(body).rows).toHaveLength(STATEMENTS);
    expect(look(body).rows.at(-1)?.[2]).toContain(sql(STATEMENTS - 1));
    send({
      type: 'results-event',
      event: { kind: 'error', index: STATEMENTS, message: 'boom' },
    });
    expect(messagesView()).toBe(view);
    // The cost of an event does not grow with the number of statements before it.
    expect(Math.max(...cost.slice(-50))).toBeLessThanOrEqual(Math.max(...cost.slice(0, 50)) + 2);
    expect(Math.max(...cost)).toBeLessThan(40);
  });

  it('selects the tab by how the run goes: Messages while it runs, the first result when it ends, the choice of the user', () => {
    const { body, send, posted } = start();
    expect(posted).toEqual([{ type: 'ready' }]);
    send({ type: 'results-begin', script: 'SELECT 1' });
    expect(look(body).tabs).toHaveLength(1);
    expect(look(body).selected).toBe(0);
    expect(look(body).rows).toEqual([]);

    const running = played(7, false);
    expect(look(running.body).tabs).toHaveLength(2);
    expect(look(running.body).selected).toBe(0);
    look(running.body).tab(0).fire('click');
    running.send({ type: 'results-end', summary: END });
    expect(look(running.body).selected).toBe(0);

    const ended = played();
    expect(look(ended.body).tabs).toHaveLength(4);
    expect(look(ended.body).selected).toBe(1);
    look(ended.body).tab(0).fire('click');
    expect(look(ended.body).rows).toHaveLength(6);
    look(ended.body).tab(1).fire('click');
    expect(look(ended.body).rows).toEqual([]);
    look(ended.body).tab(0).fire('click');
    ended.send({ type: 'results-begin', script: real.script });
    for (const event of real.events) ended.send({ type: 'results-event', event });
    ended.send({ type: 'results-end', summary: END });
    expect(look(ended.body).selected).toBe(1);

    const noResult = start();
    noResult.send({ type: 'results-begin', script: 'CREATE TABLE x (a INTEGER)' });
    for (const event of real.events.slice(0, 2)) noResult.send({ type: 'results-event', event });
    noResult.send({ type: 'results-end', summary: { ...END, failed: false, inTransaction: 'none' } });
    expect(look(noResult.body).tabs).toHaveLength(1);
    expect(look(noResult.body).selected).toBe(0);

    ended.send({ type: 'results-begin', script: 'SELECT 2' });
    expect(look(ended.body).tabs).toHaveLength(1);
    expect(look(ended.body).rows).toEqual([]);
  });

  it('lists the failure with a button that asks the extension to show the statement', () => {
    const { body, posted } = played();
    look(body).tab(0).fire('click');
    posted.length = 0;

    const view = look(body);
    expect(view.rows).toHaveLength(6);
    expect(view.errors).toHaveLength(1);
    expect(view.errors[0]?.textContent).toContain('nope');
    const [button] = view.errors[0]?.find((node) => node.tag === 'button') ?? [];
    button?.fire('click');
    expect(posted).toEqual([{ type: 'reveal', index: 5 }]);

    const broken = start();
    broken.send({ type: 'results-begin', script: 'SELEC 1' });
    broken.send({
      type: 'results-event',
      event: {
        kind: 'error',
        index: 0,
        message: 'Syntax error. No statement was run.',
        position: { offset: 0, length: 5 },
      },
    });
    broken.send({ type: 'results-end', summary: { ...END, inTransaction: 'none' } });
    broken.posted.length = 0;
    expect(look(broken.body).rows).toHaveLength(1);
    look(broken.body)
      .errors[0]?.find((node) => node.tag === 'button')[0]
      ?.fire('click');
    expect(broken.posted).toEqual([{ type: 'reveal', index: 0 }]);
  });

  it('shows the values of a result set as text, the statement above it on one line, and a banner for a cut result', () => {
    const state = { value: undefined as unknown };
    const { body, page } = played(real.events.length, true, state);
    expect(page().table()).toEqual(
      real.preview.rows.map((row) => row.map((value) => (value === null ? 'NULL' : String(value)))),
    );
    expect(page().table()[0]).toEqual([
      '1',
      '9007199254740993',
      '1.50',
      '{"name":"a","tags":["x"]}',
      '[{"key":"k","value":1}]',
      'one',
    ]);
    expect(page().cell(1, 1).hasClass('null')).toBe(true);
    expect(page().cell(0, 2).hasClass('num')).toBe(true);
    expect(look(body).header?.textContent).toBe('SELECT * FROM t ORDER BY id');
    expect(look(body).banner).toBeUndefined();
    expect(state.value).toBeUndefined();

    look(body).tab(2).fire('click');
    expect(look(body).header?.textContent).toBe(HOSTILE_SQL);
    expect(look(body).header?.children).toEqual([]);
    expect(page().sorter(`<i>${HOSTILE}</i>`).textContent).toBe(`<i>${HOSTILE}</i>VARCHAR`);
    expect(page().table()).toEqual([['<b>x</b>']]);
    expect(bundle).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);

    look(body).tab(3).fire('click');
    expect(look(body).banner).toBeDefined();

    const multi = start();
    const sql = 'SELECT a,\n\t b\r\nFROM t';
    playOne(multi, sql, 'a', 1);
    expect(look(multi.body).header?.textContent).toBe('SELECT a, b FROM t');
    expect(look(multi.body).header?.title).toBe(sql);
  });

  it('sorts, filters, copies and exports a result like the preview grid, keeps each grid apart and its sort over new events', () => {
    const { body, page, type, advance, posted } = played();
    page().sorter('id').fire('click');
    page().sorter('id').fire('click');
    expect(column(page(), 0)).toEqual(['3', '2', '1']);
    type(5, 'src');
    advance(150);
    expect(column(page(), 0)).toEqual(['3']);
    type(5, '');
    advance(150);
    posted.length = 0;
    page().button('Export CSV').fire('click');
    page().tbody.fire('click', { target: page().cell(0, 2) });
    page().button('Copy cell').fire('click');
    expect(look(body).selected).toBe(1);
    expect(posted).toEqual([
      {
        type: 'export',
        suggestedName: 'result-1.csv',
        csv:
          'id,big,amount,customer,attrs,note\r\n' +
          `3,3,3.00,"{""name"":""c"",""tags"":[]}",[],${HOSTILE}\r\n` +
          '2,,2.50,,,\r\n' +
          '1,9007199254740993,1.50,"{""name"":""a"",""tags"":[""x""]}","[{""key"":""k"",""value"":1}]",one\r\n',
      },
      { type: 'copy', text: '3.00', what: 'cell' },
    ]);

    look(body).tab(3).fire('click');
    page().sorter('i').fire('click');
    page().sorter('i').fire('click');
    expect(column(page(), 0)).toEqual(['9', '8', '7', '6', '5', '4', '3', '2', '1', '0']);
    look(body).tab(1).fire('click');
    expect(column(page(), 0)).toEqual(['3', '2', '1']);

    const shared = { value: undefined as unknown };
    const live = played(7, false, shared);
    look(live.body).tab(1).fire('click');
    live.page().sorter('id').fire('click');
    live.page().sorter('id').fire('click');
    const grid = live.page().tbody;
    const before = grid.replacements;
    for (const event of real.events.slice(7)) live.send({ type: 'results-event', event });
    expect(look(live.body).tabs).toHaveLength(4);
    expect(look(live.body).selected).toBe(1);
    expect(live.page().tbody).toBe(grid);
    expect(grid.replacements).toBe(before);
    expect(column(live.page(), 0)).toEqual(['3', '2', '1']);
    expect(shared.value).toBeUndefined();
  });

  it('moves between the tabs with the arrow keys (wrapping around, like the report tabs), Home and End, and has one tab stop', () => {
    const { body } = played();
    const keydown = (key: string): boolean => {
      const prevented: boolean[] = [];
      look(body)
        .app.find((node) => node.hasClass('tabs'))[0]
        ?.fire('keydown', { key, preventDefault: () => prevented.push(true) });
      return prevented.length > 0;
    };
    const stops = () =>
      look(body)
        .app.find((node) => node.hasClass('tab'))
        .map((tab) => tab.tabIndex);

    expect(look(body).selected).toBe(1);
    expect(stops()).toEqual([-1, 0, -1, -1]);
    expect(keydown('ArrowRight')).toBe(true);
    expect(look(body).selected).toBe(2);
    expect(FakeNode.active).toBe(look(body).tab(2));
    keydown('End');
    expect(look(body).selected).toBe(3);
    keydown('ArrowRight');
    expect(look(body).selected).toBe(0);
    keydown('End');
    keydown('Home');
    expect(look(body).selected).toBe(0);
    keydown('ArrowLeft');
    expect(look(body).selected).toBe(3);
    keydown('Home');
    expect(stops()).toEqual([0, -1, -1, -1]);
    expect(keydown('x')).toBe(false);
  });

  it('ignores an invalid message and an event before a run began, and shows only the results of the new run', () => {
    const { body, send, posted } = start();
    send({ type: 'results-event', event: real.events[0] } as ResultsMessage);
    send({ type: 'results-event', event: { kind: 'oops', index: 0 } } as unknown as ResultsMessage);
    send({ type: 'results-end', summary: { cancelled: 'no' } } as unknown as ResultsMessage);
    send({ type: 'results-begin' } as unknown as ResultsMessage);
    expect(look(body).tabs).toEqual([]);
    expect(posted).toEqual([{ type: 'ready' }]);

    const page = played();
    look(page.body).tab(2).fire('click');
    expect(page.page().table()).toEqual([['<b>x</b>']]);
    playOne(page, 'SELECT 7', '7', 7);
    expect(look(page.body).tabs).toHaveLength(2);
    expect(look(page.body).selected).toBe(1);
    expect(page.page().table()).toEqual([['7']]);
    expect(look(page.body).header?.textContent).toBe('SELECT 7');
  });

  it('shows after a reload what a live page showed: the state of the whole run builds the same page', () => {
    const live = played();
    const reloaded = start();
    reloaded.send(statePage(real, END));

    expect(snapshot(reloaded)).toEqual(snapshot(live));
    for (const index of [0, 2, 3]) {
      look(live.body).tab(index).fire('click');
      look(reloaded.body).tab(index).fire('click');
      expect(snapshot(reloaded)).toEqual(snapshot(live));
    }
  });
});

/** The message that a page gets after a reload: the state that the extension reducer holds. */
function statePage(real: RealRun, end: ResultsRunSummary): ResultsMessage {
  let state: ResultsRunState | undefined;
  const messages: ResultsMessage[] = [
    { type: 'results-begin', script: real.script },
    ...real.events.map((event): ResultsMessage => ({ type: 'results-event', event })),
    { type: 'results-end', summary: end },
  ];
  for (const message of messages) {
    state = applyMessage(state, message);
  }
  return { type: 'results-state', state: state as ResultsRunState };
}
