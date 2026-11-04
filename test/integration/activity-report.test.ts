import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ReportScope } from '../../src/shell/scope';
import type { CatalogTree } from '../../src/tree/model';
import {
  copyHistoryDataFixture,
  dataMessages,
  gridTabs,
  observeWebviews,
  requireEngine,
  useExtensionCache,
} from './data';
import type { WebviewRecord } from './data';
import { Desktop } from './desktop';
import { HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
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
    readonly latest: number;
    readonly more: boolean;
    readonly snapshots: {
      id: number;
      author: string | null;
      commitMessage: string | null;
      changes: unknown[];
    }[];
  };
}

/** The activity that the extension posted to a page. */
const sentTo = (record: WebviewRecord): Sent[] =>
  record.messages.filter(
    (message): message is Sent =>
      typeof message === 'object' && message !== null && 'type' in message && message.type === 'activity',
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

describe('Activity', () => {
  let tree: CatalogTree;
  let desktop: Desktop;
  let webviews: WebviewRecord[];
  let id: string;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
    webviews = observeWebviews();
    id = uniqueId('activity');
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

  /** Opens the report from a node (the connection by default) and waits for the page to ask for and get its data. */
  async function open(node: Promise<unknown> = connection()): Promise<WebviewRecord> {
    await vscode.commands.executeCommand('aantje.showActivity', await node);
    const panel = webviews.findLast(({ viewType }) => viewType === 'aantje.activity');
    assert.ok(panel);
    await waitFor('the report page to ask for its data and get it', () => sentTo(panel).length > 0);
    return panel;
  }

  it('opens a tab for the connection, reads the snapshots under a progress, and sends them when the page asks', async () => {
    const panel = await open();

    assert.equal(tabs('aantje.activity').length, 1);
    assert.deepEqual(
      webviews.map(({ viewType }) => viewType),
      ['aantje.activity'],
    );
    assert.equal(desktop.progress.length, 1);
    const [message] = sentTo(panel);
    assert.deepEqual(
      [message?.data.connection, message?.data.latest, message?.data.more],
      ['Lake', HISTORY_LATEST_SNAPSHOT, false],
    );
    assert.deepEqual(
      message?.data.snapshots.map(({ id: snapshot }) => snapshot),
      Array.from({ length: HISTORY_LATEST_SNAPSHOT + 1 }, (_, index) => HISTORY_LATEST_SNAPSHOT - index),
    );
    const nightly = message?.data.snapshots.find(({ id: snapshot }) => snapshot === 25);
    assert.deepEqual([nightly?.author, nightly?.commitMessage], ['tillmann', 'Nightly import']);
    assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
  });

  it('opens a tab of its own for a schema with the snapshots that changed the schema', async () => {
    await open();
    const panel = await open(nodeAt(tree, 'Lake', 'main'));

    assert.equal(tabs('aantje.activity').length, 2);
    const data = sentTo(panel)[0]?.data ?? assert.fail('no data');
    assert.equal(data.scope.kind === 'schema' && data.scope.name, 'main');
    // main: created at snapshot 0, its table evolving (later evolved) created at 26 and changed up to 36.
    assert.deepEqual(
      data.snapshots.map(({ id: snapshot }) => snapshot),
      [36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26, 0],
    );
  });

  it('does nothing for a table, a folder, a snapshot or a call without a node', async () => {
    for (const path of [
      ['shop', 'Tables', 'events'],
      ['shop', 'Tables', 'events', 'History'],
      ['Snapshots'],
    ]) {
      await vscode.commands.executeCommand('aantje.showActivity', await nodeAt(tree, 'Lake', ...path));
    }
    await vscode.commands.executeCommand('aantje.showActivity');

    assert.deepEqual([desktop.progress, webviews, desktop.errors, desktop.infos], [[], [], [], []]);
  });

  describe('the actions of the detail pane', () => {
    it('shows the catalog at the snapshot in the tree', async () => {
      const panel = await open();

      await pressButton(panel, { type: 'action', action: 'showCatalog', snapshot: 25 });

      assert.equal(tree.state(id).snapshot, 25);
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });

    it('opens the snapshot report of the connection of the panel, not of the first connection in the tree', async () => {
      await setConnections([
        {
          id: uniqueId('activity-other'),
          name: 'Other',
          kind: 'sqlite',
          path: copyFixture('history/history.sqlite'),
        },
        { id, name: 'Lake', kind: 'sqlite', path: copyFixture('history/history.sqlite') },
      ]);
      await vscode.commands.executeCommand('aantje.connect', await connection());
      const panel = await open();

      await pressButton(panel, { type: 'action', action: 'showSnapshotReport' });
      await waitFor('the snapshot report', () => tabs('aantje.snapshotReport').length > 0);

      assert.deepEqual(tabs('aantje.snapshotReport'), ['Snapshot Report · Lake']);
      assert.equal(tabs('aantje.activity').length, 1);
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });

    it('opens the report of the comparison of two snapshots in a document', async () => {
      const panel = await open();
      const before = new Set(untitledDocuments());

      await pressButton(panel, {
        type: 'action',
        action: 'compareSnapshots',
        snapshot: 35,
        against: 'previous',
      });
      const document = await waitFor('the report document', () =>
        untitledDocuments().find((candidate) => !before.has(candidate)),
      );

      assert.equal(document.languageId, 'markdown');
      assert.match(document.getText(), /@34 to @35/);
      assert.match(document.getText(), /`main.evolving` is now `main.evolved`/);
    });

    it('ignores a request that the data does not offer, one with a command in it, and one it does not know', async () => {
      const panel = await open();
      const before = [tree.state(id).snapshot, untitledDocuments().length, gridTabs().length];
      const asked = desktop.progress.length;

      for (const request of [
        { type: 'action', action: 'showCatalog', snapshot: 999 },
        { type: 'action', action: 'rowsChanged', snapshot: 55, table: 19 },
        { type: 'action', action: 'rowsChanged', snapshot: 45, table: 15 },
        { type: 'action', action: 'compareSnapshots', snapshot: 0, against: 'previous' },
        { type: 'action', action: 'compareSnapshots', snapshot: 5, against: 'other' },
        { type: 'action', action: 'query', snapshot: 23, table: 3 },
        { type: 'action', action: 'workbench.action.quit' },
        { type: 'action', action: 'showCatalog', snapshot: 23, command: 'aantje.removeConnection' },
        { type: 'command', command: 'aantje.removeConnection' },
        'showCatalog',
        null,
      ]) {
        await pressButton(panel, request);
      }

      assert.deepEqual([tree.state(id).snapshot, untitledDocuments().length, gridTabs().length], before);
      assert.equal(desktop.progress.length, asked, 'nothing was read for the requests');
      assert.deepEqual([desktop.errors, desktop.infos, desktop.picks], [[], [], []]);
      assert.deepEqual(tabs('aantje.snapshotReport'), []);
      assert.equal(tree.roots().length, 1, 'the connection is still there');
    });

    it('reads the snapshots again when the page asks for it', async () => {
      const panel = await open();
      const progress = desktop.progress.length;

      await pressButton(panel, { type: 'refresh' });

      await waitFor('the second data', () => sentTo(panel).length === 2);
      assert.equal(desktop.progress.length, progress + 1, 'the snapshots were read under a progress again');
      assert.deepEqual(sentTo(panel)[1]?.data, sentTo(panel)[0]?.data);
      assert.equal(webviews.length, 1);
    });
  });
});

describe('Activity: actions that read table data', function () {
  before(async function () {
    await requireEngine(this);
  });

  let tree: CatalogTree;
  let desktop: Desktop;
  let webviews: WebviewRecord[];
  let name: string;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
    webviews = observeWebviews();
    await useExtensionCache();
    const { profile } = await copyHistoryDataFixture('sqlite');
    ({ name } = profile);
    await setConnections([profile]);
    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, name));
    onTeardownAsync(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
  });

  afterEach(() => {
    desktop.assertDone();
  });

  it('shows the rows that a snapshot changed in the grid of the table', async () => {
    await vscode.commands.executeCommand('aantje.showActivity', await nodeAt(tree, name));
    const [report] = webviews;
    assert.ok(report);
    await waitFor('the report page to ask for its data and get it', () => sentTo(report).length > 0);

    await pressButton(report, { type: 'action', action: 'rowsChanged', snapshot: 23, table: 9 });
    const grid = await waitFor('the grid panel', () => webviews[1]);
    await waitFor('the grid data', () => dataMessages(grid).length > 0);

    assert.deepEqual(gridTabs(), [`shop.customers changes @22 → @23 · ${name}`]);
    assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
  });
});
