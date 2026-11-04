import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import * as vscode from 'vscode';
import { propertiesMarkdown } from '../../src/properties';
import type { CatalogProperties } from '../../src/catalog/model';
import type { CatalogTree } from '../../src/tree/model';
import { HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import { observeWebviews } from './data';
import type { WebviewRecord } from './data';
import { Desktop } from './desktop';
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

interface Sent {
  readonly type: string;
  readonly data: {
    readonly connection: string;
    readonly properties: CatalogProperties;
    readonly actions: string[];
  };
}

/** The Properties data that the extension posted to a page. */
const sentTo = (record: WebviewRecord): Sent[] =>
  record.messages.filter(
    (message): message is Sent =>
      typeof message === 'object' && message !== null && 'type' in message && message.type === 'properties',
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

/** Another process commits to the catalog file: statements run on a copy of the file that is written back. */
async function editCatalog(path: string, statements: string[]): Promise<void> {
  const wasm = readFileSync(join(extension().extensionPath, 'dist', 'sql-wasm.wasm'));
  const SQL = await initSqlJs({
    wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
  });
  const db = new SQL.Database(readFileSync(path));
  statements.forEach((statement) => db.run(statement));
  writeFileSync(path, db.export());
  db.close();
}

describe('the report shell', () => {
  let tree: CatalogTree;
  let desktop: Desktop;
  let webviews: WebviewRecord[];
  let id: string;
  let file: string;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
    webviews = observeWebviews();
    id = uniqueId('shell');
    file = copyFixture('history/history.sqlite');
    await setConnections([{ id, name: 'Lake', kind: 'sqlite', path: file }]);
    onTeardownAsync(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
  });

  afterEach(() => {
    desktop.assertDone();
  });

  const connection = () => nodeAt(tree, 'Lake');
  const connect = async () => vscode.commands.executeCommand('aantje.connect', await connection());

  /** Opens the Properties panel of the connection and waits for the page to ask for and get its data. */
  async function openProperties(): Promise<WebviewRecord> {
    await vscode.commands.executeCommand('aantje.showProperties', await connection());
    const panel = webviews.at(-1);
    assert.ok(panel);
    await waitFor('the properties page to ask for its data and get it', () => sentTo(panel).length > 0);
    return panel;
  }

  /** A second connection on another copy of the history fixture, connected. */
  async function connectOther(): Promise<void> {
    await setConnections([
      { id, name: 'Lake', kind: 'sqlite', path: file },
      {
        id: uniqueId('shell-other'),
        name: 'Other',
        kind: 'sqlite',
        path: copyFixture('history/history.sqlite'),
      },
    ]);
    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, 'Other'));
  }

  describe('the Properties panel', () => {
    it('opens a panel for the connection instead of a Markdown document, and sends the properties when the page asks', async () => {
      await connect();
      const documents = untitledDocuments().length;

      const panel = await openProperties();

      assert.equal(tabsOf('aantje.properties').length, 1);
      assert.deepEqual(
        webviews.map(({ viewType }) => viewType),
        ['aantje.properties'],
      );
      assert.equal(untitledDocuments().length, documents, 'no document was opened');
      const [message] = sentTo(panel);
      assert.equal(message?.data.connection, 'Lake');
      assert.equal(message?.data.properties.specVersion, '1.1');
      assert.equal(message?.data.properties.snapshotCount, HISTORY_LATEST_SNAPSHOT + 1);
      assert.equal(message?.data.properties.metadata.length, 5);
      assert.deepEqual(
        message?.data.actions,
        ['showStorage'],
        'the Storage report is a panel and has its button',
      );
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });

    it('loads the shared page script under a strict content security policy from the dist folder only, with a nonce of its own per panel', async () => {
      await connect();
      const first = await openProperties();
      await connectOther();
      await vscode.commands.executeCommand('aantje.showProperties', await nodeAt(tree, 'Other'));
      await waitFor('the second panel', () => webviews.length === 2);
      const second = webviews[1];
      assert.ok(second);

      const { webview } = first.panel;
      assert.match(webview.html, /report-client\.js/);
      assert.match(webview.html, /default-src 'none'/);
      assert.deepEqual(
        (webview.options.localResourceRoots ?? []).map((root) => root.fsPath),
        [vscode.Uri.joinPath(extension().extensionUri, 'dist').fsPath],
      );
      assert.equal(webview.options.enableScripts, true);

      const nonceOf = (html: string): string => /script-src 'nonce-([^']+)'/.exec(html)?.[1] ?? '';
      const nonces = [first, second].map(({ panel }) => nonceOf(panel.webview.html));
      assert.ok(nonces.every((nonce) => nonce.length >= 16));
      assert.notEqual(nonces[0], nonces[1]);
      [first, second].forEach(({ panel }, index) => {
        assert.ok(panel.webview.html.includes(`<style nonce="${nonces[index]}">`));
        assert.ok(panel.webview.html.includes(`<script nonce="${nonces[index]}"`));
      });
    });

    it('brings the panel to the front again, and renames it when the connection was renamed', async () => {
      await connect();
      const panel = await openProperties();
      await vscode.window.showTextDocument(
        await vscode.workspace.openTextDocument({ content: 'something else' }),
      );
      await waitFor('the panel to be behind the other tab', () => !panel.panel.visible);
      await setConnections([{ id, name: 'Lake renamed', kind: 'sqlite', path: file }]);

      await post(panel, { type: 'refresh' });

      await waitFor('the panel in front again', () => panel.panel.visible);
      await waitFor('the new title', () => panel.panel.title.includes('Lake renamed'));
      assert.equal(webviews.length, 1);
    });

    it('shows the same panel again with fresh data, one of its own for another connection, and the connection whose node was used, not the active one', async () => {
      await connect();
      const panel = await openProperties();

      await vscode.commands.executeCommand('aantje.showProperties', await connection());
      await waitFor('the second data', () => sentTo(panel).length === 2);
      assert.equal(webviews.length, 1, 'no second panel was created');
      assert.deepEqual(sentTo(panel)[1]?.data, sentTo(panel)[0]?.data);

      await connectOther();
      await waitFor('"Other" in the status bar', () => statusBar().text.includes('Other'));
      const again = await openProperties();
      assert.equal(
        again,
        panel,
        'the node of Lake opens the panel of Lake while Other is the active connection',
      );
      assert.equal(sentTo(panel)[2]?.data.connection, 'Lake');

      await vscode.commands.executeCommand('aantje.showProperties', await nodeAt(tree, 'Other'));
      await waitFor('the second panel', () => webviews.length === 2);
      await waitFor('both tabs', () => tabsOf('aantje.properties').length === 2);
      const other = webviews[1];
      assert.ok(other);
      await waitFor('the data of Other', () => sentTo(other).length === 1);
      assert.equal(sentTo(other)[0]?.data.connection, 'Other');
    });

    it('opens a new panel after the user closed the old one', async () => {
      await connect();
      const first = await openProperties();
      first.panel.dispose();
      await waitFor('the tab to close', () => tabsOf('aantje.properties').length === 0);

      const second = await openProperties();

      assert.notEqual(second, first);
      assert.equal(tabsOf('aantje.properties').length, 1);
    });

    it('reads the catalog again when the page asks for it', async () => {
      await connect();
      const panel = await openProperties();
      await editCatalog(file, ["INSERT INTO ducklake_metadata (key, value) VALUES ('aantje_test', '1')"]);
      await tree.disconnect(id);
      await connect();

      await post(panel, { type: 'refresh' });

      await waitFor('the second data', () => sentTo(panel).length === 2);
      assert.equal(sentTo(panel)[0]?.data.properties.metadata.length, 5);
      assert.equal(sentTo(panel)[1]?.data.properties.metadata.length, 6);
      assert.equal(webviews.length, 1);
    });

    it('opens no panel while the connection is not open, and reads nothing for a refresh after the connection was closed or removed', async () => {
      await vscode.commands.executeCommand('aantje.showProperties', await connection());
      assert.equal(desktop.infos.length, 1, 'the user is told to connect first');
      assert.deepEqual(webviews, []);

      await connect();
      const panel = await openProperties();
      await tree.disconnect(id);
      await post(panel, { type: 'refresh' });
      await setConnections([]);
      await post(panel, { type: 'refresh' });

      await waitFor('both hints', () => desktop.infos.length === 3);
      assert.deepEqual(desktop.errors, []);
      assert.equal(sentTo(panel).length, 1, 'nothing was read');
    });

    it('ignores an action of another report, a request it does not know, and a Markdown request with text or a view that does not fit', async () => {
      await connect();
      const panel = await openProperties();
      const documents = untitledDocuments().length;

      await post(panel, { type: 'action', action: 'scriptCleanup' });
      await post(panel, { type: 'action', action: 'workbench.action.quit' });
      await post(panel, { type: 'run', command: 'aantje.removeConnection' });
      await post(panel, { type: 'markdown', markdown: '# written by the page' });
      await post(panel, { type: 'markdown', view: { filter: 3 } });
      await post(panel, { type: 'markdown', view: 'inlining' });

      assert.deepEqual([desktop.errors, desktop.infos, desktop.confirmations], [[], [], []]);
      assert.equal(untitledDocuments().length, documents);
      assert.equal(tree.roots().length, 1);
    });
  });

  describe('Open as Markdown', () => {
    async function opensDocument(panel: WebviewRecord, request: unknown): Promise<vscode.TextDocument> {
      const before = new Set(untitledDocuments());
      await post(panel, request);
      await waitFor('the document', () => untitledDocuments().some((document) => !before.has(document)));
      const document = untitledDocuments().find((candidate) => !before.has(candidate));
      assert.ok(document);
      await waitFor(
        'the document to be shown in the editor',
        () => vscode.window.activeTextEditor?.document === document,
      );
      onTeardownAsync(async () => {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      });
      return document;
    }

    it('opens the Properties as an untitled Markdown document built from the data the extension holds, with the filter that the page names', async () => {
      await connect();
      const panel = await openProperties();
      const properties = sentTo(panel)[0]?.data.properties;
      assert.ok(properties);

      const whole = await opensDocument(panel, { type: 'markdown' });
      assert.equal(whole.languageId, 'markdown');
      assert.equal(whole.getText(), propertiesMarkdown('Lake', properties));

      const filtered = await opensDocument(panel, { type: 'markdown', view: { filter: 'inlining' } });
      assert.equal(filtered.getText(), propertiesMarkdown('Lake', properties, 'inlining'));
      assert.ok(filtered.getText().includes('1 of 5 entries match'));
    });

    it('opens the statistics report and the snapshot report as Markdown too, each from its own data and with the view of the page', async () => {
      await connect();
      await vscode.commands.executeCommand(
        'aantje.showStatistics',
        await nodeAt(tree, 'Lake', 'shop', 'Tables', 'events'),
      );
      const statistics = webviews.find(({ viewType }) => viewType === 'aantje.statistics');
      assert.ok(statistics);
      await waitFor('the statistics data', () => statistics.messages.length > 0);
      await vscode.commands.executeCommand('aantje.showSnapshotReport', await connection());
      const report = webviews.find(({ viewType }) => viewType === 'aantje.snapshotReport');
      assert.ok(report);
      await waitFor('the report data', () => report.messages.length > 0);

      const stats = await opensDocument(statistics, { type: 'markdown' });
      // The title names the table, escaped like every Markdown title.
      assert.match(stats.getText().split('\n')[0] ?? '', /^# .*shop\\\.events$/);
      assert.ok(stats.getText().includes('| Files | 9 |'));

      const snapshots = await opensDocument(report, {
        type: 'markdown',
        view: { lanes: ['t3'], kinds: ['insert'], range: { from: 0, to: HISTORY_LATEST_SNAPSHOT } },
      });
      const lines = snapshots.getText().split('\n');
      assert.ok(lines.includes('| Tables | `shop.events` |'));
      assert.ok(lines.includes('| Snapshots listed | 5 of 57 |'));
    });
  });
});
