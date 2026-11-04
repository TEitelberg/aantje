import { describe, expect, it } from 'vitest';
import { actionGuard } from '../../src/shell/protocol';
import { MAX_REQUESTS_PER_WINDOW, ReportPanels, REQUEST_WINDOW_MS } from '../../src/shell/panels';
import type { ReportKind } from '../../src/shell/panels';
import { FakePanel } from './fake-panel';

/**
 * The panels of the reports with a stand-in for the webview panel: what the extension sends when, which request of
 * a page it acts on, and which it ignores. The VS Code side (`host.vscode.ts`) is covered by the tests in the
 * extension host (test/integration/report-shell.test.ts).
 */

interface Data {
  readonly text: string;
}
interface View {
  readonly filter: string;
}

type OpenAction = { type: 'action'; action: 'open' };
const isAction: (value: unknown) => value is OpenAction = actionGuard({ open: {} });
const kind: ReportKind<Data, OpenAction, View> = {
  viewType: 'test.report',
  css: '',
  message: (data) => ({ type: 'test', data }),
  isAction,
  isView: (value): value is View =>
    typeof value === 'object' && value !== null && typeof (value as { filter?: unknown }).filter === 'string',
  toMarkdown: (data, view) => `# ${data.text}${view ? ` [${view.filter}]` : ''}`,
};

function setup() {
  const panels: FakePanel[] = [];
  const created: { viewType: string; title: string }[] = [];
  const documents: string[] = [];
  const refreshed: string[] = [];
  const actions: { key: string; data: Data }[] = [];
  const closed: string[] = [];
  const shown = new ReportPanels(
    (panelKind, title) => {
      created.push({ viewType: panelKind.viewType, title });
      const panel = new FakePanel(title);
      panels.push(panel);
      return panel;
    },
    kind,
    {
      onRefresh: (key) => refreshed.push(key),
      onClose: (key) => closed.push(key),
      onAction: (_action, data, key) => actions.push({ key, data }),
      openMarkdown: (markdown) => documents.push(markdown),
    },
  );
  return { shown, panels, created, documents, refreshed, actions, closed };
}

describe('the panels of a report', () => {
  it('sends the data only when the page is ready, keeps the newest, and sends it again to a rebuilt page', () => {
    const { shown, panels, created } = setup();
    shown.show('a', 'First', { text: 'one' });
    expect(created).toEqual([{ viewType: 'test.report', title: 'First' }]);
    shown.show('a', 'First', { text: 'newer' });
    expect(panels[0]?.posted).toEqual([]);

    panels[0]?.pageReloaded();
    panels[0]?.pageReloaded();
    expect(panels[0]?.posted).toEqual([
      { type: 'test', data: { text: 'newer' } },
      { type: 'test', data: { text: 'newer' } },
    ]);

    shown.show('a', 'Second', { text: 'two' });
    expect(panels).toHaveLength(1);
    expect(panels[0]?.title).toBe('Second');
    expect(panels[0]?.revealed).toBe(2);
    expect(panels[0]?.posted.at(-1)).toEqual({ type: 'test', data: { text: 'two' } });
  });

  it('opens a panel of its own for another key, a new one after the user closed the old, and disposes all', () => {
    const { shown, panels } = setup();
    shown.show('a', 'A', { text: 'one' });
    shown.show('b', 'B', { text: 'two' });
    panels.forEach((panel) => panel.pageReloaded());
    expect(panels.map((panel) => panel.posted)).toEqual([
      [{ type: 'test', data: { text: 'one' } }],
      [{ type: 'test', data: { text: 'two' } }],
    ]);

    panels[0]?.dispose();
    shown.show('a', 'A', { text: 'again' });
    expect(panels).toHaveLength(3);
    expect(panels[2]?.revealed).toBe(0);

    shown.dispose();
    expect(panels.map((panel) => panel.disposed)).toEqual([true, true, true]);
    shown.show('a', 'A', { text: 'after' });
    expect(panels).toHaveLength(4);
  });
});

describe('what the page may ask for', () => {
  it('refreshes with the key of the panel, opens Markdown from the held data, and passes actions on with it', () => {
    const { shown, panels, refreshed, documents, actions } = setup();
    shown.show('lake', 'A', { text: 'one' });
    shown.show('other', 'B', { text: 'two' });
    panels[1]?.send({ type: 'refresh' });
    expect(refreshed).toEqual(['other']);

    panels[0]?.send({ type: 'markdown' });
    panels[0]?.send({ type: 'markdown', view: { filter: 'x' } });
    shown.show('lake', 'A', { text: 'newer' });
    panels[0]?.send({ type: 'markdown' });
    expect(documents).toEqual(['# one', '# one [x]', '# newer']);

    panels[0]?.send({ type: 'action', action: 'open' });
    expect(actions).toEqual([{ key: 'lake', data: { text: 'newer' } }]);
  });

  it('ignores a request of the wrong shape, text from the page, and a view from the prototype', () => {
    const { shown, panels, actions, refreshed, documents } = setup();
    shown.show('a', 'A', { text: 'one' });
    const ignored: unknown[] = [
      { type: 'action', action: 'quit' },
      { type: 'action', action: 'open', command: 'workbench.action.quit' },
      { type: 'ready', extra: 1 },
      { type: 'refresh', key: 'b' },
      'refresh',
      null,
      undefined,
      [],
      { type: 'markdown', view: { filter: 7 } },
      { type: 'markdown', view: 'x' },
      { type: 'markdown', markdown: '# my own text' },
      { type: 'markdown', text: '# my own text', view: { filter: 'x' } },
    ];
    for (const message of ignored) {
      panels[0]?.send(message);
    }
    expect([actions, refreshed, documents, panels[0]?.posted]).toEqual([[], [], [], []]);
    panels[0]?.send(
      Object.assign(Object.create({ view: { filter: 'inherited' } }) as object, { type: 'markdown' }),
    );
    expect(documents).toEqual(['# one']);
  });

  it('takes no action and no view for a kind that has neither, and does nothing without a handler', () => {
    const panels: FakePanel[] = [];
    const documents: string[] = [];
    const actions: string[] = [];
    const refreshed: string[] = [];
    const bare: ReportKind<Data, never, never> = {
      viewType: 'test.bare',
      css: '',
      message: (data) => ({ type: 'bare', data }),
      toMarkdown: (data, view) => `# ${data.text}${view === undefined ? '' : ' with a view'}`,
    };
    const create = (_kind: unknown, title: string) => {
      const panel = new FakePanel(title);
      panels.push(panel);
      return panel;
    };
    const shown = new ReportPanels(create, bare, {
      openMarkdown: (markdown) => documents.push(markdown),
      onAction: (action) => actions.push(JSON.stringify(action)),
      onRefresh: (key) => refreshed.push(key),
    });
    shown.show('a', 'A', { text: 'one' });
    panels[0]?.send({ type: 'ready' });
    panels[0]?.send({ type: 'action', action: 'open' });
    panels[0]?.send({ type: 'markdown', view: { filter: 'x' } });
    panels[0]?.send({ type: 'markdown', view: {} });
    expect([actions, documents, panels[0]?.posted]).toEqual([
      [],
      [],
      [{ type: 'bare', data: { text: 'one' } }],
    ]);
    panels[0]?.send({ type: 'markdown' });
    panels[0]?.send({ type: 'refresh' });
    expect([documents, refreshed]).toEqual([['# one'], ['a']]);

    const quiet = new ReportPanels(create, kind, { openMarkdown: (markdown) => documents.push(markdown) });
    quiet.show('q', 'Q', { text: 'two' });
    panels[1]?.send({ type: 'refresh' });
    panels[1]?.send({ type: 'action', action: 'open' });
    panels[1]?.send({ type: 'markdown' });
    expect(documents).toEqual(['# one', '# two']);
  });
});

describe('a report that changes while the page is open', () => {
  it('posts the change to a ready page, holds the new data for a late one, and ignores a key without a panel', () => {
    const { shown, panels, documents } = setup();
    shown.show('a', 'A', { text: 'one' });
    panels[0]?.pageReloaded();
    shown.update('a', { text: 'two' }, { type: 'test-change', add: 'x' });
    expect(panels[0]?.posted).toEqual([
      { type: 'test', data: { text: 'one' } },
      { type: 'test-change', add: 'x' },
    ]);
    panels[0]?.send({ type: 'markdown' });
    expect(documents).toEqual(['# two']);

    shown.show('b', 'B', { text: 'one' });
    shown.update('b', { text: 'two' }, { type: 'test-change' });
    expect(panels[1]?.posted).toEqual([]);
    panels[1]?.pageReloaded();
    expect(panels[1]?.posted).toEqual([{ type: 'test', data: { text: 'two' } }]);

    shown.update('missing', { text: 'two' }, { type: 'test-change' });
    expect(panels).toHaveLength(2);
  });
});

/** A read that the test settles when it wants, and that fails with an abort error when its signal fires. */
function pendingRead<T>() {
  let settle: (value: T) => void = () => undefined;
  let signal: AbortSignal | undefined;
  const read = (given: AbortSignal): Promise<T> => {
    signal = given;
    return new Promise<T>((resolve, reject) => {
      settle = resolve;
      given.addEventListener('abort', () => reject(new Error('aborted')));
    });
  };
  return { read, settle: (value: T) => settle(value), aborted: () => signal?.aborted };
}

describe('reading the data of a panel', () => {
  it('gives nothing for a read of a panel the user closed meanwhile, so the panel stays closed', async () => {
    const { shown, panels, created } = setup();
    expect(await shown.read('x', () => Promise.resolve({ text: 'one' }))).toEqual({ text: 'one' });
    shown.show('a', 'A', { text: 'one' });
    const refresh = pendingRead<Data>();
    const result = shown.read('a', refresh.read);
    panels[0]?.dispose();
    refresh.settle({ text: 'two' });
    expect(await result).toBeUndefined();
    expect(refresh.aborted()).toBe(true);
    expect(created).toHaveLength(1);

    shown.show('b', 'B', { text: 'one' });
    let finish: (value: Data) => void = () => undefined;
    const late = shown.read('b', () => new Promise<Data>((resolve) => (finish = resolve)));
    panels[1]?.dispose();
    finish({ text: 'late' });
    expect(await late).toBeUndefined();
  });

  it('gives nothing for the older of two reads of a key, keeps keys apart, and lets a failing read fail', async () => {
    const { shown, panels } = setup();
    const older = pendingRead<Data>();
    const newer = pendingRead<Data>();
    const first = shown.read('a', older.read);
    const second = shown.read('a', newer.read);
    newer.settle({ text: 'newer' });
    older.settle({ text: 'older' });
    expect(await second).toEqual({ text: 'newer' });
    expect(await first).toBeUndefined();
    expect(older.aborted()).toBe(true);
    expect(newer.aborted()).toBe(false);

    const a = pendingRead<Data>();
    const b = pendingRead<Data>();
    const readA = shown.read('a', a.read);
    const readB = shown.read('b', b.read);
    a.settle({ text: 'a' });
    b.settle({ text: 'b' });
    expect([await readA, await readB]).toEqual([{ text: 'a' }, { text: 'b' }]);
    expect([a.aborted(), b.aborted()]).toEqual([false, false]);

    await expect(shown.read('a', () => Promise.reject(new Error('catalog gone')))).rejects.toThrow(
      'catalog gone',
    );

    shown.show('c', 'C', { text: 'two' });
    const read = pendingRead<Data>();
    const result = shown.read('a', read.read);
    panels[0]?.dispose();
    read.settle({ text: 'one' });
    expect(await result).toEqual({ text: 'one' });
  });
});

describe('closing a panel', () => {
  it('tells the report which panel the user closed, and every panel when the extension disposes them', () => {
    const { shown, panels, closed } = setup();
    shown.show('a', 'A', { text: 'one' });
    shown.show('b', 'B', { text: 'two' });
    panels[1]?.dispose();
    expect(closed).toEqual(['b']);
    shown.dispose();
    expect(closed.toSorted()).toEqual(['a', 'b']);
  });
});

describe('a page that floods the host with requests', () => {
  function flooded() {
    let clock = 0;
    const refreshed: string[] = [];
    const actions: string[] = [];
    const documents: string[] = [];
    const panel = new FakePanel('flood');
    const shown = new ReportPanels(
      () => panel,
      kind,
      {
        onRefresh: (key) => refreshed.push(key),
        onAction: (_action, _data, key) => actions.push(key),
        openMarkdown: (markdown) => documents.push(markdown),
      },
      () => clock,
    );
    shown.show('a', 'Flood', { text: 'one' });
    panel.send({ type: 'ready' });
    return {
      panel,
      refreshed,
      actions,
      documents,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it('gets the first requests of each second of any kind, `ready` is never counted, and the next second is served', () => {
    const { panel, refreshed, actions, documents, advance } = flooded();
    for (let i = 0; i < 50; i++) {
      panel.send({ type: 'refresh' });
      panel.send({ type: 'ready' });
    }
    for (let i = 0; i < 50; i++) {
      panel.send({ type: 'action', action: 'open' });
      panel.send({ type: 'markdown' });
    }
    expect(refreshed).toHaveLength(MAX_REQUESTS_PER_WINDOW);
    expect(actions).toHaveLength(0);
    expect(documents).toHaveLength(0);

    advance(REQUEST_WINDOW_MS);
    panel.send({ type: 'refresh' });
    expect(refreshed).toHaveLength(MAX_REQUESTS_PER_WINDOW + 1);
  });

  it('serves an honest user: a click every 100 ms is never dropped', () => {
    const { panel, refreshed, advance } = flooded();
    for (let i = 0; i < 100; i++) {
      panel.send({ type: 'refresh' });
      advance(100);
    }
    expect(refreshed).toHaveLength(100);
  });
});
