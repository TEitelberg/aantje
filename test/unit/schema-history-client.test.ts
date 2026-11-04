import { beforeAll, describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../../src/catalog/model';
import { buildHistory } from '../../src/schema-history/model';
import type { SchemaHistoryData } from '../../src/schema-history/model';
import { HISTORY_ID } from '../support/expected-history';
import { FakeNode } from '../support/fake-dom';
import { buildClientBundle, startPage } from '../support/page-harness';
import { TIME, historySchema } from './schema-history-support';

/**
 * Runs the real browser bundle against a stand-in for the DOM: the Schema History page shows the matrix that the
 * extension sends, the filters change what is drawn, a click on a cell or a snapshot selects it and shows what it
 * changed, the actions leave the page as the requests that the extension accepts, and the choices survive a hidden
 * panel. The page of the report is chosen by the first message.
 */

let bundle: string;
let evolved: SchemaHistoryData;
let dropped: SchemaHistoryData;

beforeAll(async () => {
  bundle = await buildClientBundle();
  evolved = await historySchema(HISTORY_ID.evolving);
  dropped = await historySchema(HISTORY_ID.oldStuff);
});

const message = (data: SchemaHistoryData) => ({ type: 'schemaHistory', data });

function start(saved?: unknown) {
  const page = startPage(bundle, saved);
  const find = (predicate: (node: FakeNode) => boolean) => page.app().find(predicate);
  const byClass = (name: string) => find((node) => node.hasClass(name));
  const rowOf = (row: FakeNode) =>
    row.children.map((cell) =>
      cell.byTag('button').length > 0 && !cell.hasClass('name') && cell.tag === 'td'
        ? cell.byTag('button').map((button) => button.textContent)
        : cell.textContent,
    );
  const view = {
    h1: () => find((node) => node.tag === 'h1')[0]?.textContent,
    subtitle: () => byClass('subtitle')[0]?.textContent,
    headings: () =>
      find((node) => node.tag === 'thead')[0]?.children[0]?.children.map((cell) => cell.textContent),
    pickers: () => byClass('pick').map((button) => button.textContent),
    headingsSelected: () =>
      find((node) => node.tag === 'th' && node.hasClass('selected')).map(
        (heading) => heading.byTag('button')[0]?.textContent,
      ),
    events: () =>
      find((node) => node.tag === 'thead')[0]?.children[1]?.children.map((cell) => cell.textContent),
    rows: () => find((node) => node.tag === 'tbody')[0]?.children.map(rowOf) ?? [],
    names: () =>
      byClass('name')
        .filter((node) => node.tag === 'td')
        .map((node) => node.textContent),
    cells: () => byClass('cell'),
    cell: (text: string, column?: string) =>
      view
        .cells()
        .find(
          (button) =>
            button.textContent === text &&
            (column === undefined || (button.getAttribute('aria-label') ?? '').startsWith(`${column},`)),
        ),
    button: (label: string) => find((node) => node.tag === 'button' && node.textContent === label)[0],
    buttons: () => find((node) => node.tag === 'button').map((button) => button.textContent),
    kind: (label: string) =>
      byClass('check').find((node) => node.textContent === label)?.children[0] as FakeNode,
    search: () => find((node) => node.tag === 'input' && node.type === 'search')[0] as FakeNode,
    range: (end: 'From' | 'To') =>
      byClass('range')
        .find((node) => node.textContent.startsWith(`${end} @`))
        ?.byTag('input')[0] as FakeNode,
    detail: () => byClass('detail')[0],
    notes: () => byClass('note').map((node) => node.textContent),
    empty: () => byClass('empty').map((node) => node.textContent),
    toggle: (label: string, on: boolean) => {
      const box = view.kind(label);
      box.checked = on;
      box.fire('change');
    },
    type: (text: string) => {
      view.search().value = text;
      view.search().fire('input');
    },
    setRange: (end: 'From' | 'To', value: string) => {
      view.range(end).value = value;
      view.range(end).fire('change');
    },
  };
  return { ...page, view };
}

describe('the Schema History page', () => {
  it('tells the extension that it is ready, shows the matrix of main.evolved, and ignores data it cannot show', () => {
    const { posted, app, send, view } = start();
    expect(posted).toEqual([{ type: 'ready' }]);
    expect(app().textContent).toBe('Reading...');

    send(message(evolved));
    expect(view.pickers()).toEqual(['@26', '@28', '@29', '@30', '@31', '@32', '@33', '@34', '@35']);
    expect(view.names()).toEqual([
      'id',
      'title (formerly name)',
      'info',
      'a',
      'b',
      'c',
      'n',
      'flag',
      'extra',
    ]);
    expect(view.rows()[1]?.slice(0, 3)).toEqual(['title (formerly name)', 'varchar', ['+ added: varchar']]);
    expect(view.cells()).toHaveLength(
      evolved.columns.reduce((total, column) => total + column.cells.length, 0),
    );
    const nameCell = (text: string) =>
      app()
        .byClass('name')
        .find((node) => node.tag === 'td' && node.textContent === text);
    expect(nameCell('c')?.style.paddingLeft).toBe('26px');
    expect(nameCell('id')?.style.paddingLeft).toBe('10px');

    send({ type: 'properties', data: null });
    send({ type: 'schemaHistory', data: null });
    expect(view.names()).toHaveLength(9);

    const broken = start();
    broken.send({ type: 'schemaHistory', data: { connection: 'x' } });
    expect(broken.app().textContent).not.toBe('Reading...');
    expect(broken.view.h1()).toBeUndefined();
  });

  it('filters by kind of change, by name while the user types, and by a range kept inside the snapshots that were read', () => {
    const { send, view } = start();
    send(message(evolved));

    view.type('name');
    expect(view.names()).toEqual(['title (formerly name)']);
    view.type('zzz');
    expect(view.names()).toEqual([]);
    expect(view.pickers()).toEqual(['@26', '@35']);
    view.type('');
    expect(view.names()).toHaveLength(9);

    view.setRange('From', '29');
    view.setRange('To', '30');
    expect(view.pickers()).toEqual(['@29', '@30']);
    expect(view.names()).toEqual(['title (formerly name)', 'n']);
    view.setRange('To', '99');
    expect(view.range('To').value).toBe('35');
    view.setRange('From', '0');
    view.setRange('From', 'abc');
    view.setRange('From', '');
    expect(view.range('From').value).toBe('26');
    expect(view.pickers()).toHaveLength(9);
    for (const label of [
      'Added',
      'Dropped',
      'Renamed',
      'Nullability changed',
      'Default changed',
      'Comment changed',
      'Moved',
    ]) {
      view.toggle(label, false);
    }
    expect(view.names()).toEqual(['n']);
    expect(view.pickers()).toEqual(['@26', '@30', '@35']);
    view.toggle('Type changed', false);
    expect(view.names()).toEqual([]);
    view.toggle('Type changed', true);
    view.toggle('Added', true);
    expect(view.names()).toHaveLength(9);
  });

  it('selects a cell or a snapshot on a click, shows what it changed, and posts the actions that apply', () => {
    const { send, view, posted } = start();
    send(message(evolved));

    const cell = view.cell('Δ type: int32 → int64');
    cell?.fire('click');
    expect(cell?.getAttribute('aria-pressed')).toBe('true');
    expect(view.cell('+ added: int32', 'n')?.getAttribute('aria-pressed')).toBe('false');
    const detail = view.detail();
    expect(detail?.byClass('changes')[0]?.children).toHaveLength(1);
    expect(detail?.byClass('selected')).toHaveLength(1);

    view.button('previous @29')?.fire('click');
    view.button('latest @56')?.fire('click');
    view.button('Show catalog at @30')?.fire('click');
    view.button('Query...')?.fire('click');
    view.button('Script as ALTER')?.fire('click');
    expect(posted.slice(1)).toEqual([
      { type: 'action', action: 'compareSchema', snapshot: 30, against: 'previous' },
      { type: 'action', action: 'compareSchema', snapshot: 30, against: 'latest' },
      { type: 'action', action: 'showCatalog', snapshot: 30 },
      { type: 'action', action: 'query', snapshot: 30 },
      { type: 'action', action: 'scriptAlter' },
    ]);

    view.button('@26')?.fire('click');
    expect(view.detail()?.byClass('changes')[0]?.children).toHaveLength(6);
    expect(view.detail()?.byClass('selected')).toEqual([]);
    expect(view.cells().every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true);
    // The creation has no previous version to compare with.
    expect(
      view
        .detail()
        ?.buttons()
        .some((button) => button.textContent.startsWith('previous')),
    ).toBe(false);

    const gone = start();
    gone.send(message(dropped));
    gone.view.button('@45')?.fire('click');
    expect(gone.view.detail()?.buttons()).toHaveLength(1);
    gone.view.button('@43')?.fire('click');
    expect(gone.view.detail()?.buttons()).toHaveLength(2);
  });

  it('asks for the document with the choices, refreshes keeping them and the focus, and follows a snapshot committed since', () => {
    const { send, view, posted } = start();
    send(message(evolved));
    view.toggle('Moved', false);
    view.type('n');
    view.setRange('From', '28');
    view.button('Open as Markdown')?.fire('click');
    view.button('Refresh')?.fire('click');
    expect(posted.slice(1)).toEqual([
      {
        type: 'markdown',
        view: {
          kinds: [
            'added',
            'removed',
            'renamed',
            'typeChanged',
            'nullableChanged',
            'defaultChanged',
            'commentChanged',
          ],
          text: 'n',
          range: { from: 28, to: 35 },
        },
      },
      { type: 'refresh' },
    ]);
    send(message(evolved));
    expect(view.search().value).toBe('n');
    expect(view.range('From').value).toBe('28');
    expect(view.kind('Moved').checked).toBe(false);
    expect(FakeNode.active?.textContent).toBe('Refresh');

    const later = start();
    later.send(message({ ...evolved, snapshots: evolved.snapshots.slice(0, -1) }));
    expect(later.view.range('To').value).toBe('34');
    later.view.toggle('Moved', false);
    later.send(message(evolved));
    expect(later.view.range('To').value).toBe('35');
    later.view.setRange('To', '34');
    later.send(message(evolved));
    expect(later.view.range('To').value).toBe('34');
    expect(later.view.pickers()).not.toContain('@35');
  });

  it('comes back with the choices after VS Code took the page down, for the same table of the same connection only', () => {
    const first = start();
    first.send(message(evolved));
    first.view.toggle('Added', false);
    first.view.type('flag');
    first.view.cell('= default: false → true')?.fire('click');
    const saved = first.saved();
    expect(saved).toMatchObject({
      connection: 'History',
      tableId: 12,
      text: 'flag',
      selected: 34,
      column: 9,
    });

    const back = start(saved);
    back.send(message(evolved));
    expect(back.view.search().value).toBe('flag');
    expect(back.view.kind('Added').checked).toBe(false);
    expect(back.view.names()).toEqual(['flag']);
    expect(back.view.cell('= default: false → true')?.getAttribute('aria-pressed')).toBe('true');

    const other = start(saved);
    other.send(message(dropped));
    expect(other.view.search().value).toBe('');
    const elsewhere = start(saved);
    elsewhere.send(message({ ...evolved, connection: 'Another lake' }));
    expect(elsewhere.view.search().value).toBe('');

    const stale = start({ ...(saved as object), selected: 99, column: 99 });
    stale.send(message(evolved));
    expect(stale.view.cells().every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true);

    const broken = start({ connection: 'History', tableId: 'twelve' });
    broken.send(message(evolved));
    expect(broken.view.names()).toHaveLength(9);

    const range = saved as { range: { from: number; to: number } };
    const outside = start({ ...range, range: { from: 5, to: 999 } });
    outside.send(message(evolved));
    expect([outside.view.range('From').value, outside.view.range('To').value]).toEqual(['26', '35']);
    const inside = start({ ...range, range: { from: 29, to: 999 } });
    inside.send(message(evolved));
    expect([inside.view.range('From').value, inside.view.range('To').value]).toEqual(['29', '35']);
  });

  it('draws at most 100 rows and lets the filter reach the others, and says so when nothing is recorded or matches', () => {
    const many: ColumnInfo[] = Array.from({ length: 130 }, (_, index) => ({
      id: index + 1,
      name: `c${index + 1}`,
      type: 'int32',
      nullable: true,
      defaultValue: null,
      comment: null,
      children: [],
    }));
    const wide = start();
    wide.send(
      message(
        buildHistory('Lake', 1, 9, {
          versions: [
            {
              snapshot: 1,
              time: TIME,
              author: null,
              commitMessage: null,
              table: { schemaName: 's', name: 't' },
              columns: many,
            },
          ],
          more: false,
        }),
      ),
    );
    expect(wide.view.names()).toHaveLength(100);
    wide.view.type('c130');
    expect(wide.view.names()).toEqual(['c130']);

    const none = start();
    none.send(message({ ...evolved, snapshots: [], columns: [] }));
    expect(none.view.empty()).toHaveLength(1);
    expect(none.view.search()).toBeUndefined();

    const filtered = start();
    filtered.send(message({ ...evolved, snapshots: evolved.snapshots.slice(1, 2) }));
    filtered.view.type('zzz');
    expect(filtered.view.empty()).toHaveLength(1);
  });

  it('shows the text of the catalog as text, never as markup', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const { send, view, app } = start();
    send(
      message({
        ...evolved,
        connection: hostile,
        schema: hostile,
        name: hostile,
        snapshots: [
          {
            id: 1,
            time: null,
            author: hostile,
            message: hostile,
            events: [{ kind: 'created', name: hostile, from: null }],
            previous: null,
            exists: true,
          },
        ],
        columns: [
          {
            id: 1,
            parent: null,
            path: [hostile],
            formerNames: [hostile],
            now: hostile,
            cells: [{ snapshot: 1, kind: 'added', text: `+ added: ${hostile}` }],
          },
        ],
      }),
    );
    expect(view.h1()).toContain(hostile);
    expect(view.names()).toEqual([`${hostile} (formerly ${hostile})`]);
    view.cell(`+ added: ${hostile}`)?.fire('click');
    expect(view.detail()?.byClass('who')[0]?.textContent).toBe(`${hostile} · ${hostile}`);
    expect(app().find((node) => node.tag === 'img')).toEqual([]);
    view.type(hostile);
    expect(view.names()).toHaveLength(1);
  });
});
