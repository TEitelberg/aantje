import { beforeEach, describe, expect, it } from 'vitest';
import {
  actionButton,
  cardGrid,
  choiceSelect,
  dataTable,
  findingCard,
  keyList,
  kindCheckbox,
  pageHeader,
  rangeField,
  searchBox,
  tabBar,
  tableRow,
  toolbar,
} from '../../src/shell/blocks';
import { el } from '../../src/shell/dom';
import type { Card } from '../../src/shell/model';
import type { PageContext } from '../../src/shell/page';
import type { ActionMessage, ShellRequest } from '../../src/shell/protocol';
import { FakeNode, installFakeDocument } from '../support/fake-dom';

/**
 * The blocks that every report page is built from, called against a stand-in for the DOM: what the controls post to
 * the extension, how the focus and the keyboard move through them, and that catalog text stays text.
 */

beforeEach(installFakeDocument);

const node = (value: unknown): FakeNode => value as FakeNode;
const HOSTILE = '<img src=x onerror=alert(1)>';

function context(): { context: PageContext; posted: (ShellRequest | ActionMessage)[] } {
  const posted: (ShellRequest | ActionMessage)[] = [];
  return {
    posted,
    context: {
      app: node(new FakeNode('div')) as unknown as HTMLElement,
      post: (request) => posted.push(request),
      state: { get: () => undefined, set: () => undefined },
      refreshAsked: false,
    },
  };
}

describe('the page header', () => {
  it('asks the extension to read again on Refresh, and gives Refresh the focus back when the data has arrived', () => {
    const { context: page, posted } = context();
    const header = pageHeader(page, { title: 'T', subtitle: 'S', refresh: 'Read again' });
    header.settle();
    expect(FakeNode.active).toBeUndefined();

    node(header.element).buttons('Refresh')[0]?.fire('click');
    expect(posted).toEqual([{ type: 'refresh' }]);
    expect(page.refreshAsked).toBe(true);

    header.settle();
    expect(FakeNode.active?.textContent).toBe('Refresh');
    expect(page.refreshAsked).toBe(false);
  });

  it('asks for the Markdown document with the view as it is when the button is pressed, or with none; a report without a read has no Refresh', () => {
    const { context: page, posted } = context();
    const plain = pageHeader(page, {
      title: 'T',
      subtitle: 'S',
      actions: [actionButton('Own', () => undefined)],
    });
    expect(node(plain.element).buttons('Refresh')).toEqual([]);
    expect(node(plain.element).buttons('Own')).toHaveLength(1);
    node(plain.element).buttons('Open as Markdown')[0]?.fire('click');

    let filter = '';
    const filtered = pageHeader(page, { title: 'T', subtitle: 'S', view: () => ({ filter }) });
    filter = 'typed later';
    node(filtered.element).buttons('Open as Markdown')[0]?.fire('click');

    expect(posted).toEqual([{ type: 'markdown' }, { type: 'markdown', view: { filter: 'typed later' } }]);
  });
});

describe('the key figures', () => {
  const cards: Card[] = [
    { label: HOSTILE, value: '9', severity: 'ok', hint: 'Data files.' },
    { label: 'Small files', value: '100 %', detail: '9 of 9', severity: 'warning' },
    { label: 'Broken', value: '1', severity: 'error' },
  ];
  const colours = { warning: '#d18616', error: '#f14c4c', ok: '#3794ff' };

  it('shows label, value and detail as text, marks the severity by class and by the colour of the page, and has four columns when asked', () => {
    const grid = node(cardGrid(cards, (severity) => colours[severity]));
    const boxes = grid.byClass('card');
    expect(boxes.map((box) => box.children.map((child) => child.textContent))).toEqual([
      [HOSTILE, '9'],
      ['Small files', '100 %', '9 of 9'],
      ['Broken', '1'],
    ]);
    expect(grid.byTag('img')).toEqual([]);
    expect(boxes.map((box) => box.className)).toEqual(['card', 'card warning', 'card error']);
    expect(boxes.map((box) => box.style.borderColor)).toEqual([undefined, '#d18616', '#f14c4c']);
    expect(grid.className).toBe('cards');
    expect(cardGrid(cards, () => '#000', 4).className).toBe('cards cards-4');
  });
});

describe('the tabs', () => {
  const tabs = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ] as const;

  it('keep only the selected tab in the tab order, select on a click without the focus and on an arrow key with it, wrapping at both ends', () => {
    const chosen: [string, boolean][] = [];
    const bar = node(tabBar(tabs, 'b', (id, refocus) => chosen.push([id, refocus])));
    expect(bar.getAttribute('role')).toBe('tablist');
    const [a, b, c] = bar.buttons();
    expect(bar.buttons().map((tab) => [tab.getAttribute('aria-selected'), tab.tabIndex])).toEqual([
      ['false', -1],
      ['true', 0],
      ['false', -1],
    ]);

    c?.fire('click');
    a?.fire('keydown', { key: 'ArrowLeft' });
    c?.fire('keydown', { key: 'ArrowRight' });
    b?.fire('keydown', { key: 'Enter' });
    b?.fire('keydown', { key: 'End' });
    b?.fire('keydown', { key: 'Home' });
    expect(chosen).toEqual([
      ['c', false],
      ['c', true],
      ['a', true],
      ['c', true],
      ['a', true],
    ]);
  });
});

describe('the list that the keyboard can work', () => {
  const items = [{ label: 'one' }, { label: 'two', selected: true }, { label: 'three' }];

  it('moves the focus and the tab stop with the arrow keys, Home and End, leaves Enter to the browser, and tells which item was picked', () => {
    const picked: number[] = [];
    const list = node(keyList(items, (index) => picked.push(index)));
    expect(list.getAttribute('role')).toBe('listbox');
    const [one, two, three] = list.buttons();
    const stops = () => list.buttons().map((button) => button.tabIndex);
    expect(stops()).toEqual([0, -1, -1]);
    expect(list.buttons().map((button) => button.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);

    expect(one?.fire('keydown', { key: 'ArrowDown' }).prevented).toBe(true);
    expect(FakeNode.active).toBe(two);
    expect(stops()).toEqual([-1, 0, -1]);
    three?.fire('keydown', { key: 'ArrowDown' });
    expect(FakeNode.active).toBe(three);
    one?.fire('keydown', { key: 'ArrowUp' });
    expect(FakeNode.active).toBe(one);
    two?.fire('keydown', { key: 'End' });
    expect(FakeNode.active).toBe(three);
    two?.fire('keydown', { key: 'Home' });
    expect(FakeNode.active).toBe(one);
    expect(stops()).toEqual([0, -1, -1]);

    expect(one?.fire('keydown', { key: 'Enter' }).prevented).toBe(false);
    three?.fire('click');
    one?.fire('click');
    expect(picked).toEqual([2, 0]);
  });
});

describe('the expandable card', () => {
  it('is closed unless asked to open, carries its severity as a class, and holds the actions', () => {
    const closed = node(
      findingCard({
        severity: 'warning',
        title: '9 small files',
        body: ['They slow reads down.'],
        actions: [actionButton('Merge', () => undefined)],
      }),
    );
    expect([closed.tag, closed.className, closed.open]).toEqual(['details', 'finding warning', false]);
    expect(closed.buttons()).toHaveLength(1);

    const open = node(findingCard({ severity: 'ok', title: 'Fine', body: [], open: true }));
    expect([open.className, open.open]).toEqual(['finding', true]);
    expect(open.byClass('actions')).toEqual([]);
  });
});

describe('the controls of the filter bar', () => {
  it('has a search field that tells the page what is typed', () => {
    const typed: string[] = [];
    const box = node(searchBox('Filter', 'abc', (text) => typed.push(text)));
    const input = node(toolbar(box as unknown as HTMLElement)).byTag('input')[0];
    expect([input?.type, input?.value]).toEqual(['search', 'abc']);
    if (input) input.value = 'abcd';
    input?.fire('input');
    expect(typed).toEqual(['abcd']);
  });

  it('has a select that keeps a table called "all" apart from everything, tells the page the key or nothing, and follows show()', () => {
    const chosen: (string | undefined)[] = [];
    const entries = [
      { key: '7', label: 'shop.events' },
      { key: 'all', label: 'a table that is called all' },
    ];
    const choice = choiceSelect('Table', 'All tables', entries, '7', (key) => chosen.push(key));
    const select = node(choice.element).byTag('select')[0];
    expect(
      node(choice.element)
        .byTag('option')
        .map((option) => option.value),
    ).toEqual(['all', 'k:7', 'k:all']);
    expect(select?.value).toBe('k:7');

    if (select) select.value = 'k:all';
    select?.fire('change');
    if (select) select.value = 'all';
    select?.fire('change');
    expect(chosen).toEqual(['all', undefined]);

    choice.show('7');
    expect(select?.value).toBe('k:7');
    choice.show(undefined);
    expect(select?.value).toBe('all');

    const none = choiceSelect('Author', 'All', [{ key: 'ann', label: 'ann' }], undefined, () => undefined);
    expect(node(none.element).byTag('select')[0]?.value).toBe('all');
  });

  it('has a checkbox for a kind of change that adds it to the chosen kinds or removes it, and tells the page', () => {
    const chosen = new Set(['insert']);
    let changes = 0;
    const input = node(kindCheckbox('Delete', 'delete', chosen, () => changes++)).byTag('input')[0];
    expect([input?.type, input?.checked]).toEqual(['checkbox', false]);
    expect(node(kindCheckbox('Insert', 'insert', chosen, () => undefined)).byTag('input')[0]?.checked).toBe(
      true,
    );

    if (input) input.checked = true;
    input?.fire('change');
    expect([...chosen]).toEqual(['insert', 'delete']);
    if (input) input.checked = false;
    input?.fire('change');
    expect([...chosen]).toEqual(['insert']);
    expect(changes).toBe(2);
  });

  it('has a field for the end of a range that keeps what is typed inside the bounds and ignores what is no whole number', () => {
    const end = { value: 40 };
    const set: number[] = [];
    const label = node(
      rangeField(
        'To',
        10,
        56,
        () => end.value,
        (next) => {
          end.value = next;
          set.push(next);
        },
      ),
    );
    const input = label.byTag('input')[0];
    const bounds = input as unknown as HTMLInputElement;
    expect([input?.type, bounds.min, bounds.max, input?.value]).toEqual(['number', '10', '56', '40']);

    for (const [typed, shown] of [
      ['30', '30'],
      ['99', '56'],
      ['3', '10'],
      ['', '10'],
      ['  ', '10'],
      ['abc', '10'],
      ['12.5', '10'],
    ]) {
      if (input) input.value = typed ?? '';
      input?.fire('change');
      expect(input?.value, `typed "${typed}"`).toBe(shown);
    }
    expect(set).toEqual([30, 56, 10, 10, 10, 10, 10]);
  });

  it('builds a table from heading strings or heading cells and rows whose strings are cells, inside a box that scrolls sideways', () => {
    const heading = el('th', 'number');
    heading.append(el('button', 'sort', 'Size'));
    const box = node(dataTable(['Table', heading], [tableRow([HOSTILE, '1']), tableRow(['c', '2'])]));
    expect(box.className).toBe('table-scroll');
    expect(box.children.map((child) => child.tag)).toEqual(['table']);
    expect(box.byTag('th').map((cell) => cell.textContent)).toEqual(['Table', 'Size']);
    expect(box.byTag('th')[1]?.className).toBe('number');
    expect(box.buttons('Size')).toHaveLength(1);
    expect(
      box.byTag('tbody')[0]?.children.map((row) => row.children.map((cell) => cell.textContent)),
    ).toEqual([
      [HOSTILE, '1'],
      ['c', '2'],
    ]);
    expect(box.byTag('img')).toEqual([]);
  });
});
