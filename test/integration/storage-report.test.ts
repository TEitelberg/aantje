import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import { storageMarkdown } from '../../src/storage-report/markdown';
import type { StorageData } from '../../src/storage-report/model';
import type { CatalogTree } from '../../src/tree/model';
import { HISTORY_FILES_AT, HISTORY_ID, HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import { observeWebviews } from './data';
import type { WebviewRecord } from './data';
import { Desktop } from './desktop';
import {
  activate,
  assertDryRunFirst,
  copyFixture,
  extension,
  nodeAt,
  onTeardownAsync,
  setConnections,
  uniqueId,
  waitFor,
} from './support';

interface Manifest {
  readonly contributes: {
    readonly commands: readonly { command: string; title: string; category?: string }[];
    readonly menus: Record<string, readonly { command?: string; when?: string }[]>;
  };
}

const manifest = (): Manifest['contributes'] => (extension().packageJSON as Manifest).contributes;

interface Sent {
  readonly type: string;
  readonly data: StorageData;
}

/** The Storage data that the extension posted to a page. */
const sentTo = (record: WebviewRecord): Sent[] =>
  record.messages.filter(
    (message): message is Sent =>
      typeof message === 'object' && message !== null && 'type' in message && message.type === 'storage',
  );

/** What the page does when a button is pressed: it posts the request to the extension. */
async function post(record: WebviewRecord, request: unknown): Promise<void> {
  assert.ok(record.receivers.length > 0, 'the extension listens to the page');
  for (const receiver of record.receivers) {
    await receiver(request);
  }
}

const untitledDocuments = (): vscode.TextDocument[] =>
  vscode.workspace.textDocuments.filter((document) => document.isUntitled);

const tabsOf = (viewType: string): string[] =>
  vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(viewType))
    .map((tab) => tab.label);

describe('the Storage report', () => {
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
    id = uniqueId('storage');
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

  /** Opens the panel of the connection and waits for the page to ask for and get its data. */
  async function open(): Promise<WebviewRecord> {
    await vscode.commands.executeCommand('aantje.showStorage', await connection());
    const panel = webviews.filter(({ viewType }) => viewType === 'aantje.storage').at(-1);
    assert.ok(panel);
    await waitFor('the storage page to ask for its data and get it', () => sentTo(panel).length > 0);
    return panel;
  }

  /** Posts the request and returns the SQL document it opened. */
  async function opensDocument(panel: WebviewRecord, request: unknown): Promise<vscode.TextDocument> {
    const before = new Set(untitledDocuments());
    await post(panel, request);
    await waitFor('the document', () => untitledDocuments().some((document) => !before.has(document)));
    const document = untitledDocuments().find((candidate) => !before.has(candidate));
    assert.ok(document);
    onTeardownAsync(async () => {
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    });
    return document;
  }

  describe('the command', () => {
    it('is Show Storage Report, needs a node, and is in the Reports submenu of an open connection', () => {
      const { commands, menus } = manifest();
      assert.deepEqual(
        commands
          .filter(({ command }) => command === 'aantje.showStorage')
          .map(({ title, category }) => [title, category]),
        [['Storage Report', 'aantje']],
      );
      assert.ok(
        (menus.commandPalette ?? []).some(
          ({ command, when }) => command === 'aantje.showStorage' && when === 'false',
        ),
        'hidden from the Command Palette',
      );
      assert.ok(
        (menus['aantje.reports'] ?? []).some(
          ({ command, when }) =>
            command === 'aantje.showStorage' && when === 'viewItem =~ /^connection\\.connected(\\.azure)?$/',
        ),
      );
    });

    it('opens a panel instead of a Markdown document, and sends the storage of the shown snapshot when the page asks', async () => {
      await connect();
      const documents = untitledDocuments().length;

      const panel = await open();

      assert.deepEqual(tabsOf('aantje.storage'), ['Storage · Lake']);
      assert.deepEqual(
        webviews.map(({ viewType, title }) => ({ viewType, title })),
        [{ viewType: 'aantje.storage', title: 'Storage · Lake' }],
      );
      assert.equal(untitledDocuments().length, documents, 'no document was opened');
      const [message] = sentTo(panel);
      assert.equal(message?.data.connection, 'Lake');
      assert.equal(message?.data.snapshot, HISTORY_LATEST_SNAPSHOT);
      assert.equal(message?.data.storage.dataFiles.count, HISTORY_FILES_AT[56][0]);
      assert.equal(message?.data.storage.deleteFiles.count, HISTORY_FILES_AT[56][1]);
      assert.equal(message?.data.tableCount, 7);
      assert.deepEqual(message?.data.tables[0]?.name, 'events');
      assert.equal(message?.data.growth.length, 17);
      assert.match(message?.data.readAt ?? '', /^\d{4}-\d\d-\d\dT/);
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });

    it('loads the shared page script under a strict content security policy from the dist folder only', async () => {
      await connect();
      const { panel } = await open();

      assert.match(panel.webview.html, /report-client\.js/);
      assert.match(panel.webview.html, /default-src 'none'/);
      assert.deepEqual(
        (panel.webview.options.localResourceRoots ?? []).map((root) => root.fsPath),
        [vscode.Uri.joinPath(extension().extensionUri, 'dist').fsPath],
      );
    });

    it('reads the snapshot that the tree shows, and the connection whose node was used', async () => {
      await connect();
      tree.selectSnapshot(id, 17);

      const panel = await open();

      const { data } = sentTo(panel)[0] ?? assert.fail('no data');
      assert.equal(data.snapshot, 17);
      assert.equal(data.storage.dataFiles.count, HISTORY_FILES_AT[17][0]);
      assert.equal(data.storage.deleteFiles.count, HISTORY_FILES_AT[17][1]);
      assert.equal(data.growth.at(-1)?.snapshot, 17);
    });

    it('shows the same panel again with fresh data, and reads the snapshot that the tree shows then', async () => {
      await connect();
      const panel = await open();

      tree.selectSnapshot(id, 17);
      await vscode.commands.executeCommand('aantje.showStorage', await connection());
      await waitFor('the second data', () => sentTo(panel).length === 2);

      assert.equal(webviews.length, 1, 'no second panel was created');
      assert.deepEqual(
        sentTo(panel).map(({ data }) => data.snapshot),
        [56, 17],
      );
    });

    it('opens a new panel after the user closed the old one', async () => {
      await connect();
      const first = await open();
      first.panel.dispose();
      await waitFor('the tab to close', () => tabsOf('aantje.storage').length === 0);

      const second = await open();

      assert.notEqual(second, first);
      assert.deepEqual(tabsOf('aantje.storage'), ['Storage · Lake']);
    });

    it('says to connect first when the connection is not open, and opens no panel and no document', async () => {
      const documents = untitledDocuments().length;

      await vscode.commands.executeCommand('aantje.showStorage', await connection());

      assert.deepEqual(desktop.infos, ['Connect to a catalog first to show its storage.']);
      assert.deepEqual(webviews, []);
      assert.equal(untitledDocuments().length, documents);
    });
  });

  describe('Refresh', () => {
    it('reads the catalog again at the snapshot that the tree shows now', async () => {
      await connect();
      const panel = await open();
      tree.selectSnapshot(id, 17);

      await post(panel, { type: 'refresh' });

      await waitFor('the second data', () => sentTo(panel).length === 2);
      assert.deepEqual(
        sentTo(panel).map(({ data }) => data.snapshot),
        [56, 17],
      );
      assert.equal(webviews.length, 1);
    });

    it('says that the connection was removed when a refresh comes after it, and that it is closed when it was disconnected', async () => {
      await connect();
      const panel = await open();

      await tree.disconnect(id);
      await post(panel, { type: 'refresh' });
      await setConnections([]);
      await post(panel, { type: 'refresh' });

      await waitFor('both hints', () => desktop.infos.length === 2);
      assert.deepEqual(desktop.infos, [
        'Connect to a catalog first to show its storage.',
        'The connection of this storage report was removed. Close the report.',
      ]);
      assert.deepEqual(desktop.errors, []);
      assert.equal(sentTo(panel).length, 1, 'nothing was read');
    });
  });

  describe('the actions of a table', () => {
    it('Show Statistics opens the statistics report of the table at the snapshot of the report, not of the tree', async () => {
      await connect();
      const panel = await open();
      tree.selectSnapshot(id, 17);

      await post(panel, { type: 'action', action: 'showStatistics', table: HISTORY_ID.events });

      await waitFor('the statistics report', () =>
        webviews.some(({ viewType }) => viewType === 'aantje.statistics'),
      );
      const statisticsPanel = webviews.find(({ viewType }) => viewType === 'aantje.statistics');
      assert.equal(statisticsPanel?.title, 'Statistics of shop.events @56 · Lake');
      await waitFor('the statistics', () => (statisticsPanel?.messages.length ?? 0) > 0);
    });

    it('Show in Tree selects the table in the explorer', async () => {
      await connect();
      const panel = await open();

      await post(panel, { type: 'action', action: 'revealTable', table: HISTORY_ID.customers });

      await waitFor('the table to be selected', () =>
        api.view.selection.some((node) => node.ref.kind === 'table'),
      );
      const [node] = api.view.selection;
      assert.deepEqual(
        [node?.ref.kind, node?.ref.kind === 'table' ? node.ref.table.name : undefined],
        ['table', 'customers'],
      );
    });

    it('Show in Tree says so when the tree shows a snapshot where the table does not exist', async () => {
      await connect();
      const panel = await open();
      tree.selectSnapshot(id, 3);

      await post(panel, { type: 'action', action: 'revealTable', table: HISTORY_ID.events });

      await waitFor('the hint', () => desktop.infos.length === 1);
      assert.deepEqual(desktop.infos, [
        'The tree does not show "shop.events". It may not exist at the snapshot that the tree shows.',
      ]);
      assert.deepEqual(
        api.view.selection.filter((node) => node.ref.kind === 'table'),
        [],
      );
    });

    for (const [action, call] of [
      ['scriptMerge', "CALL ducklake_merge_adjacent_files('lake', 'events', schema => 'shop');"],
      ['scriptRewrite', "CALL ducklake_rewrite_data_files('lake', 'events', schema => 'shop');"],
    ] as const) {
      it(`${action} opens the script for the table in a SQL document of the connection, and runs nothing`, async () => {
        await connect();
        const panel = await open();

        const document = await opensDocument(panel, { type: 'action', action, table: HISTORY_ID.events });

        assert.equal(document.languageId, 'sql');
        assert.deepEqual(
          document
            .getText()
            .split('\n')
            .filter((line) => line.startsWith('CALL ')),
          [call],
        );
        const key = document.uri.toString();
        await waitFor('the document to belong to the connection', () => api.editors.connectionOf(key) === id);
        assert.deepEqual(
          [api.editors.state(key)?.running, api.editors.state(key)?.sessionOpen],
          [false, false],
        );
        assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
      });
    }
  });

  describe('the actions of the lake', () => {
    for (const [action, procedure] of [
      ['scriptCleanup', 'ducklake_cleanup_old_files'],
      ['scriptExpire', 'ducklake_expire_snapshots'],
    ] as const) {
      it(`${action} opens a script that starts with a dry run and keeps the real call commented out`, async () => {
        await connect();
        const panel = await open();

        const document = await opensDocument(panel, { type: 'action', action });

        assertDryRunFirst(document.getText(), procedure);
        const key = document.uri.toString();
        await waitFor('the document to belong to the connection', () => api.editors.connectionOf(key) === id);
        assert.equal(api.editors.state(key)?.running, false);
      });
    }

    it('a script belongs to its connection already when its editor first becomes active', async () => {
      await connect();
      const panel = await open();
      const seen: (string | undefined)[] = [];
      const listener = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === 'sql') {
          seen.push(api.editors.connectionOf(editor.document.uri.toString()));
        }
      });
      try {
        await opensDocument(panel, { type: 'action', action: 'scriptCleanup' });
        await waitFor('the editor of the script to become active', () => seen.length > 0);
      } finally {
        listener.dispose();
      }
      assert.deepEqual(seen, [id]);
    });

    it('Properties opens the Properties panel of the connection', async () => {
      await connect();
      const panel = await open();

      await post(panel, { type: 'action', action: 'showProperties' });

      await waitFor('the Properties panel', () => tabsOf('aantje.properties').length === 1);
      assert.deepEqual(tabsOf('aantje.properties'), ['Properties · Lake']);
    });
  });

  describe('the Properties panel', () => {
    it('offers Show Storage Report, and the button opens the Storage panel', async () => {
      await connect();
      await vscode.commands.executeCommand('aantje.showProperties', await connection());
      const properties = webviews.find(({ viewType }) => viewType === 'aantje.properties');
      assert.ok(properties);
      await waitFor('the properties data', () => properties.messages.length > 0);
      assert.deepEqual((properties.messages[0] as { data: { actions: string[] } }).data.actions, [
        'showStorage',
      ]);

      await post(properties, { type: 'action', action: 'showStorage' });

      await waitFor('the Storage panel', () => tabsOf('aantje.storage').length === 1);
      assert.deepEqual(tabsOf('aantje.storage'), ['Storage · Lake']);
    });
  });

  describe('requests that the data does not offer', () => {
    it('are ignored: a table that was not sent, a command id, a field that nobody declared, text for the document', async () => {
      await connect();
      const panel = await open();
      const documents = untitledDocuments().length;
      const panels = webviews.length;

      await post(panel, { type: 'action', action: 'scriptMerge', table: 9999 });
      await post(panel, { type: 'action', action: 'showStatistics', table: 9999 });
      await post(panel, { type: 'action', action: 'revealTable', table: 9999 });
      await post(panel, {
        type: 'action',
        action: 'scriptMerge',
        table: HISTORY_ID.events,
        sql: 'DROP TABLE x',
      });
      await post(panel, { type: 'action', action: 'aantje.removeConnection' });
      await post(panel, { type: 'run', command: 'aantje.removeConnection' });
      await post(panel, { type: 'markdown', markdown: '# written by the page' });
      await post(panel, { type: 'markdown', view: { filter: 3 } });

      assert.deepEqual([desktop.errors, desktop.infos, desktop.confirmations], [[], [], []]);
      assert.equal(untitledDocuments().length, documents);
      assert.equal(webviews.length, panels);
      assert.equal(tree.roots().length, 1);
    });
  });

  describe('Open as Markdown', () => {
    async function opensMarkdown(panel: WebviewRecord, request: unknown): Promise<vscode.TextDocument> {
      const document = await opensDocument(panel, request);
      await waitFor(
        'the document in the editor',
        () => vscode.window.activeTextEditor?.document === document,
      );
      return document;
    }

    it('opens the report as an untitled Markdown document built from the data the extension holds, with the filter that the page names', async () => {
      await connect();
      const panel = await open();
      const data = sentTo(panel)[0]?.data;
      assert.ok(data);

      const whole = await opensMarkdown(panel, { type: 'markdown' });
      assert.equal(whole.languageId, 'markdown');
      assert.equal(whole.getText(), storageMarkdown(data));
      assert.equal(whole.getText().split('\n')[0], '# Storage of Lake');
      assert.ok(whole.getText().includes('| `shop.events` | 9 | 6.2 KB | 52 |'));

      const filtered = await opensMarkdown(panel, { type: 'markdown', view: { filter: 'custom' } });
      assert.equal(filtered.getText(), storageMarkdown(data, { filter: 'custom' }));
      assert.ok(filtered.getText().includes('Filter: `custom`. 1 of 7 tables match.'));
    });
  });
});
