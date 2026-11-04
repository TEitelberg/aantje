import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DependenciesData } from '../../src/dependencies/model';
import { lakeData, objectData, readGraph } from '../../src/dependencies/read';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID } from '../support/expected-history';
import { FakeNode } from '../support/fake-dom';
import { buildClientBundle, startPage } from '../support/page-harness';
import { historyFixture } from '../support/sources/history';
import { SHOP, addMacro, addView, sharedParser } from './dependencies-support';

/**
 * Runs the real browser bundle against a stand-in for the DOM: the Dependencies page shows the lists the extension's
 * data gives, the direction and the depth change them, the actions leave the page as the requests the extension
 * accepts, and the choices survive a hidden panel.
 */

const catalogs = editedCatalogs();
const parser = sharedParser();
let bundle: string;
let events: DependenciesData;
let lake: DependenciesData;

const HOSTILE = '<img src=x onerror=alert(1)> & "q"';

beforeAll(async () => {
  bundle = await buildClientBundle();
  const graph = await readGraph(
    await catalogs.open(
      historyFixture.sqlite,
      addView(100, SHOP, 'chain_top', `SELECT * FROM ${'"'}${HOSTILE.replaceAll('"', '""')}${'"'}`),
      addView(101, SHOP, HOSTILE, 'SELECT * FROM big_events'),
      addView(102, SHOP, 'v_gone', 'SELECT * FROM events, old_stuff'),
      addView(103, SHOP, 'v_spark', 'SELECT 1', 'spark'),
      ...addMacro(104, SHOP, 'uses_gross', 'scalar', '(shop.gross(x))'),
    ),
    parser,
    56,
  );
  const data = objectData(graph, 'History', 56, { kind: 'table', id: HISTORY_ID.events });
  if (!data) {
    throw new Error('The table is there.');
  }
  events = data;
  lake = lakeData(graph, 'History', 56);
});
afterAll(async () => {
  await catalogs.dispose();
  await parser.dispose();
});

const message = (data: DependenciesData) => ({ type: 'dependencies', data });

function start(saved?: unknown) {
  const page = startPage(bundle, saved);
  const find = (predicate: (node: FakeNode) => boolean) => page.app().find(predicate);
  const byClass = (name: string) => find((node) => node.hasClass(name));
  const rowsOf = (node: FakeNode | undefined) =>
    node?.byTag('tbody')[0]?.children.map((row) => row.children.map((cell) => cell.textContent)) ?? [];
  const view = {
    h1: () => find((node) => node.tag === 'h1')[0]?.textContent,
    /** The buttons of the list of objects, with their label. */
    items: () => byClass('objects')[0]?.byTag('button') ?? [],
    labels: () => view.items().map((button) => button.textContent),
    indents: () => view.items().map((button) => button.style['paddingLeft']),
    selected: () =>
      view
        .items()
        .filter((button) => button.getAttribute('aria-selected') === 'true')
        .map((button) => button.textContent),
    impact: () => byClass('impact')[0],
    detail: () => byClass('detail')[0],
    issues: () => byClass('issues')[0],
    broken: () => rowsOf(view.issues()?.byTag('table')[0]),
    button: (label: string, within?: FakeNode) =>
      (within ?? page.app()).find((node) => node.tag === 'button' && node.textContent === label)[0],
    mode: (label: string) => find((node) => node.hasClass('mode') && node.textContent === label)[0],
    pressed: (label: string) => view.mode(label)?.getAttribute('aria-pressed'),
    search: () => find((node) => node.tag === 'input' && node.type === 'search')[0] as FakeNode,
    type: (text: string) => {
      view.search().value = text;
      view.search().fire('input');
    },
  };
  return { ...page, view };
}

describe('the Dependencies page of an object', () => {
  it('tells the extension that it is ready, lists who uses the table level by level, and shows hostile names as text', () => {
    const { posted, app, send, view } = start();
    expect(posted).toEqual([{ type: 'ready' }]);
    expect(app().textContent).toBe('Reading...');

    send(message(events));
    expect(view.h1()).toContain('shop.events');
    expect(view.items()).toHaveLength(5);
    expect(view.indents()).toEqual(['8px', '28px', '48px', '8px', '8px']);
    expect(view.items()[1]?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(view.broken()).toEqual([['shop.v_gone', 'shop.old_stuff', 'table or view']]);

    // A page that cannot read its data says so instead of reading for ever.
    const broken = start();
    broken.send(message({ ...events, edges: [{ from: 0, to: 99, kind: 'reads' }] }));
    expect(broken.app().textContent).not.toBe('Reading...');
    expect(broken.view.h1()).toBeUndefined();
  });

  it('switches to what the table depends on and to fewer levels, and marks what is pressed', () => {
    const { send, view } = start();
    send(message(events));
    view.mode('Depends on')?.fire('click');
    expect(view.items()).toHaveLength(0);
    expect(view.pressed('Depends on')).toBe('true');
    expect(view.pressed('Used by')).toBe('false');
    view.mode('Used by')?.fire('click');
    view.mode('Depth 1')?.fire('click');
    expect(view.items()).toHaveLength(3);
    expect(view.pressed('Depth 1')).toBe('true');
    expect(view.pressed('Depth 5')).toBe('false');
  });

  it('says what a drop would break, and posts the actions of the table and of the picked object with their node', () => {
    const { send, view, posted } = start();
    send(message(events));
    const impact = view.impact();
    expect(impact?.byTag('li').map((item) => item.textContent)).toEqual([
      `shop.${HOSTILE}`,
      'shop.big_events',
      'shop.chain_top',
      'shop.recent_events',
      'shop.v_gone',
    ]);
    posted.length = 0;
    view.button('Open Script as DROP', impact)?.fire('click');
    expect(posted).toEqual([{ type: 'action', action: 'scriptDrop', node: events.target }]);

    view.items()[0]?.fire('click');
    expect(view.selected()).toHaveLength(1);
    expect(view.selected()[0]).toContain('shop.big_events');
    const node = events.nodes.findIndex((candidate) => candidate.name === 'big_events');
    for (const [label, action] of [
      ['Show in tree', 'showInTree'],
      ['Dependencies', 'showDependencies'],
      ['Script as CREATE', 'scriptCreate'],
      ['Script as ALTER', 'scriptAlter'],
      ['Script as DROP', 'scriptDrop'],
    ]) {
      view.button(label ?? '', view.detail())?.fire('click');
      expect(posted.at(-1)).toEqual({ type: 'action', action, node });
    }
  });

  it('moves between the objects of the list with the arrow keys, Home and End, and has one stop in the tab order', () => {
    const { send, view } = start();
    send(message(events));
    const items = view.items();
    expect(items.map((button) => button.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    items[0]?.fire('keydown', { key: 'ArrowDown' });
    expect(FakeNode.active).toBe(items[1]);
    items[1]?.fire('keydown', { key: 'End' });
    expect(FakeNode.active).toBe(items[4]);
    items[4]?.fire('keydown', { key: 'Home' });
    expect(FakeNode.active).toBe(items[0]);
    expect(view.items().map((button) => button.tabIndex)).toEqual([0, -1, -1, -1, -1]);
  });

  it('keeps the direction, the depth, the selection and the filter when the panel is hidden, and falls back when the object is gone', () => {
    const first = start();
    first.send(message(events));
    first.view.mode('Depends on')?.fire('click');
    first.view.mode('Depth 2')?.fire('click');
    first.view.mode('Used by')?.fire('click');
    first.view.items()[1]?.fire('click');
    const saved = first.saved();

    const second = start(saved);
    second.send(message(events));
    expect(second.view.pressed('Depth 2')).toBe('true');
    expect(second.view.selected()).toHaveLength(1);
    expect(second.view.selected()[0]).toContain('reads shop.big_events');
    first.send(message(events));
    expect(first.view.pressed('Depth 2')).toBe('true');

    const direction = start();
    direction.send(message(events));
    direction.view.mode('Depends on')?.fire('click');
    const restored = start(direction.saved());
    restored.send(message(events));
    expect(restored.view.pressed('Depends on')).toBe('true');

    const gone = start({ ...(saved as Record<string, unknown>), selected: 'view:99999' });
    gone.send(message(events));
    expect(gone.view.detail()?.byTag('h2')[0]?.textContent).toContain('shop.events');
  });

  it('opens the Markdown document with the direction and the depth that are set', () => {
    const { send, view, posted } = start();
    send(message(events));
    view.mode('Depends on')?.fire('click');
    view.mode('Depth 3')?.fire('click');
    view.button('Open as Markdown')?.fire('click');
    expect(posted.at(-1)).toEqual({
      type: 'markdown',
      view: { direction: 'dependsOn', depth: 3, text: '' },
    });
  });
});

describe('the Dependencies page of the lake', () => {
  it('lists the objects that most others use first, filters them, and shows the neighbours of the picked one', () => {
    const { send, view, posted } = start();
    send(message(lake));
    expect(view.labels()[0]).toContain('shop.events');
    expect(view.broken()).toEqual([['shop.v_gone', 'shop.old_stuff', 'table or view']]);

    view.type('GROSS');
    expect(view.labels()).toHaveLength(2);
    view.type('nothing like it');
    expect(view.items()).toHaveLength(0);

    view.type('gross');
    view.items()[0]?.fire('click');
    const detail = view.detail();
    expect(detail?.byTag('li').map((node) => node.textContent)).toEqual(['ƒ shop.uses_gross']);
    posted.length = 0;
    view.button('Dependencies', detail)?.fire('click');
    expect(posted).toEqual([
      {
        type: 'action',
        action: 'showDependencies',
        node: lake.nodes.findIndex(({ name }) => name === 'gross'),
      },
    ]);
    view.button('Open as Markdown')?.fire('click');
    expect(posted.at(-1)).toEqual({
      type: 'markdown',
      view: { direction: 'usedBy', depth: 5, text: 'gross' },
    });

    const restored = start(
      (() => {
        const kept = start();
        kept.send(message(lake));
        kept.view.type('gross');
        return kept.saved();
      })(),
    );
    restored.send(message(lake));
    expect(restored.view.search().value).toBe('gross');
    expect(restored.view.labels()).toHaveLength(2);
  });

  it('offers the statistics for a table only, and the other actions for every object', () => {
    const { send, view } = start();
    send(message(lake));
    const buttonsOf = (name: string): string[] => {
      view.type(name);
      view.items()[0]?.fire('click');
      return (
        view
          .detail()
          ?.byTag('button')
          .map((button) => button.textContent) ?? []
      );
    };
    expect(buttonsOf('shop.gross')).not.toContain('Statistics');
    expect(buttonsOf('shop.big_events')).not.toContain('Statistics');
    expect(buttonsOf('shop.events')).toContain('Statistics');
  });
});

describe('what the page cuts', () => {
  /** The report of object 0, which `users` views read, and `issues` broken references of the first of them. */
  const wide = (users: number, issues = 0): DependenciesData => ({
    connection: 'C',
    scope: { kind: 'lake' },
    snapshot: 1,
    target: 0,
    isolated: 0,
    objects: users,
    parsed: users,
    nodes: Array.from({ length: users + 1 }, (_, id) => ({
      kind: id === 0 ? ('table' as const) : ('view' as const),
      id,
      schemaId: 1,
      schema: 's',
      name: `v${String(id).padStart(3, '0')}`,
    })),
    edges: Array.from({ length: users }, (_, index) => ({ from: index + 1, to: 0, kind: 'reads' as const })),
    broken: Array.from({ length: issues }, (_, index) => ({
      from: 1,
      kind: 'relation' as const,
      schema: 's',
      name: `gone${index}`,
    })),
    unresolved: [],
  });

  it('names at most 30 neighbours of the picked object and lists at most 100 broken references', () => {
    for (const users of [30, 31]) {
      const { send, view } = start();
      send(message({ ...wide(users), target: null }));
      view.items()[0]?.fire('click');
      const detail = view.detail();
      expect(detail?.byTag('li'), `${users} neighbours`).toHaveLength(Math.min(users, 30));
      expect(detail?.textContent.includes('1 more'), `${users} neighbours`).toBe(users > 30);
    }
    for (const issues of [100, 101]) {
      const { send, view } = start();
      send(message(wide(2, issues)));
      expect(view.broken(), `${issues} broken`).toHaveLength(Math.min(issues, 100));
    }
  });
});
