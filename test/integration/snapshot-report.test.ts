import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { CatalogTree } from '../../src/tree/model';
import {
  copyHistoryDataFixture,
  dataMessages,
  gridTabs,
  observeWebviews,
  recordNotebooks,
  requireEngine,
  useExtensionCache,
} from './data';
import type { WebviewRecord } from './data';
import { Desktop, pick } from './desktop';
import { HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import {
  activate,
  copyFixture,
  extension,
  nodeAt,
  onTeardown,
  statusBar,
  onTeardownAsync,
  setConnections,
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

/** The labels of the open tabs that hold a snapshot report. */
function reportTabs(): string[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('aantje.snapshotReport'),
    )
    .map((tab) => tab.label);
}

interface Sent {
  readonly type: string;
  readonly data: {
    readonly connection: string;
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

/** The reports that the extension posted to a page. */
const sentTo = (record: WebviewRecord): Sent[] =>
  record.messages.filter(
    (message): message is Sent =>
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'snapshotReport',
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

const TITLE = 'Snapshot Report · Lake';

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

describe('Show Snapshot Report', () => {
  let tree: CatalogTree;
  let desktop: Desktop;
  let webviews: WebviewRecord[];
  let id: string;
  let file: string;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
    webviews = observeWebviews();
    id = uniqueId('report');
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

  /** Opens the report from the connection and waits for the page to ask for and get its data. */
  async function open(): Promise<WebviewRecord> {
    await vscode.commands.executeCommand('aantje.showSnapshotReport', await connection());
    const [panel] = webviews;
    assert.ok(panel);
    await waitFor('the report page to ask for its data and get it', () => sentTo(panel).length > 0);
    return panel;
  }

  describe('declaration', () => {
    it('is a command of the category aantje that the Command Palette does not offer', () => {
      const declared = manifest().commands.find(({ command }) => command === 'aantje.showSnapshotReport');
      assert.deepEqual(
        [declared?.title, declared?.category, declared?.icon],
        ['Snapshot Report', 'aantje', '$(graph-scatter)'],
      );
      const hidden = (manifest().menus.commandPalette ?? [])
        .filter(({ when }) => when === 'false')
        .map(({ command }) => command);
      assert.ok(hidden.includes('aantje.showSnapshotReport'));
    });

    it('is in the Reports submenu of an open connection and nowhere else in the menus', () => {
      const entries = (manifest().menus['view/item/context'] ?? [])
        .filter(({ command }) => command === 'aantje.showSnapshotReport')
        .map(({ when, group }) => [when, group]);
      assert.deepEqual(
        (manifest().menus['aantje.reports'] ?? [])
          .filter(({ command }) => command === 'aantje.showSnapshotReport')
          .map(({ when, group }) => [when, group]),
        [['viewItem =~ /^connection\\.connected(\\.azure)?$/', '1_lake@1']],
      );
      assert.deepEqual(entries, []);
    });

    it('gives the Statistics leaf, and only it, a context value of its own', async () => {
      await connect();
      const children = await tree.children(await nodeAt(tree, 'Lake', 'shop', 'Tables', 'events'));
      assert.deepEqual(
        children.map(({ label, contextValue }) => [label, contextValue]),
        [
          ['Statistics', 'folder.statistics'],
          ['History', 'folder.history'],
          ['Columns', 'folder.columns'],
          ['Partitioning', 'folder.partitioning'],
        ],
      );
    });
  });

  describe('opening the report', () => {
    it('opens a tab for the connection, reads the snapshots with a progress that can be cancelled, and sends them when the page asks', async () => {
      await connect();

      const panel = await open();

      assert.deepEqual(reportTabs(), [TITLE]);
      assert.deepEqual(
        webviews.map(({ viewType, title }) => ({ viewType, title })),
        [{ viewType: 'aantje.snapshotReport', title: TITLE }],
      );
      assert.deepEqual(desktop.progress, ['Reading the snapshots of "Lake"...']);
      assert.match(panel.panel.webview.html, /report-client\.js/);
      assert.match(panel.panel.webview.html, /\.toolbar \{/, 'the stylesheet of the report is in the page');
      assert.equal(panel.panel.title, TITLE);
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

    it('shows the same panel again, with fresh data, when it is opened again', async () => {
      await connect();
      const panel = await open();

      await vscode.commands.executeCommand('aantje.showSnapshotReport', await connection());
      await waitFor('the second data', () => sentTo(panel).length === 2);

      assert.equal(webviews.length, 1, 'no second panel was created');
      assert.deepEqual(reportTabs(), [TITLE]);
      assert.deepEqual(sentTo(panel)[1]?.data, sentTo(panel)[0]?.data);
    });

    it('opens a new panel after the user closed the tab', async () => {
      await connect();
      const first = await open();

      first.panel.dispose();
      await waitFor('the tab to close', () => reportTabs().length === 0);
      await vscode.commands.executeCommand('aantje.showSnapshotReport', await connection());

      const second = webviews[1];
      assert.ok(second, 'a second panel was created');
      await waitFor('the data of the new panel', () => sentTo(second).length === 1);
      assert.deepEqual(reportTabs(), [TITLE]);
    });

    it('opens nothing and says so when Cancel is pressed while the snapshots are read', async () => {
      await connect();
      const node = await connection();
      const window = vscode.window as unknown as Record<string, unknown>;
      const original = window.withProgress;
      const asked: vscode.ProgressOptions[] = [];
      window.withProgress = (options: vscode.ProgressOptions, task: (...args: unknown[]) => unknown) => {
        asked.push(options);
        desktop.progress.push(options.title ?? '');
        const token = {
          isCancellationRequested: true,
          onCancellationRequested: (listener: () => void) => {
            listener();
            return new vscode.Disposable(() => undefined);
          },
        };
        return Promise.resolve(task({ report: () => undefined }, token));
      };
      onTeardown(() => {
        window.withProgress = original;
      });

      await vscode.commands.executeCommand('aantje.showSnapshotReport', node);

      assert.deepEqual(
        asked.map(({ location, cancellable }) => [location, cancellable]),
        [[vscode.ProgressLocation.Notification, true]],
      );
      assert.deepEqual(desktop.infos, ['The query was cancelled.']);
      assert.deepEqual([desktop.errors, webviews, reportTabs()], [[], [], []]);
    });

    it('asks to connect first when the connection is closed', async () => {
      const node = await connection();

      await vscode.commands.executeCommand('aantje.showSnapshotReport', node);

      assert.deepEqual(desktop.infos, ['Connect to a catalog first to show its snapshot report.']);
      assert.deepEqual([desktop.progress, webviews], [[], []]);
    });

    it('does nothing for a schema, a table, the other folders, a snapshot or a call without a node', async () => {
      await connect();
      for (const path of [
        ['shop'],
        ['shop', 'Tables'],
        ['shop', 'Tables', 'events'],
        ['shop', 'Tables', 'events', 'Columns'],
        ['shop', 'Tables', 'events', 'Statistics'],
        ['shop', 'Tables', 'events', 'History'],
        ['Snapshots'],
        ['Snapshots', '@23'],
      ]) {
        await vscode.commands.executeCommand(
          'aantje.showSnapshotReport',
          await nodeAt(tree, 'Lake', ...path),
        );
      }
      await vscode.commands.executeCommand('aantje.showSnapshotReport');

      assert.deepEqual([desktop.progress, webviews, desktop.errors, desktop.infos], [[], [], [], []]);
    });
  });

  describe('the actions of the detail pane', () => {
    beforeEach(connect);

    const state = () => tree.state(id);

    it('shows the catalog at the snapshot in the tree, and follows the latest snapshot again', async () => {
      const panel = await open();

      await pressButton(panel, { type: 'action', action: 'showCatalog', snapshot: 23 });
      assert.equal(state().snapshot, 23);

      await pressButton(panel, { type: 'action', action: 'showLatest' });
      assert.equal(state().snapshot, 'latest');

      await pressButton(panel, { type: 'action', action: 'showLatest' });
      assert.deepEqual(desktop.infos, ['"Lake" already shows the latest snapshot.']);
      assert.deepEqual(desktop.errors, []);
    });

    it('opens the diff editor over the CREATE TABLE of the table at two snapshots', async () => {
      const panel = await open();

      await pressButton(panel, {
        type: 'action',
        action: 'compareSchema',
        snapshot: 35,
        table: 12,
        against: 'previous',
      });
      const [tab] = await waitFor('the diff editor', () => {
        const tabs = diffTabs();
        return tabs.length > 0 ? tabs : undefined;
      });

      assert.equal(tab?.label, 'main.evolved: @34 ↔ @35');
      assert.deepEqual(
        [tab?.original, tab?.modified].map((uri) => `${uri?.scheme}:${uri?.path}?${uri?.query}`),
        [`aantje-schema:/12@34.sql?${id}`, `aantje-schema:/12@35.sql?${id}`],
      );
      await waitFor('the summary', () => desktop.infos.length > 0);
      assert.deepEqual(desktop.infos, ['table renamed between @34 and @35']);
    });

    it('compares the schema with the second snapshot, whichever is older, and the whole catalog in a report document', async () => {
      const panel = await open();
      const before = new Set(untitledDocuments());

      await pressButton(panel, {
        type: 'action',
        action: 'compareSnapshots',
        snapshot: 35,
        against: 'other',
        other: 30,
      });
      const document = await waitFor('the report document', () =>
        untitledDocuments().find((candidate) => !before.has(candidate)),
      );

      assert.equal(document.languageId, 'markdown');
      assert.match(document.getText(), /^# Lake: @30 to @35\n/);
      assert.match(document.getText(), /- table `main.evolving` is now `main.evolved`/);
    });

    it('does not compare the schema of a table with a snapshot at which the data says it does not exist: nothing is asked, nothing opens', async () => {
      const panel = await open();

      await pressButton(panel, {
        type: 'action',
        action: 'compareSchema',
        snapshot: 44,
        table: 15,
        against: 'latest',
      });

      assert.deepEqual([desktop.infos, desktop.errors, diffTabs()], [[], [], []]);
    });

    it('ignores a request that the data does not offer, one with a command in it, and one it does not know', async () => {
      const panel = await open();
      const before = [state().snapshot, untitledDocuments().length, gridTabs().length];
      const asked = desktop.progress.length;

      for (const request of [
        { type: 'action', action: 'showCatalog', snapshot: 999 },
        { type: 'action', action: 'rowsChanged', snapshot: 55, table: 19 },
        { type: 'action', action: 'rowsChanged', snapshot: 45, table: 15 },
        { type: 'action', action: 'compareSchema', snapshot: 0, table: 3, against: 'previous' },
        { type: 'action', action: 'compareSnapshots', snapshot: 5, against: 'other', other: 999 },
        { type: 'action', action: 'query', snapshot: 23, table: 9999 },
        { type: 'action', action: 'workbench.action.quit' },
        { type: 'action', action: 'showCatalog', snapshot: 23, command: 'aantje.removeConnection' },
        { type: 'command', command: 'aantje.removeConnection' },
        'showCatalog',
        null,
      ]) {
        await pressButton(panel, request);
      }

      assert.deepEqual([state().snapshot, untitledDocuments().length, gridTabs().length], before);
      assert.equal(desktop.progress.length, asked, 'nothing was read for the requests');
      assert.deepEqual([desktop.errors, desktop.infos, desktop.picks], [[], [], []]);
      assert.equal(tree.roots().length, 1, 'the connection is still there');
    });

    it('checks an action against the data that the page was sent last: a snapshot that only the new data has is accepted', async () => {
      const panel = await open();
      await editCatalog(file, [
        "INSERT INTO ducklake_snapshot VALUES (57, '2026-11-01 00:00:00+00', 1, 70, 28)",
        "INSERT INTO ducklake_snapshot_changes VALUES (57, 'inserted_into_table:3', NULL, NULL, NULL)",
      ]);
      await tree.disconnect(id);
      await connect();

      await vscode.commands.executeCommand('aantje.showSnapshotReport', await connection());
      await waitFor('the second data', () => sentTo(panel).length === 2);
      assert.equal(sentTo(panel)[1]?.data.latest, 57);
      await pressButton(panel, { type: 'action', action: 'showCatalog', snapshot: 57 });

      assert.equal(tree.state(id).snapshot, 57);
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });

    it('makes the connection of the report the one in use, which the status bar shows', async () => {
      await setConnections([
        { id: 'other', name: 'Other', kind: 'sqlite', path: copyFixture('ducklake.sqlite') },
        { id, name: 'Lake', kind: 'sqlite', path: file },
      ]);
      await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, 'Lake'));
      await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, 'Other'));
      await waitFor('the status bar to show the first open connection', () =>
        statusBar().text.includes('Other'),
      );

      await vscode.commands.executeCommand('aantje.showSnapshotReport', await nodeAt(tree, 'Lake'));

      await waitFor('the status bar to show the connection of the report', () =>
        statusBar().text.includes('Lake'),
      );
    });

    it('reads the snapshots again when the page asks for it', async () => {
      await vscode.commands.executeCommand('aantje.showSnapshotReport', await connection());
      const [panel] = webviews;
      assert.ok(panel);
      await waitFor('the first data', () => sentTo(panel).length === 1);
      const progress = desktop.progress.length;

      await pressButton(panel, { type: 'refresh' });

      await waitFor('the second data', () => sentTo(panel).length === 2);
      assert.equal(desktop.progress.length, progress + 1, 'the snapshots were read under a progress again');
      assert.deepEqual(sentTo(panel)[1]?.data, sentTo(panel)[0]?.data);
      assert.equal(webviews.length, 1);
    });

    it('says that the connection was removed when an action or a refresh comes after it', async () => {
      const panel = await open();
      await setConnections([]);

      await pressButton(panel, { type: 'action', action: 'showCatalog', snapshot: 23 });
      await pressButton(panel, { type: 'refresh' });

      assert.deepEqual(desktop.infos, [
        'The connection of this snapshot report was removed. Close the report.',
        'The connection of this snapshot report was removed. Close the report.',
      ]);
      assert.deepEqual(desktop.errors, []);
      assert.equal(sentTo(panel).length, 1, 'nothing was read');
    });

    it('tells the user to connect again when the connection was closed after the report was opened', async () => {
      const panel = await open();
      await tree.disconnect(id);

      await pressButton(panel, { type: 'action', action: 'showCatalog', snapshot: 23 });

      assert.deepEqual(desktop.errors, [
        'The connection is closed. Connect again to use the snapshot report.',
      ]);
    });
  });
});

describe('Show Snapshot Report: actions that read table data', function () {
  before(async function () {
    await requireEngine(this);
  });

  let api: ExtensionApi;
  let profileId: string;
  let tree: CatalogTree;
  let desktop: Desktop;
  let webviews: WebviewRecord[];
  let name: string;

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

  async function open(): Promise<WebviewRecord> {
    await vscode.commands.executeCommand('aantje.showSnapshotReport', await nodeAt(tree, name));
    const [panel] = webviews;
    assert.ok(panel);
    await waitFor('the report page to ask for its data and get it', () => sentTo(panel).length > 0);
    return panel;
  }

  it('shows the rows that a snapshot changed in the grid of the table and the range', async () => {
    const report = await open();

    await pressButton(report, { type: 'action', action: 'rowsChanged', snapshot: 23, table: 9 });
    const grid = await waitFor('the grid panel', () => webviews[1]);
    await waitFor('the grid data', () => dataMessages(grid).length > 0);

    assert.deepEqual(gridTabs(), [`shop.customers changes @22 → @23 · ${name}`]);
    assert.deepEqual(desktop.progress.at(-1), 'Reading the changes of shop.customers...');
    assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
  });

  it('queries a table at the snapshot after asking what to open: the first rows, or a notebook pinned to it', async () => {
    const report = await open();
    const notebooks = recordNotebooks();
    desktop.answer(pick('Top 1000 Rows'), pick('Create Notebook'));

    await pressButton(report, { type: 'action', action: 'query', snapshot: 23, table: 3 });
    const grid = await waitFor('the grid panel', () => webviews[1]);
    await waitFor('the grid data', () => dataMessages(grid).length > 0);
    await pressButton(report, { type: 'action', action: 'query', snapshot: 30, table: 12 });
    await waitFor('the notebook', () => notebooks.length > 0);

    assert.deepEqual(gridTabs(), [`shop.events (top 1000) · ${name} @23`]);
    assert.deepEqual(
      desktop.picks.map(({ title, rows }) => [title, rows.map(({ label }) => label)]),
      [
        ['Query shop.events at @23', ['Top 1000 Rows', 'Create Notebook', 'Open as SQL']],
        ['Query main.evolving at @30', ['Top 1000 Rows', 'Create Notebook', 'Open as SQL']],
      ],
    );
    assert.equal(notebooks.length, 1);
    assert.match(notebooks[0]?.join('\n') ?? '', /"main"\."evolving"/);
    assert.match(
      notebooks[0]?.join('\n') ?? '',
      /^SNAPSHOT = 30$/m,
      'the notebook is pinned to the snapshot that was asked for',
    );
    assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
  });

  it('opens the statement for the table as it was in an SQL document of the connection, and runs nothing', async () => {
    const report = await open();
    desktop.answer(pick('Open as SQL'));
    const before = new Set(untitledDocuments());

    await pressButton(report, { type: 'action', action: 'query', snapshot: 30, table: 12 });
    const document = await waitFor('the SQL document', () =>
      untitledDocuments().find((candidate) => !before.has(candidate)),
    );

    assert.equal(document.languageId, 'sql');
    assert.equal(
      document.getText(),
      '-- Time travel to snapshot 30\nSELECT\n  "id",\n  "title",\n  "info",\n  "n",\n  "extra"\nFROM "main"."evolving" AT (VERSION => 30)\nLIMIT 1000;',
    );
    await waitFor(
      'the document to belong to the connection',
      () => api.editors.connectionOf(document.uri.toString()) === profileId,
    );
    assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
  });
});
