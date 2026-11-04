import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { DependenciesData } from '../../src/dependencies/model';
import type { CatalogTree } from '../../src/tree/model';
import { observeWebviews } from './data';
import type { WebviewRecord } from './data';
import { Desktop } from './desktop';
import { HISTORY_ID, HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import { activate, copyFixture, nodeAt, onTeardownAsync, setConnections, uniqueId, waitFor } from './support';

interface Sent {
  readonly type: string;
  readonly data: DependenciesData;
}

/** The data that the extension posted to a page. */
const sentTo = (record: WebviewRecord): Sent[] =>
  record.messages.filter(
    (message): message is Sent =>
      typeof message === 'object' && message !== null && 'type' in message && message.type === 'dependencies',
  );

/** What the page does when a button is pressed: it posts the request to the extension. */
async function post(record: WebviewRecord, request: unknown): Promise<void> {
  assert.ok(record.receivers.length > 0, 'the extension listens to the page');
  for (const receiver of record.receivers) {
    await receiver(request);
  }
}

const tabsOf = (viewType: string): string[] =>
  vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(viewType))
    .map((tab) => tab.label);

const untitledDocuments = (): vscode.TextDocument[] =>
  vscode.workspace.textDocuments.filter((document) => document.isUntitled);

/** The nodes of the data by name, in the order the page numbers them. */
const names = (data: DependenciesData): string[] => data.nodes.map(({ schema, name }) => `${schema}.${name}`);

describe('Show Dependencies', () => {
  let api: ExtensionApi;
  let tree: CatalogTree;
  let desktop: Desktop;
  let webviews: WebviewRecord[];
  let id: string;

  beforeEach(async () => {
    api = await activate();
    ({ tree } = api);
    desktop = Desktop.install();
    webviews = observeWebviews();
    id = uniqueId('dependencies');
    await setConnections([{ id, name: 'Lake', kind: 'sqlite', path: copyFixture('history/history.sqlite') }]);
    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, 'Lake'));
    onTeardownAsync(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
  });

  afterEach(() => {
    desktop.assertDone();
  });

  const events = () => nodeAt(tree, 'Lake', 'shop', 'Tables', 'events');
  const bigEvents = () => nodeAt(tree, 'Lake', 'shop', 'Views', 'big_events');
  const recentEvents = () => nodeAt(tree, 'Lake', 'shop', 'Macros', 'recent_events');

  /** Opens the report for a node and waits for the page to ask for its data and get it. */
  async function open(node: Promise<unknown>, seen = 0): Promise<WebviewRecord> {
    await vscode.commands.executeCommand('aantje.showDependencies', await node);
    const panel = webviews.filter(({ viewType }) => viewType === 'aantje.dependencies').at(-1);
    assert.ok(panel);
    await waitFor('the report page to ask for its data and get it', () => sentTo(panel).length > seen);
    return panel;
  }

  const dataOf = (panel: WebviewRecord): DependenciesData => sentTo(panel)[0]?.data ?? assert.fail('no data');

  async function opensDocument(panel: WebviewRecord, request: unknown): Promise<vscode.TextDocument> {
    const before = new Set(untitledDocuments());
    await post(panel, request);
    return waitFor('the document', () => untitledDocuments().find((candidate) => !before.has(candidate)));
  }

  describe('opening the report', () => {
    it('opens a tab for a table with the objects around it, and one for the whole lake from the connection', async () => {
      const panel = await open(events());

      assert.equal(tabsOf('aantje.dependencies').length, 1);
      assert.equal(desktop.progress.length, 1);
      const data = dataOf(panel);
      assert.deepEqual(names(data), ['shop.big_events', 'shop.events', 'shop.recent_events']);
      assert.deepEqual(
        data.edges.map(({ from, to, kind }) => `${names(data)[from]} ${kind} ${names(data)[to]}`),
        ['shop.big_events reads shop.events', 'shop.recent_events reads shop.events'],
      );
      assert.deepEqual(
        [data.connection, data.snapshot, data.target, data.broken, data.unresolved],
        ['Lake', HISTORY_LATEST_SNAPSHOT, 1, [], []],
      );

      const lake = dataOf(await open(nodeAt(tree, 'Lake')));
      assert.equal(tabsOf('aantje.dependencies').length, 2);
      assert.deepEqual(names(lake), ['shop.big_events', 'shop.events', 'shop.recent_events']);
      assert.deepEqual([lake.target, lake.isolated, lake.objects, lake.parsed], [null, 7, 3, 3]);
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });

    it('opens the report of a view and of a macro, each in a panel of its own, and shows the same panel again for the same object', async () => {
      const view = await open(bigEvents());
      // Every object of the lake with dependencies, for Show all in the graph.
      assert.deepEqual(names(dataOf(view)), ['shop.big_events', 'shop.events', 'shop.recent_events']);

      await open(recentEvents());
      assert.equal(webviews.length, 2);

      await vscode.commands.executeCommand('aantje.showDependencies', await bigEvents());
      await waitFor('the data again in the panel of the view', () => sentTo(view).length === 2);
      assert.equal(webviews.length, 2, 'no third panel was created');
      assert.equal(tabsOf('aantje.dependencies').length, 2);
    });

    it('reads the catalog at the snapshot that the tree shows, and refresh reads it again', async () => {
      tree.selectSnapshot(id, 41);
      const panel = await open(nodeAt(tree, 'Lake', 'shop', 'Views', 'big_events'));
      assert.equal(dataOf(panel).snapshot, 41);

      await post(panel, { type: 'refresh' });
      await waitFor('the data again', () => sentTo(panel).length === 2);
      assert.equal(desktop.progress.length, 2, 'the catalog was read under a progress again');
    });

    it('opens a tab of its own for a schema with the objects of the schema that take part', async () => {
      const shop = dataOf(await open(nodeAt(tree, 'Lake', 'shop')));
      const main = dataOf(await open(nodeAt(tree, 'Lake', 'main')));

      assert.equal(tabsOf('aantje.dependencies').length, 2);
      assert.deepEqual(
        [shop.scope, main.scope].map((scope) => scope.kind === 'schema' && scope.name),
        ['shop', 'main'],
      );
      assert.deepEqual(names(shop), ['shop.big_events', 'shop.events', 'shop.recent_events']);
      assert.deepEqual(names(main), []);
    });

    it('does nothing for a folder, a column or a call without a node', async () => {
      for (const path of [
        ['shop', 'Tables'],
        ['shop', 'Macros'],
        ['shop', 'Tables', 'events', 'Columns'],
        ['Snapshots'],
      ]) {
        await vscode.commands.executeCommand('aantje.showDependencies', await nodeAt(tree, 'Lake', ...path));
      }
      await vscode.commands.executeCommand('aantje.showDependencies');
      assert.deepEqual([desktop.progress, webviews, desktop.errors], [[], [], []]);
    });
  });

  describe('the actions on an object', () => {
    const index = (data: DependenciesData, name: string): number =>
      data.nodes.findIndex((node) => node.name === name);

    it('opens the DROP script of the table, and the CREATE, ALTER and DROP script of a view and of a macro, in SQL documents of the connection that run nothing', async () => {
      const panel = await open(events());
      const data = dataOf(panel);

      const drop = await opensDocument(panel, { type: 'action', action: 'scriptDrop', node: data.target });

      assert.equal(drop.languageId, 'sql');
      assert.equal(
        drop.getText(),
        ['-- Drops the table. Run it in a read/write SQL session.', 'DROP TABLE "shop"."events";'].join('\n'),
      );
      await waitFor(
        'the document to belong to the connection',
        () => api.editors.connectionOf(drop.uri.toString()) === id,
      );
      assert.equal(api.editors.state(drop.uri.toString())?.running, false);

      const view = index(data, 'big_events');
      const macro = index(data, 'recent_events');
      assert.match(
        (await opensDocument(panel, { type: 'action', action: 'scriptCreate', node: view })).getText(),
        /CREATE VIEW "shop"\."big_events" AS/,
      );
      assert.match(
        (await opensDocument(panel, { type: 'action', action: 'scriptAlter', node: view })).getText(),
        /CREATE OR REPLACE VIEW "shop"\."big_events" AS/,
      );
      assert.match(
        (await opensDocument(panel, { type: 'action', action: 'scriptDrop', node: macro })).getText(),
        /DROP MACRO TABLE "shop"\."recent_events";/,
      );
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });

    it('Show in tree selects the table, the view and the macro in the tree', async () => {
      const panel = await open(events());
      const data = dataOf(panel);

      for (const [name, kind] of [
        ['events', 'table'],
        ['big_events', 'view'],
        ['recent_events', 'macro'],
      ] as const) {
        await post(panel, { type: 'action', action: 'showInTree', node: index(data, name) });
        await waitFor(`${name} to be selected`, () =>
          api.view.selection.some((node) => node.ref.kind === kind),
        );
        const [node] = api.view.selection;
        const label =
          node?.ref.kind === 'table'
            ? node.ref.table.name
            : node?.ref.kind === 'view'
              ? node.ref.view.name
              : node?.ref.kind === 'macro'
                ? node.ref.macro.name
                : undefined;
        assert.equal(label, name);
      }
    });

    it('Statistics opens the statistics panel of the table, and Dependencies the report of the other object', async () => {
      const panel = await open(events());
      const data = dataOf(panel);

      await post(panel, { type: 'action', action: 'showStatistics', node: data.target });
      await waitFor('the statistics', () => tabsOf('aantje.statistics').length === 1);

      await post(panel, { type: 'action', action: 'showDependencies', node: index(data, 'big_events') });
      await waitFor('the report of the view', () =>
        webviews
          .filter(({ viewType }) => viewType === 'aantje.dependencies')
          .some((candidate) => {
            const sent = sentTo(candidate)[0]?.data;
            return candidate !== panel && sent !== undefined && sent.target === index(sent, 'big_events');
          }),
      );
    });

    it('keeps to the snapshot of the report for the other object and for the scripts, whatever the tree shows by then', async () => {
      tree.selectSnapshot(id, 41);
      const panel = await open(events());
      const data = dataOf(panel);
      assert.equal(data.snapshot, 41);
      tree.selectSnapshot(id, 'latest');

      await post(panel, { type: 'action', action: 'showDependencies', node: index(data, 'big_events') });
      const other = await waitFor('the report of the view', () =>
        webviews
          .filter(({ viewType }) => viewType === 'aantje.dependencies')
          .find((candidate) => candidate !== panel),
      );
      await waitFor('its data', () => sentTo(other).length > 0);
      assert.equal(dataOf(other).snapshot, 41);

      const document = await opensDocument(panel, {
        type: 'action',
        action: 'scriptDrop',
        node: data.target,
      });
      assert.match(document.getText(), /snapshot @41; this statement acts on the newest state\./);
    });

    it('opens the Markdown document of the report with the direction and depth of the page', async () => {
      const panel = await open(events());

      const document = await opensDocument(panel, {
        type: 'markdown',
        view: { direction: 'usedBy', depth: 1, text: '' },
      });

      assert.equal(document.languageId, 'markdown');
      const text = document.getText();
      assert.match(text, /^# Dependencies of shop\\\.events$/m);
      assert.match(text, /\| Direction \| Used by \|/);
      assert.match(text, /Dropping `shop\.events` breaks 2 objects: 1 view, 1 table macro\./);
    });

    it('ignores requests that the data does not offer: an object that was not sent, statistics of a view, a command id, a field that nobody declared, text for the document', async () => {
      const panel = await open(events());
      const data = dataOf(panel);
      const documents = untitledDocuments().length;
      const panels = webviews.length;

      await post(panel, { type: 'action', action: 'scriptDrop', node: 9999 });
      await post(panel, {
        type: 'action',
        action: 'showStatistics',
        node: data.nodes.findIndex((n) => n.kind === 'view'),
      });
      await post(panel, { type: 'action', action: 'showInTree', node: -1 });
      await post(panel, { type: 'action', action: 'scriptDrop', node: data.target, sql: 'DROP TABLE x' });
      await post(panel, { type: 'action', action: 'aantje.removeConnection', node: 0 });
      await post(panel, { type: 'run', command: 'aantje.removeConnection' });
      await post(panel, { type: 'markdown', markdown: '# written by the page' });
      await post(panel, { type: 'markdown', view: { direction: 'sideways', depth: 3, text: '' } });

      assert.deepEqual([desktop.errors, desktop.infos, desktop.confirmations], [[], [], []]);
      assert.equal(untitledDocuments().length, documents);
      assert.equal(webviews.length, panels);
      assert.equal(HISTORY_ID.events, data.nodes[data.target ?? 0]?.id);
    });
  });
});
