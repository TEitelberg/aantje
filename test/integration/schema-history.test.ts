import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { CatalogTree } from '../../src/tree/model';
import { observeWebviews } from './data';
import type { WebviewRecord } from './data';
import { Desktop } from './desktop';
import { HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import {
  activate,
  copyFixture,
  extension,
  nodeAt,
  onTeardownAsync,
  setConnections,
  statusBar,
  uniqueId,
  waitFor,
} from './support';

interface Manifest {
  readonly contributes: {
    readonly commands: readonly { command: string; title: string; category?: string; icon?: string }[];
    readonly menus: Record<string, readonly { command?: string; when?: string; group?: string }[]>;
  };
}

const manifest = (): Manifest['contributes'] => (extension().packageJSON as Manifest).contributes;

/** The labels of the open tabs that hold a Schema History report. */
function historyTabs(): string[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('aantje.schemaHistory'),
    )
    .map((tab) => tab.label);
}

interface Sent {
  readonly type: string;
  readonly data: {
    readonly connection: string;
    readonly tableId: number;
    readonly schema: string | null;
    readonly name: string;
    readonly latest: number;
    readonly exists: boolean;
    readonly more: boolean;
    readonly snapshots: { id: number; previous: number | null; exists: boolean }[];
    readonly columns: { id: number; path: string[]; formerNames: string[]; now: string | null }[];
  };
}

/** The histories that the extension posted to a page. */
const sentTo = (record: WebviewRecord): Sent[] =>
  record.messages.filter(
    (message): message is Sent =>
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'schemaHistory',
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

function diffTabs(): { label: string; original: vscode.Uri; modified: vscode.Uri }[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .flatMap((tab) =>
      tab.input instanceof vscode.TabInputTextDiff
        ? [{ label: tab.label, original: tab.input.original, modified: tab.input.modified }]
        : [],
    );
}

const TITLE = 'Schema History of main.evolved · Lake';

describe('Show Schema History', () => {
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
    id = uniqueId('schema-history');
    await setConnections([{ id, name: 'Lake', kind: 'sqlite', path: copyFixture('history/history.sqlite') }]);
    onTeardownAsync(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
  });

  afterEach(() => {
    desktop.assertDone();
  });

  const connection = () => nodeAt(tree, 'Lake');
  const connect = async () => vscode.commands.executeCommand('aantje.connect', await connection());
  const table = (name = 'evolved', schema = 'main') => nodeAt(tree, 'Lake', schema, 'Tables', name);

  /** Opens the report of a table and waits for the page to ask for and get its data. */
  async function open(name = 'evolved', schema = 'main'): Promise<WebviewRecord> {
    await vscode.commands.executeCommand('aantje.showSchemaHistory', await table(name, schema));
    const panel = webviews.at(-1);
    assert.ok(panel);
    await waitFor('the report page to ask for its data and get it', () => sentTo(panel).length > 0);
    return panel;
  }

  describe('declaration', () => {
    it('is a command of the category aantje that the Command Palette does not offer', () => {
      const declared = manifest().commands.find(({ command }) => command === 'aantje.showSchemaHistory');
      assert.deepEqual([declared?.title, declared?.category], ['Schema History', 'aantje']);
      const hidden = (manifest().menus.commandPalette ?? [])
        .filter(({ when }) => when === 'false')
        .map(({ command }) => command);
      assert.ok(hidden.includes('aantje.showSchemaHistory'));
    });

    it('is in the Reports submenu of a table and nowhere else', () => {
      const menus = Object.entries(manifest().menus).flatMap(([menu, entries]) =>
        entries
          .filter(({ command }) => command === 'aantje.showSchemaHistory')
          .map(({ when, group }) => [menu, when, group]),
      );
      assert.deepEqual(menus, [
        ['commandPalette', 'false', undefined],
        ['aantje.reports', 'viewItem == table', '2_table@2'],
      ]);
    });
  });

  describe('opening the report', () => {
    beforeEach(connect);

    it('opens a tab for the table, reads the history with a progress that can be cancelled, and sends it when the page asks', async () => {
      const panel = await open();

      assert.deepEqual(historyTabs(), [TITLE]);
      assert.deepEqual(
        webviews.map(({ viewType, title }) => ({ viewType, title })),
        [{ viewType: 'aantje.schemaHistory', title: TITLE }],
      );
      assert.deepEqual(desktop.progress, ['Reading the schema history of main.evolved...']);
      assert.match(panel.panel.webview.html, /report-client\.js/);
      assert.match(panel.panel.webview.html, /\.matrix \{/, 'the stylesheet of the report is in the page');
      const [message] = sentTo(panel);
      assert.deepEqual(
        [
          message?.data.connection,
          message?.data.tableId,
          message?.data.schema,
          message?.data.name,
          message?.data.latest,
          message?.data.exists,
          message?.data.more,
        ],
        ['Lake', 12, 'main', 'evolved', HISTORY_LATEST_SNAPSHOT, true, false],
      );
      assert.deepEqual(
        message?.data.snapshots.map(({ id: snapshot, previous }) => [snapshot, previous]),
        [
          [26, null],
          [28, 26],
          [29, 28],
          [30, 29],
          [31, 30],
          [32, 31],
          [33, 32],
          [34, 33],
          [35, 34],
        ],
      );
      assert.deepEqual(
        message?.data.columns.map(({ path, formerNames, now }) => [path.join('.'), formerNames, now]),
        [
          ['id', [], 'int32'],
          ['title', ['name'], 'varchar'],
          ['info', [], 'struct'],
          ['info.a', [], 'int32'],
          ['info.b', [], 'varchar'],
          ['info.c', [], 'float64'],
          ['n', [], 'int64'],
          ['flag', [], 'boolean'],
          ['extra', [], null],
        ],
      );
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });

    it('shows the same panel again, with fresh data, when it is opened again, and one panel for each table', async () => {
      const panel = await open();

      await vscode.commands.executeCommand('aantje.showSchemaHistory', await table());
      await waitFor('the second data', () => sentTo(panel).length === 2);
      assert.equal(webviews.length, 1, 'no second panel was created');
      assert.deepEqual(sentTo(panel)[1]?.data, sentTo(panel)[0]?.data);

      await open('customers', 'shop');
      assert.equal(webviews.length, 2);
      assert.deepEqual(historyTabs().toSorted(), [TITLE, 'Schema History of shop.customers · Lake']);
    });

    it('opens the same panel for the History leaf of a table as for the table itself, which is what a click on the leaf runs', async () => {
      const panel = await open();
      const leaf = await nodeAt(tree, 'Lake', 'main', 'Tables', 'evolved', 'History');

      assert.equal(leaf.command?.id, 'aantje.showSchemaHistory');
      await vscode.commands.executeCommand(leaf.command.id, leaf);
      await waitFor('the second data', () => sentTo(panel).length === 2);

      assert.equal(webviews.length, 1, 'no second panel was created');
      assert.deepEqual(historyTabs(), [TITLE]);
      assert.deepEqual(sentTo(panel)[1]?.data, sentTo(panel)[0]?.data);
    });

    it('opens the report of the table of a History leaf when no report is open yet', async () => {
      await vscode.commands.executeCommand(
        'aantje.showSchemaHistory',
        await nodeAt(tree, 'Lake', 'shop', 'Tables', 'customers', 'History'),
      );
      const [panel] = webviews;
      assert.ok(panel);
      await waitFor('the data', () => sentTo(panel).length === 1);

      assert.deepEqual(historyTabs(), ['Schema History of shop.customers · Lake']);
    });

    it('makes the connection of the report the active one', async () => {
      await setConnections([
        {
          id: uniqueId('schema-history-other'),
          name: 'Other',
          kind: 'sqlite',
          path: copyFixture('history/history.sqlite'),
        },
        { id, name: 'Lake', kind: 'sqlite', path: copyFixture('history/history.sqlite') },
      ]);
      await connect();
      await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, 'Other'));
      await waitFor('"Other" in the status bar', () => statusBar().text.startsWith('$(database) Other'));

      await open();

      await waitFor('"Lake" in the status bar', () => statusBar().text.startsWith('$(database) Lake'));
    });

    it('opens a new panel after the user closed the tab', async () => {
      const first = await open();

      first.panel.dispose();
      await waitFor('the tab to close', () => historyTabs().length === 0);
      await vscode.commands.executeCommand('aantje.showSchemaHistory', await table());

      const second = webviews[1];
      assert.ok(second, 'a second panel was created');
      await waitFor('the data of the new panel', () => sentTo(second).length === 1);
      assert.deepEqual(historyTabs(), [TITLE]);
    });

    it('does nothing for a connection, a schema, the folders, a snapshot or a call without a node', async () => {
      for (const path of [
        [],
        ['main'],
        ['main', 'Tables'],
        ['main', 'Tables', 'evolved', 'Columns'],
        ['main', 'Tables', 'evolved', 'Statistics'],
        ['Snapshots'],
      ]) {
        await vscode.commands.executeCommand('aantje.showSchemaHistory', await nodeAt(tree, 'Lake', ...path));
      }
      await vscode.commands.executeCommand('aantje.showSchemaHistory');

      assert.deepEqual([desktop.progress, webviews, desktop.errors, desktop.infos], [[], [], [], []]);
    });

    it('asks to connect first when the connection is closed after the node was taken', async () => {
      const node = await table();
      await tree.disconnect(id);

      await vscode.commands.executeCommand('aantje.showSchemaHistory', node);

      assert.deepEqual(desktop.infos, ['Connect to a catalog first to show the schema history.']);
      assert.deepEqual([desktop.progress, webviews], [[], []]);
    });
  });

  describe('the actions of the detail pane', () => {
    beforeEach(connect);

    it('shows the catalog at the snapshot in the tree', async () => {
      const panel = await open();

      await pressButton(panel, { type: 'action', action: 'showCatalog', snapshot: 30 });

      assert.equal(tree.state(id).snapshot, 30);
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });

    it('opens the diff editor over the CREATE TABLE of the table at the snapshot and the version before it', async () => {
      const panel = await open();

      await pressButton(panel, {
        type: 'action',
        action: 'compareSchema',
        snapshot: 30,
        against: 'previous',
      });
      const [tab] = await waitFor('the diff editor', () => {
        const tabs = diffTabs();
        return tabs.length > 0 ? tabs : undefined;
      });

      assert.equal(tab?.label, 'main.evolving: @29 ↔ @30');
      assert.deepEqual(
        [tab?.original, tab?.modified].map((uri) => `${uri?.scheme}:${uri?.path}?${uri?.query}`),
        [`aantje-schema:/12@29.sql?${id}`, `aantje-schema:/12@30.sql?${id}`],
      );
      await waitFor('the summary', () => desktop.infos.length > 0);
      assert.deepEqual(desktop.infos, ['1 column type changed between @29 and @30']);
    });

    it('compares with the newest snapshot', async () => {
      const panel = await open();

      await pressButton(panel, { type: 'action', action: 'compareSchema', snapshot: 28, against: 'latest' });
      const [tab] = await waitFor('the diff editor', () => {
        const tabs = diffTabs();
        return tabs.length > 0 ? tabs : undefined;
      });

      assert.equal(tab?.label, 'main.evolved: @28 ↔ @56');
      await waitFor('the summary', () => desktop.infos.length > 0);
    });

    it('opens the ALTER template of the newest state in an SQL document of the connection, and runs nothing', async () => {
      const panel = await open();
      const before = new Set(untitledDocuments());

      await pressButton(panel, { type: 'action', action: 'scriptAlter' });
      const document = await waitFor('the SQL document', () =>
        untitledDocuments().find((candidate) => !before.has(candidate)),
      );

      assert.equal(document.languageId, 'sql');
      const text = document.getText();
      assert.match(text, /^-- ALTER TABLE "main"\."evolved" RENAME TO <new_name>;$/m);
      assert.match(text, /^-- ALTER TABLE "main"\."evolved" RENAME COLUMN "title" TO <new_name>;$/m);
      assert.ok(!text.includes('"extra"'), 'the dropped column is not in the newest state');
      assert.deepEqual(
        text.split('\n').filter((line) => line !== '' && !line.startsWith('--')),
        [],
        'every statement is a comment',
      );
      await waitFor(
        'the document to belong to the connection',
        () => api.editors.connectionOf(document.uri.toString()) === id,
      );
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });

    it('ignores a request that the data does not offer, one with a command in it, and one it does not know', async () => {
      const panel = await open();
      const before = [tree.state(id).snapshot, untitledDocuments().length, diffTabs().length];
      const asked = desktop.progress.length;

      for (const request of [
        { type: 'action', action: 'showCatalog', snapshot: 999 },
        { type: 'action', action: 'showCatalog', snapshot: 27 },
        { type: 'action', action: 'compareSchema', snapshot: 26, against: 'previous' },
        { type: 'action', action: 'compareSchema', snapshot: 35, against: 'other' },
        { type: 'action', action: 'query', snapshot: 999 },
        { type: 'action', action: 'workbench.action.quit' },
        { type: 'action', action: 'showCatalog', snapshot: 30, command: 'aantje.removeConnection' },
        { type: 'command', command: 'aantje.removeConnection' },
        'scriptAlter',
        null,
      ]) {
        await pressButton(panel, request);
      }

      assert.deepEqual([tree.state(id).snapshot, untitledDocuments().length, diffTabs().length], before);
      assert.equal(desktop.progress.length, asked, 'nothing was read for the requests');
      assert.deepEqual([desktop.errors, desktop.infos, desktop.picks], [[], [], []]);
      assert.equal(tree.roots().length, 1, 'the connection is still there');
    });

    it('reads the history again when the page asks for it, for the table that the report shows', async () => {
      const panel = await open();
      const progress = desktop.progress.length;

      await pressButton(panel, { type: 'refresh' });

      await waitFor('the second data', () => sentTo(panel).length === 2);
      assert.equal(desktop.progress.length, progress + 1, 'the history was read under a progress again');
      assert.deepEqual(sentTo(panel)[1]?.data, sentTo(panel)[0]?.data);
      assert.equal(webviews.length, 1);
    });

    it('says that the connection was removed when an action or a refresh comes after it', async () => {
      const panel = await open();
      await setConnections([]);

      await pressButton(panel, { type: 'action', action: 'showCatalog', snapshot: 30 });
      await pressButton(panel, { type: 'refresh' });

      assert.deepEqual(desktop.infos, [
        'The connection of this schema history was removed. Close the report.',
        'The connection of this schema history was removed. Close the report.',
      ]);
      assert.deepEqual(desktop.errors, []);
      assert.equal(sentTo(panel).length, 1, 'nothing was read');
    });

    it('tells the user to connect again when the connection was closed after the report was opened', async () => {
      const panel = await open();
      await tree.disconnect(id);

      await pressButton(panel, { type: 'action', action: 'showCatalog', snapshot: 30 });

      assert.deepEqual(desktop.errors, [
        'The connection is closed. Connect again to use the schema history.',
      ]);
    });
  });
});
