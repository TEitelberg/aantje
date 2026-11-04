import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { CatalogTree } from '../../src/tree/model';
import { observeWebviews } from './data';
import type { WebviewRecord } from './data';
import { Desktop, pick } from './desktop';
import { EVENTS_STATISTICS, HISTORY_LATEST_SNAPSHOT, HISTORY_SNAPSHOT } from '../support/expected-history';
import {
  activate,
  copyFixture,
  extension,
  nodeAt,
  onTeardown,
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

/** The labels of the open tabs that hold a statistics report. */
function statisticsTabs(): string[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('aantje.statistics'),
    )
    .map((tab) => tab.label);
}

interface Sent {
  readonly type: string;
  readonly data: {
    readonly table: string;
    readonly connection: string;
    readonly statistics: { snapshot: number; rows: number; files: number; dataBytes: number };
  };
}

/** The statistics that the extension posted to a page. */
const sentTo = (record: WebviewRecord): Sent[] =>
  record.messages.filter(
    (message): message is Sent =>
      typeof message === 'object' && message !== null && 'type' in message && message.type === 'statistics',
  );

describe('Show Statistics', () => {
  let tree: CatalogTree;
  let desktop: Desktop;
  let webviews: WebviewRecord[];
  let name: string;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
    webviews = observeWebviews();
    name = 'Lake';
    await setConnections([
      { id: uniqueId('statistics'), name, kind: 'sqlite', path: copyFixture('history/history.sqlite') },
    ]);
  });

  afterEach(() => {
    desktop.assertDone();
  });

  const connect = () =>
    vscode.commands.executeCommand(
      'aantje.connect',
      tree.roots().find((node) => node.label === name),
    );
  const events = () => nodeAt(tree, name, 'shop', 'Tables', 'events');
  const title = (snapshot: number) => `Statistics of shop.events @${snapshot} · ${name}`;

  describe('declaration', () => {
    it('is a command of the category aantje that the Command Palette does not offer', () => {
      const declared = manifest().commands.find(({ command }) => command === 'aantje.showStatistics');
      assert.deepEqual(
        [declared?.title, declared?.category, declared?.icon],
        ['Statistics', 'aantje', '$(graph)'],
      );
      const hidden = (manifest().menus.commandPalette ?? [])
        .filter(({ when }) => when === 'false')
        .map(({ command }) => command);
      assert.ok(hidden.includes('aantje.showStatistics'));
    });

    it('is in the Reports submenu of a table, in the context menu of its Statistics folder, and a button on that folder', () => {
      const entries = (manifest().menus['view/item/context'] ?? [])
        .filter(({ command }) => command === 'aantje.showStatistics')
        .map(({ when, group }) => [when, group]);
      assert.deepEqual(
        (manifest().menus['aantje.reports'] ?? [])
          .filter(({ command }) => command === 'aantje.showStatistics')
          .map(({ when, group }) => [when, group]),
        [['viewItem == table', '2_table@1']],
      );
      assert.deepEqual(entries, [
        ['view == aantje.catalogs && viewItem == folder.statistics', '3_data@3'],
        ['view == aantje.catalogs && viewItem == folder.statistics', 'inline@1'],
      ]);
    });

    it('gives the Statistics folder its own context value, so that no other folder has the button', async () => {
      await connect();
      const children = await tree.children(await events());
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

  it('opens a statistics tab with the statistics of the table at the shown snapshot, which the page asks for', async () => {
    await connect();

    await vscode.commands.executeCommand('aantje.showStatistics', await events());
    const [panel] = webviews;
    assert.ok(panel);
    // The real page loads under the real content security policy and answers: only then is the data sent.
    await waitFor('the statistics page to ask for its data and get it', () => sentTo(panel).length > 0);

    assert.deepEqual(statisticsTabs(), [title(HISTORY_LATEST_SNAPSHOT)]);
    assert.deepEqual(
      webviews.map(({ viewType, title: shown }) => ({ viewType, title: shown })),
      [{ viewType: 'aantje.statistics', title: title(HISTORY_LATEST_SNAPSHOT) }],
    );
    assert.deepEqual(desktop.progress, ['Reading the statistics of shop.events...']);
    const [message] = sentTo(panel);
    assert.equal(message?.data.table, 'shop.events');
    assert.equal(message?.data.connection, name);
    assert.deepEqual(
      {
        snapshot: message?.data.statistics.snapshot,
        rows: message?.data.statistics.rows,
        files: message?.data.statistics.files,
        dataBytes: message?.data.statistics.dataBytes,
      },
      {
        snapshot: HISTORY_LATEST_SNAPSHOT,
        rows: EVENTS_STATISTICS.rows,
        files: EVENTS_STATISTICS.files,
        dataBytes: EVENTS_STATISTICS.dataBytes,
      },
    );
    assert.deepEqual(desktop.errors, []);
  });

  it('shows the same panel again, with fresh data, from the Statistics folder of the same table', async () => {
    await connect();

    await vscode.commands.executeCommand('aantje.showStatistics', await events());
    const [panel] = webviews;
    assert.ok(panel);
    await waitFor('the first data', () => sentTo(panel).length === 1);
    await vscode.commands.executeCommand(
      'aantje.showStatistics',
      await nodeAt(tree, name, 'shop', 'Tables', 'events', 'Statistics'),
    );
    await waitFor('the second data', () => sentTo(panel).length === 2);

    assert.equal(webviews.length, 1, 'no second panel was created');
    assert.deepEqual(statisticsTabs(), [title(HISTORY_LATEST_SNAPSHOT)]);
    assert.deepEqual(sentTo(panel)[1]?.data, sentTo(panel)[0]?.data);
    assert.deepEqual(desktop.progress, [
      'Reading the statistics of shop.events...',
      'Reading the statistics of shop.events...',
    ]);
  });

  it('opens a new panel with fresh data after the user closed the statistics tab', async () => {
    await connect();
    await vscode.commands.executeCommand('aantje.showStatistics', await events());
    const [first] = webviews;
    assert.ok(first);
    await waitFor('the first data', () => sentTo(first).length === 1);

    first.panel.dispose();
    await waitFor('the tab to close', () => statisticsTabs().length === 0);
    await vscode.commands.executeCommand('aantje.showStatistics', await events());

    const second = webviews[1];
    assert.ok(second, 'a second panel was created, the closed one was not reused');
    await waitFor('the data of the new panel', () => sentTo(second).length === 1);
    assert.deepEqual(statisticsTabs(), [title(HISTORY_LATEST_SNAPSHOT)]);
    assert.deepEqual(desktop.errors, []);
  });

  it('brings the panel to the front again, in the same editor group, when it is shown while another tab is in front', async () => {
    await connect();
    const groups = vscode.window.tabGroups.all.length;
    await vscode.commands.executeCommand('aantje.showStatistics', await events());
    const [panel] = webviews;
    assert.ok(panel);
    await waitFor('the data', () => sentTo(panel).length === 1);
    assert.equal(
      vscode.window.tabGroups.all.length,
      groups,
      'it opens in the active editor group, not beside it',
    );
    onTeardownAsync(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });

    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument({ content: 'something else' }),
    );
    await waitFor('the statistics report to be behind the other tab', () => !panel.panel.visible);
    await vscode.commands.executeCommand('aantje.showStatistics', await events());

    await waitFor('the statistics report to be in front again', () => panel.panel.visible);
    assert.equal(webviews.length, 1);
  });

  it('opens a panel of its own for another snapshot, with the figures of that snapshot', async () => {
    await connect();
    await vscode.commands.executeCommand('aantje.showStatistics', await events());
    const [latest] = webviews;
    assert.ok(latest);
    await waitFor('the data at the latest snapshot', () => sentTo(latest).length === 1);

    desktop.answer(pick(`@${HISTORY_SNAPSHOT.insertEventsBulk}`));
    await vscode.commands.executeCommand(
      'aantje.selectSnapshot',
      tree.roots().find((node) => node.label === name),
    );
    await vscode.commands.executeCommand('aantje.showStatistics', await events());
    const pinned = webviews[1];
    assert.ok(pinned);
    await waitFor('the data at snapshot 8', () => sentTo(pinned).length === 1);

    assert.deepEqual(
      statisticsTabs(),
      [title(HISTORY_LATEST_SNAPSHOT), title(HISTORY_SNAPSHOT.insertEventsBulk)],
      'one panel per snapshot, told apart by the snapshot in the title',
    );
    assert.deepEqual(
      [sentTo(latest)[0]?.data.statistics.files, sentTo(pinned)[0]?.data.statistics.files],
      [9, 5],
    );
  });

  it('opens nothing and says so when Cancel is pressed while the statistics are read', async () => {
    await connect();
    const node = await events();
    const window = vscode.window as unknown as Record<string, unknown>;
    const original = window.withProgress;
    const asked: vscode.ProgressOptions[] = [];
    // The user pressed Cancel at once: the token is cancelled when the command asks to be told about it.
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

    await vscode.commands.executeCommand('aantje.showStatistics', node);

    assert.deepEqual(desktop.progress, ['Reading the statistics of shop.events...']);
    // a notification with a Cancel button, which is what lets the user stop a long read
    assert.deepEqual(
      asked.map(({ location, cancellable }) => [location, cancellable]),
      [[vscode.ProgressLocation.Notification, true]],
    );
    assert.deepEqual(desktop.infos, ['The query was cancelled.']);
    assert.deepEqual(desktop.errors, []);
    assert.deepEqual(webviews, []);
    assert.deepEqual(statisticsTabs(), []);
  });

  it('hints to connect first when the connection is closed, like every report, and opens nothing', async () => {
    await connect();
    const node = await events();
    await vscode.commands.executeCommand(
      'aantje.disconnect',
      tree.roots().find((root) => root.label === name),
    );

    await vscode.commands.executeCommand('aantje.showStatistics', node);

    // A hint, not an error: one information message.
    assert.deepEqual(desktop.errors, []);
    assert.equal(desktop.infos.length, 1);
    assert.deepEqual(desktop.progress, []);
    assert.deepEqual(webviews, []);
  });

  it('does nothing for a node that is no table, for the other folders of a table, and for a call without a node', async () => {
    await connect();

    for (const path of [
      [],
      ['shop'],
      ['shop', 'Tables'],
      ['shop', 'Tables', 'events', 'Columns'],
      ['shop', 'Tables', 'events', 'Columns', 'kind'],
      ['shop', 'Tables', 'events', 'Partitioning'],
      ['shop', 'Tables', 'events', 'History'],
      ['shop', 'Views', 'big_events'],
      ['Snapshots'],
    ]) {
      await vscode.commands.executeCommand('aantje.showStatistics', await nodeAt(tree, name, ...path));
    }
    await vscode.commands.executeCommand('aantje.showStatistics');

    assert.deepEqual(desktop.progress, []);
    assert.deepEqual([desktop.errors, desktop.infos, desktop.confirmations], [[], [], []]);
    assert.deepEqual(webviews, []);
  });

  it('reads the statistics of a table that has only inlined rows as an empty table', async () => {
    await connect();

    await vscode.commands.executeCommand(
      'aantje.showStatistics',
      await nodeAt(tree, name, 'shop', 'Tables', 'notes'),
    );
    const [panel] = webviews;
    assert.ok(panel);
    await waitFor('the data', () => sentTo(panel).length === 1);

    assert.equal(sentTo(panel)[0]?.data.table, 'shop.notes');
    assert.deepEqual(
      [sentTo(panel)[0]?.data.statistics.files, sentTo(panel)[0]?.data.statistics.rows],
      [0, 0],
    );
  });
});
