import { beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogProperties, TableStatistics } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import type { PropertiesData } from '../../src/properties-report/model';
import { formatUtc } from '../../src/shell/model';
import { HISTORY_DATA_PATH } from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { FakeNode } from '../support/fake-dom';
import { buildClientBundle, startPage } from '../support/page-harness';
import { historyStatistics } from './stats-support';
import { historyFixture } from '../support/sources/history';

/**
 * Runs the real browser bundle against a stand-in for the DOM: the Properties page shows what the extension sends,
 * filters the metadata table, keeps the filter while VS Code takes the page down, and posts only the requests that
 * the extension accepts. The page of the report is chosen by the first message; the other pages are covered by
 * their own client tests.
 */

let bundle: string;
let properties: CatalogProperties;
let events: TableStatistics;

beforeAll(async () => {
  bundle = await buildClientBundle();
  const reader = createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
  properties = await reader.properties();
  await reader.close();
  ({ events } = await historyStatistics());
});

const message = (actions: PropertiesData['actions'] = [], changed: Partial<CatalogProperties> = {}) => ({
  type: 'properties',
  data: { connection: 'History', properties: { ...properties, ...changed }, actions },
});

function start(saved?: unknown) {
  const page = startPage(bundle, saved);
  const find = (predicate: (node: FakeNode) => boolean) => page.app().find(predicate);
  const view = {
    h1: () => find((node) => node.tag === 'h1')[0]?.textContent,
    subtitle: () => find((node) => node.hasClass('subtitle'))[0]?.textContent,
    cards: () => find((node) => node.hasClass('card')).map((card) => card.children.map((c) => c.textContent)),
    rows: () =>
      find((node) => node.tag === 'tbody')[0]?.children.map((row) => row.children.map((c) => c.textContent)),
    buttons: () => find((node) => node.tag === 'button').map((button) => button.textContent),
    button: (label: string) => find((node) => node.tag === 'button' && node.textContent === label)[0],
    filter: () => find((node) => node.tag === 'input')[0] as FakeNode,
    type: (text: string) => {
      const input = view.filter();
      input.value = text;
      input.fire('input');
    },
    text: () => page.app().textContent,
    empty: () => find((node) => node.hasClass('empty')).map((node) => node.textContent),
    notes: () => find((node) => node.hasClass('note')).map((node) => node.textContent),
    h2: () => find((node) => node.tag === 'h2').map((node) => node.textContent),
    headings: () => find((node) => node.tag === 'th').map((node) => node.textContent),
  };
  return { ...page, view };
}

describe('the Properties page', () => {
  it('tells the extension that it is ready, and says that it is reading until the data arrives', () => {
    const { posted, app } = start();
    expect(posted).toEqual([{ type: 'ready' }]);
    expect(app().textContent).toBe('Reading...');
  });

  it('shows the facts of the history fixture as key figures and every metadata entry with its scope', () => {
    const { send, view } = start();
    send(message());

    expect(view.h1()).toBe('Properties');
    expect(view.subtitle()).toBe('History · 5 metadata entries');
    expect(view.cards()).toEqual([
      ['DuckLake version', '1.1'],
      ['Created by', properties.createdBy ?? 'not set'],
      ['Encrypted', 'no'],
      ['Snapshots', '57'],
      ['First snapshot', formatUtc(properties.firstSnapshotTime ?? '')],
      ['Latest snapshot', formatUtc(properties.latestSnapshotTime ?? '')],
    ]);
    expect(view.rows()).toEqual([
      ['created_by', properties.createdBy ?? '', 'global'],
      ['data_path', HISTORY_DATA_PATH.sqlite, 'global'],
      ['encrypted', 'false', 'global'],
      ['version', '1.1', 'global'],
      ['data_inlining_row_limit', '10', 'table 10'],
    ]);
    expect(view.buttons()).toEqual(['Refresh', 'Open as Markdown']);
    expect(view.h2()).toEqual(['Metadata']);
    expect(view.headings()).toEqual(['Key', 'Value', 'Scope']);
    expect(view.button('Refresh')?.getAttribute('aria-label')).toMatch(/^Refresh\b/);
  });

  it('writes the number of snapshots with thousands separators, and flags no key figure as a problem', () => {
    const { send, view, app } = start();
    send(message([], { snapshotCount: 1234, encrypted: true }));

    expect(view.cards()).toContainEqual(['Snapshots', '1,234']);
    expect(view.cards()).toContainEqual(['Encrypted', 'yes']);
    expect(app().find((node) => node.hasClass('card') && node.className !== 'card')).toEqual([]);
  });

  it('ignores the space around the filter when it names the filter that matches nothing', () => {
    const { send, view } = start();
    send(message());

    view.type('  zzz  ');

    // One message that names the filter as typed, without the spaces around it.
    expect(view.empty()).toEqual([expect.stringContaining('"zzz"')]);
  });

  it('filters the table while the user types, and says so when nothing matches', () => {
    const { send, view } = start();
    send(message());

    view.type('INLINING');
    expect(view.rows()).toEqual([['data_inlining_row_limit', '10', 'table 10']]);
    view.type('global');
    expect(view.rows()?.map((row) => row[0])).toEqual(['created_by', 'data_path', 'encrypted', 'version']);
    view.type('zzz');
    expect(view.rows()).toBeUndefined();
    expect(view.empty()).toEqual([expect.stringContaining('"zzz"')]);
    view.type('');
    expect(view.rows()).toHaveLength(5);
    expect(view.empty()).toEqual([]);
  });

  it('says that a catalog has no metadata, and keeps the key figures', () => {
    const { send, view } = start();
    send(message([], { metadata: [] }));
    expect(view.empty()).toHaveLength(1);
    expect(view.cards()).toHaveLength(6);
  });

  it('shows the first 500 entries of a long table, says so, and finds the others through the filter', () => {
    const { send, view } = start();
    const metadata = Array.from({ length: 620 }, (_, index) => ({
      key: 'data_inlining_row_limit',
      value: String(index),
      scope: 'table',
      scopeId: index,
    }));
    send(message([], { metadata }));
    expect(view.rows()).toHaveLength(500);
    expect(view.notes()).toEqual([expect.stringMatching(/\b500\b.*\b620\b/)]);

    view.type('table 600');
    expect(view.rows()).toEqual([['data_inlining_row_limit', '600', 'table 600']]);
    expect(view.notes()).toEqual([]);
  });

  it('asks for the document with the text in the filter box, and for a refresh that keeps the filter and the focus on Refresh', () => {
    const { send, view, posted } = start();
    send(message());
    view.type('data');
    view.button('Open as Markdown')?.fire('click');
    view.button('Refresh')?.fire('click');
    expect(posted).toEqual([
      { type: 'ready' },
      { type: 'markdown', view: { filter: 'data' } },
      { type: 'refresh' },
    ]);

    send(message());
    expect(view.filter().value).toBe('data');
    expect(view.rows()).toHaveLength(2);
    expect(FakeNode.active?.textContent).toBe('Refresh');
  });

  it('comes back with the filter after VS Code took the page down, for the same connection only', () => {
    const first = start();
    first.send(message());
    first.view.type('inlining');
    const saved = first.saved();
    expect(saved).toEqual({ connection: 'History', filter: 'inlining' });

    const back = start(saved);
    back.send(message());
    expect(back.view.filter().value).toBe('inlining');
    expect(back.view.rows()).toEqual([['data_inlining_row_limit', '10', 'table 10']]);

    const other = start({ connection: 'Another lake', filter: 'inlining' });
    other.send(message());
    expect(other.view.filter().value).toBe('');
    expect(other.view.rows()).toHaveLength(5);

    const broken = start({ filter: 7 });
    broken.send(message());
    expect(broken.view.rows()).toHaveLength(5);
  });

  it('offers an action only when the extension offers it, and asks for it by id', () => {
    const plain = start();
    plain.send(message());
    expect(plain.view.button('Show Storage Report')).toBeUndefined();

    const offered = start();
    offered.send(message(['showStorage']));
    offered.view.button('Show Storage Report')?.fire('click');
    expect(offered.posted).toEqual([{ type: 'ready' }, { type: 'action', action: 'showStorage' }]);
  });

  it('shows the text of the catalog as text, never as markup', () => {
    const { send, view, app } = start();
    const hostile = '<img src=x onerror=alert(1)>';
    send(
      message([], {
        createdBy: hostile,
        dataPath: hostile,
        metadata: [{ key: hostile, value: hostile, scope: hostile, scopeId: null }],
      }),
    );
    expect(view.rows()).toEqual([[hostile, hostile, hostile]]);
    expect(app().find((node) => node.tag === 'img')).toEqual([]);
    view.type(hostile);
    expect(view.rows()).toHaveLength(1);
  });

  it('ignores data it cannot show, and a message of another report once it shows this one', () => {
    const { send, view, app } = start();
    send({ type: 'properties', data: { connection: 'x' } });
    expect(app().textContent).toContain('This page cannot read the data it was sent');
    send(message());
    expect(view.h1()).toBe('Properties');
    send({ type: 'statistics', data: { table: 'shop.events', connection: 'History', statistics: events } });
    send({ type: 'properties', data: null });
    expect(view.h1()).toBe('Properties');
    expect(view.rows()).toHaveLength(5);
  });
});
