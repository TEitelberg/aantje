import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { ReportScope } from '../../src/shell/scope';
import type { CatalogTree } from '../../src/tree/model';
import { copyHistoryDataFixture, gridTabs, observeWebviews, requireEngine, useExtensionCache } from './data';
import type { WebviewRecord } from './data';
import { Desktop, pick } from './desktop';
import { HISTORY_ID, HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import { activate, copyFixture, nodeAt, onTeardownAsync, setConnections, uniqueId, waitFor } from './support';

/** The labels of the open tabs of a report of one view type. */
function tabs(viewType: string): string[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(viewType))
    .map((tab) => tab.label);
}

interface Sent {
  readonly type: string;
  readonly data: {
    readonly connection: string;
    readonly scope: ReportScope;
    readonly focus: number | null;
    readonly latest: number;
    readonly more: boolean;
    readonly inlinedMore: boolean;
    readonly inlinedFailed: boolean;
    readonly snapshots: { id: number; author: string | null; commitMessage: string | null }[];
    readonly tables: { id: number; schema: string; name: string }[];
    readonly changes: { tableId: number; snapshot: number | null; rows: number; files: number }[];
  };
}

/** The growth data that the extension posted to a page. */
const sentTo = (record: WebviewRecord): Sent[] =>
  record.messages.filter(
    (message): message is Sent =>
      typeof message === 'object' && message !== null && 'type' in message && message.type === 'growth',
  );

/** What the page does when a button is pressed: it posts the request to the extension. */
async function pressButton(record: WebviewRecord, request: unknown): Promise<void> {
  assert.ok(record.receivers.length > 0, 'the extension listens to the page');
  for (const receiver of record.receivers) {
    await receiver(request);
  }
}

const untitledDocuments = (): vscode.TextDocument[] =>
  vscode.workspace.textDocuments.filter((document) => document.isUntitled);

describe('Growth', () => {
  let tree: CatalogTree;
  let desktop: Desktop;
  let webviews: WebviewRecord[];
  let id: string;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
    webviews = observeWebviews();
    id = uniqueId('growth');
    await setConnections([{ id, name: 'Lake', kind: 'sqlite', path: copyFixture('history/history.sqlite') }]);
    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, 'Lake'));
    onTeardownAsync(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
  });

  afterEach(() => {
    desktop.assertDone();
  });

  const connection = () => nodeAt(tree, 'Lake');
  const events = () => nodeAt(tree, 'Lake', 'shop', 'Tables', 'events');

  /** Opens the report from a node and waits for the page to ask for and get its data. */
  async function open(node: Promise<unknown>): Promise<WebviewRecord> {
    await vscode.commands.executeCommand('aantje.showGrowth', await node);
    const panel = webviews.findLast((record) => record.viewType === 'aantje.growth');
    assert.ok(panel);
    await waitFor('the report page to ask for its data and get it', () => sentTo(panel).length > 0);
    return panel;
  }

  it('opens a tab for the lake, reads the growth under a progress, and sends the data when the page asks', async () => {
    const panel = await open(connection());

    assert.equal(tabs('aantje.growth').length, 1);
    assert.equal(desktop.progress.length, 1);
    const [message] = sentTo(panel);
    assert.deepEqual(
      [message?.data.connection, message?.data.focus, message?.data.latest, message?.data.more],
      ['Lake', null, HISTORY_LATEST_SNAPSHOT, false],
    );
    assert.equal(message?.data.snapshots.length, HISTORY_LATEST_SNAPSHOT + 1);
    assert.equal(message?.data.inlinedMore, false);
    assert.equal(message?.data.inlinedFailed, false);
    assert.deepEqual(
      message?.data.tables.map(({ schema, name }) => `${schema}.${name}`),
      [
        'main.evolved',
        'shop.audit',
        'shop.customers',
        'shop.events',
        'shop.log',
        'shop.notes',
        'shop.readings',
      ],
    );
    assert.deepEqual(
      message?.data.changes
        .filter(({ tableId }) => tableId === HISTORY_ID.notes)
        .map(({ snapshot, rows }) => [snapshot, rows]),
      [
        [20, 3],
        [22, -1],
      ],
      'the inlined rows are counted',
    );
    assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
  });

  it('opens a tab of its own for a table, which the page starts with, reuses it for the same table and reads the table again on Refresh', async () => {
    await open(connection());
    const panel = await open(events());

    assert.equal(tabs('aantje.growth').length, 2);
    assert.equal(sentTo(panel)[0]?.data.focus, HISTORY_ID.events);
    assert.equal(sentTo(panel)[0]?.data.tables.length, 7, 'the other tables stay in the choice');
    assert.equal(desktop.progress.length, 2);
    assert.equal(webviews.length, 2);

    await vscode.commands.executeCommand('aantje.showGrowth', await events());
    await waitFor('the second data', () => sentTo(panel).length === 2);
    assert.equal(webviews.length, 2, 'no third panel was created');
    assert.deepEqual(sentTo(panel)[1]?.data, sentTo(panel)[0]?.data);

    await pressButton(panel, { type: 'refresh' });
    await waitFor('the third data', () => sentTo(panel).length === 3);
    assert.equal(desktop.progress.length, 4, 'the growth was read under a progress again');
    assert.equal(sentTo(panel)[2]?.data.focus, HISTORY_ID.events, 'the refresh keeps to the table');
    assert.equal(webviews.length, 2);
  });

  it('opens a tab of its own for a schema with the tables of the schema and their changes only', async () => {
    await open(connection());
    const panel = await open(nodeAt(tree, 'Lake', 'main'));

    assert.equal(tabs('aantje.growth').length, 2);
    const data = sentTo(panel)[0]?.data ?? assert.fail('no data');
    assert.equal(data.scope.kind === 'schema' && data.scope.name, 'main');
    assert.deepEqual(
      data.tables.map(({ schema, name }) => `${schema}.${name}`),
      ['main.evolved'],
    );
    assert.ok(data.changes.length > 0);
    assert.ok(data.changes.every(({ tableId }) => tableId === HISTORY_ID.evolving));
  });

  it('does nothing for a folder, a snapshot or a call without a node', async () => {
    for (const path of [['shop', 'Tables', 'events', 'History'], ['Snapshots']]) {
      await vscode.commands.executeCommand('aantje.showGrowth', await nodeAt(tree, 'Lake', ...path));
    }
    await vscode.commands.executeCommand('aantje.showGrowth');

    assert.deepEqual([desktop.progress, webviews, desktop.errors, desktop.infos], [[], [], [], []]);
  });

  describe('the actions of the detail pane', () => {
    it('shows the catalog at the snapshot in the tree', async () => {
      const panel = await open(connection());

      await pressButton(panel, { type: 'action', action: 'showCatalog', snapshot: 25 });

      assert.equal(tree.state(id).snapshot, 25);
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });

    it('opens the Markdown document of the table and the value that the page names', async () => {
      const panel = await open(events());
      const before = new Set(untitledDocuments());

      await pressButton(panel, { type: 'markdown', view: { table: HISTORY_ID.events, metric: 'files' } });
      const document = await waitFor('the report document', () =>
        untitledDocuments().find((candidate) => !before.has(candidate)),
      );

      assert.equal(document.languageId, 'markdown');
      assert.match(document.getText(), /\| Table \| `shop.events` \|/);
      assert.match(document.getText(), /\| @10 \| .* \| 8 \| \+3 \| yes \|/);
    });

    it('ignores a request that the data does not offer, one with a command in it, and one it does not know', async () => {
      const panel = await open(connection());
      const before = [tree.state(id).snapshot, untitledDocuments().length, gridTabs().length];
      const asked = desktop.progress.length;

      for (const request of [
        { type: 'action', action: 'showCatalog', snapshot: 999 },
        { type: 'action', action: 'query', snapshot: 23, table: 9999 },
        { type: 'action', action: 'query', snapshot: 23, table: HISTORY_ID.bigEventsView },
        { type: 'action', action: 'query', snapshot: 999, table: 3 },
        { type: 'action', action: 'rowsChanged', snapshot: 23, table: 3 },
        { type: 'action', action: 'workbench.action.quit' },
        { type: 'action', action: 'showCatalog', snapshot: 23, command: 'aantje.removeConnection' },
        { type: 'command', command: 'aantje.removeConnection' },
        { type: 'markdown', view: { metric: 'speed' } },
        'showCatalog',
        null,
      ]) {
        await pressButton(panel, request);
      }

      assert.deepEqual([tree.state(id).snapshot, untitledDocuments().length, gridTabs().length], before);
      assert.equal(desktop.progress.length, asked, 'nothing was read for the requests');
      assert.deepEqual([desktop.errors, desktop.infos, desktop.picks], [[], [], []]);
      assert.equal(tree.roots().length, 1, 'the connection is still there');
    });
  });
});

describe('Growth: the action that reads table data', function () {
  before(async function () {
    await requireEngine(this);
  });

  let api: ExtensionApi;
  let tree: CatalogTree;
  let desktop: Desktop;
  let webviews: WebviewRecord[];
  let name: string;
  let profileId: string;

  beforeEach(async () => {
    api = await activate();
    ({ tree } = api);
    desktop = Desktop.install();
    webviews = observeWebviews();
    await useExtensionCache();
    const { profile } = await copyHistoryDataFixture('sqlite');
    ({ name } = profile);
    profileId = profile.id;
    await setConnections([profile]);
    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, name));
    onTeardownAsync(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
  });

  afterEach(() => {
    desktop.assertDone();
  });

  it('opens the statement for the table as it was at the snapshot in an SQL document of the connection, and runs nothing', async () => {
    await vscode.commands.executeCommand('aantje.showGrowth', await nodeAt(tree, name));
    const [report] = webviews;
    assert.ok(report);
    await waitFor('the report page to ask for its data and get it', () => sentTo(report).length > 0);
    desktop.answer(pick('Open as SQL'));
    const before = new Set(untitledDocuments());

    await pressButton(report, { type: 'action', action: 'query', snapshot: 30, table: HISTORY_ID.evolving });
    const document = await waitFor('the SQL document', () =>
      untitledDocuments().find((candidate) => !before.has(candidate)),
    );

    assert.equal(document.languageId, 'sql');
    assert.match(document.getText(), /FROM "main"\."evolving" AT \(VERSION => 30\)/);
    await waitFor(
      'the document to belong to the connection',
      () => api.editors.connectionOf(document.uri.toString()) === profileId,
    );
    assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
  });
});
