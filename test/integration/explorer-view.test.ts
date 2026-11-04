import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { CatalogTree } from '../../src/tree/model';
import type { TreeNode } from '../../src/tree/refs';
import { CatalogTreeProvider } from '../../src/tree/provider.vscode';
import { SNAPSHOT } from '../support/expected';
import { Desktop, pick } from './desktop';
import {
  activate,
  connectionsSetting,
  copyFixture,
  nodeAt,
  observeTree,
  onTeardown,
  setConnections,
  statusBar,
  statusBarSetup,
  tempDir,
  treeViewSetup,
  uniqueId,
  waitFor,
} from './support';

describe('the explorer view with two connections', () => {
  let tree: CatalogTree;
  let view: vscode.TreeView<TreeNode>;
  let desktop: Desktop;
  let idA: string;
  let idB: string;
  let a: TreeNode;
  let b: TreeNode;

  beforeEach(async () => {
    ({ tree, view } = await activate());
    desktop = Desktop.install();
    idA = uniqueId('lake-a');
    idB = uniqueId('lake-b');
    await setConnections([
      { id: idA, name: 'Lake A', kind: 'sqlite', path: copyFixture('ducklake.sqlite') },
      { id: idB, name: 'Lake B', kind: 'sqlite', path: copyFixture('ducklake.sqlite') },
    ]);
    [a, b] = tree.roots() as [TreeNode, TreeNode];
  });

  afterEach(() => {
    desktop.assertDone();
  });

  const connect = (node: TreeNode) => vscode.commands.executeCommand('aantje.connect', node);

  it('reveals and expands the connection that was connected, and only that one', async () => {
    const requested = observeTree(tree, 'children');

    await connect(b);

    await waitFor('the tree view to expand "Lake B"', () => requested.some(([node]) => node === b));
    assert.ok(!requested.some(([node]) => node === a), '"Lake A" stays collapsed');
    assert.equal(tree.state(idA).status, 'disconnected', 'and is not opened');
  });

  it('has the visible tree view read the connections again when the setting changes', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.aantje');
    await waitFor('the explorer to be visible', () => statusBar().visible);
    const roots = observeTree(tree, 'roots');

    await setConnections(undefined);

    await waitFor('the tree view to read the connections again', () => roots.length > 0);
  });

  it('refreshes only the connection of the node, and all connections without a node', async () => {
    await connect(a);
    await connect(b);
    const [readerA, readerB] = [tree.reader(idA), tree.reader(idB)];

    await vscode.commands.executeCommand('aantje.refresh', a);

    await waitFor('"Lake A" to be opened again', () => {
      const reader = tree.reader(idA);
      return reader && reader !== readerA;
    });
    assert.equal(tree.reader(idB), readerB, '"Lake B" was not touched');

    await vscode.commands.executeCommand('aantje.refresh');

    await waitFor('"Lake B" to be opened again', () => {
      const reader = tree.reader(idB);
      return reader && reader !== readerB;
    });
  });

  it('acts on the connection that was connected last when a command runs without a node', async () => {
    await connect(a);
    await connect(b);
    desktop.answer(pick('@6'));

    await vscode.commands.executeCommand('aantje.selectSnapshot');

    desktop.assertDone();
    assert.equal(desktop.picks[0]?.title, 'Snapshot of "Lake B"');
    assert.equal(tree.state(idB).snapshot, SNAPSHOT.deleteOrder2);
    assert.equal(tree.state(idA).snapshot, 'latest');
  });

  it('acts on a connection that the view opened by expanding it', async () => {
    await tree.children(b);
    await waitFor('"Lake B" in the status bar', () => statusBar().text.startsWith('$(database) Lake B'));
    desktop.answer(pick(undefined));

    await vscode.commands.executeCommand('aantje.selectSnapshot');

    desktop.assertDone();
    assert.equal(desktop.picks[0]?.title, 'Snapshot of "Lake B"');
  });

  it('hands over to another open connection when the one in use is disconnected', async () => {
    await connect(a);
    await connect(b);

    await vscode.commands.executeCommand('aantje.disconnect', b);

    assert.equal(statusBar().text, '$(database) Lake A · DuckLake 1.1 · latest (@13)');
    desktop.answer(pick(undefined), pick(undefined));
    await vscode.commands.executeCommand('aantje.search');
    await vscode.commands.executeCommand('aantje.selectSnapshot');
    desktop.assertDone();
    assert.deepEqual(
      desktop.picks.map(({ title }) => title),
      ['Search "Lake A"', 'Snapshot of "Lake A"'],
    );
    assert.deepEqual(desktop.infos, []);
  });

  it('acts on the connection of the node that a command receives, whichever connection is in use', async () => {
    await connect(a);
    await connect(b);
    desktop.answer(pick('@6'));

    await vscode.commands.executeCommand('aantje.selectSnapshot', a);

    desktop.assertDone();
    assert.equal(desktop.picks[0]?.title, 'Snapshot of "Lake A"');
    assert.equal(tree.state(idA).snapshot, SNAPSHOT.deleteOrder2);
    assert.equal(tree.state(idB).snapshot, 'latest');
    assert.equal(statusBar().text, '$(database) Lake A · DuckLake 1.1 · @6 (pinned)');
  });

  it('makes the connection of the node that is selected in the view the one in use', async () => {
    await tree.connect(idA);
    await tree.connect(idB);
    await waitFor('"Lake A" in the status bar', () => statusBar().text.startsWith('$(database) Lake A'));

    await view.reveal(b, { select: true });

    await waitFor('"Lake B" in the status bar', () => statusBar().text.startsWith('$(database) Lake B'));
  });

  it('asks to connect first when a command without a node finds no connected catalog', async () => {
    await vscode.commands.executeCommand('aantje.selectSnapshot');
    await vscode.commands.executeCommand('aantje.search');

    assert.deepEqual(desktop.infos, [
      'Connect to a catalog first to choose a snapshot.',
      'Connect to a catalog first to search it.',
    ]);
    assert.deepEqual(desktop.picks, []);
  });

  describe('when the setting changes while connections are open', () => {
    type Entry = { id: string; name: string; kind: 'sqlite'; path: string };
    let entryA: Entry;
    let entryB: Entry;
    let entryC: Entry;

    beforeEach(() => {
      [entryA, entryB] = connectionsSetting() as [Entry, Entry];
      entryC = {
        id: uniqueId('lake-c'),
        name: 'Lake C',
        kind: 'sqlite',
        path: copyFixture('ducklake.sqlite'),
      };
    });

    /** The status of a connection at every change that the tree reports from now on. */
    function statesOf(connectionId: string): string[] {
      const states: string[] = [];
      const subscription = tree.onDidChange(() => states.push(tree.state(connectionId).status));
      onTeardown(() => subscription.dispose());
      return states;
    }

    it('leaves an open connection alone when another one is added, renamed or removed', async () => {
      await connect(a);
      const reader = tree.reader(idA);
      const states = statesOf(idA);

      await setConnections([entryA, entryB, entryC]);
      await setConnections([entryA, { ...entryB, name: 'Lake B renamed' }, entryC]);
      await setConnections([entryA, entryB]);
      await setConnections([{ ...entryA, name: 'Lake A renamed' }, entryB]);

      assert.equal(tree.reader(idA), reader, 'the reader was not replaced');
      assert.ok(states.length > 0 && states.every((status) => status === 'connected'), states.join());
      assert.equal(a.label, 'Lake A renamed');
    });

    it('does not try a failed connection again when another one is added or removed', async () => {
      const missing = join(tempDir(), 'missing.sqlite');
      await setConnections([{ ...entryA, path: missing }, entryB]);
      await tree.connect(idA);
      const error = tree.state(idA).error;
      assert.equal(tree.state(idA).status, 'error');
      const states = statesOf(idA);

      await setConnections([{ ...entryA, path: missing }, entryB, entryC]);
      await setConnections([{ ...entryA, path: missing }, entryB]);

      assert.ok(states.length > 0 && states.every((status) => status === 'error'), states.join());
      assert.equal(tree.state(idA).error, error);
    });

    it('hands over to another open connection when the one in use is removed', async () => {
      await connect(a);
      await connect(b);

      await setConnections([entryA, entryC]);

      assert.equal(statusBar().text, '$(database) Lake A · DuckLake 1.1 · latest (@13)');
      desktop.answer(pick(undefined));
      await vscode.commands.executeCommand('aantje.search');
      desktop.assertDone();
      assert.equal(desktop.picks[0]?.title, 'Search "Lake A"');
    });

    it('opens an open connection again when its path was edited, and no other one', async () => {
      await connect(a);
      await connect(b);
      const [readerA, readerB] = [tree.reader(idA), tree.reader(idB)];

      await setConnections([{ ...entryA, path: copyFixture('ducklake.sqlite') }, entryB]);

      await waitFor('"Lake A" to be opened again', () => {
        const reader = tree.reader(idA);
        return reader && reader !== readerA;
      });
      assert.equal(tree.reader(idB), readerB, '"Lake B" was not touched');
    });
  });

  describe('status bar item', () => {
    it('is the item "aantje" on the left of the status bar', () => {
      assert.deepEqual(statusBarSetup(), {
        args: ['aantje.status', vscode.StatusBarAlignment.Left, 0],
        name: 'aantje',
      });
    });

    it('is hidden without a connection', async () => {
      await setConnections(undefined);
      assert.equal(statusBar().visible, false);
    });

    it('shows the connection in use, its DuckLake version and snapshot, and opens the snapshot picker', async () => {
      await connect(b);
      assert.deepEqual(statusBar(), {
        visible: true,
        text: '$(database) Lake B · DuckLake 1.1 · latest (@13)',
        tooltip: 'Select snapshot. Following the latest snapshot (@13).',
        command: 'aantje.selectSnapshot',
      });

      tree.selectSnapshot(idB, SNAPSHOT.insertTmp);
      assert.deepEqual(statusBar(), {
        visible: true,
        text: '$(database) Lake B · DuckLake 1.1 · @5 (pinned)',
        tooltip: 'Select snapshot. Pinned to snapshot @5, not following the latest (@13).',
        command: 'aantje.selectSnapshot',
      });

      await connect(a);
      assert.equal(statusBar().text, '$(database) Lake A · DuckLake 1.1 · latest (@13)');
    });

    it('keeps showing a connection in use while the explorer is hidden', async () => {
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await waitFor('the status bar item to hide', () => !statusBar().visible);

      await tree.connect(idA);

      await waitFor('the status bar item to show', () => statusBar().visible);
      assert.deepEqual(statusBar(), {
        visible: true,
        text: '$(database) Lake A · DuckLake 1.1 · latest (@13)',
        tooltip: 'Select snapshot. Following the latest snapshot (@13).',
        command: 'aantje.selectSnapshot',
      });
    });

    it('shows a connection that is not open only while the explorer is visible, without a click action', async () => {
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await waitFor('the status bar item to hide', () => !statusBar().visible);

      await vscode.commands.executeCommand('workbench.view.extension.aantje');

      await waitFor('the status bar item to show', () => statusBar().visible);
      assert.deepEqual(statusBar(), {
        visible: true,
        text: '$(debug-disconnect) Lake A · disconnected',
        tooltip: 'Lake A is not connected.',
        command: undefined,
      });
    });
  });

  it('offers a button to collapse all connections', () => {
    assert.equal(treeViewSetup().showCollapseAll, true);
  });

  describe('the tree items for VS Code', () => {
    it('map the nodes to labels, icons, descriptions, tooltips and context values', async () => {
      const provider = new CatalogTreeProvider(tree);
      onTeardown(() => provider.dispose());
      await connect(a);
      const itemAt = async (...path: string[]) => provider.getTreeItem(await nodeAt(tree, 'Lake A', ...path));
      const icon = (item: vscode.TreeItem): string | undefined =>
        item.iconPath instanceof vscode.ThemeIcon ? item.iconPath.id : undefined;
      const iconColor = (item: vscode.TreeItem): string | undefined =>
        item.iconPath instanceof vscode.ThemeIcon ? item.iconPath.color?.id : undefined;
      const tooltip = (item: vscode.TreeItem): string | undefined =>
        item.tooltip instanceof vscode.MarkdownString ? item.tooltip.value : undefined;

      const connection = provider.getTreeItem(a);
      assert.deepEqual(
        {
          label: connection.label,
          description: connection.description,
          contextValue: connection.contextValue,
          state: connection.collapsibleState,
          icon: icon(connection),
          iconColor: iconColor(connection),
        },
        {
          label: 'Lake A',
          description: 'sqlite · DuckLake 1.1 · @13',
          contextValue: 'connection.connected',
          state: vscode.TreeItemCollapsibleState.Collapsed,
          icon: 'database',
          iconColor: 'charts.green',
        },
      );
      assert.equal(
        iconColor(provider.getTreeItem(b)),
        undefined,
        'a connection that is not open has no colour',
      );
      assert.equal(connection.id, a.id);

      const orders = await itemAt('sales', 'Tables', 'orders');
      assert.deepEqual(
        {
          label: orders.label,
          description: orders.description,
          contextValue: orders.contextValue,
          state: orders.collapsibleState,
          icon: icon(orders),
        },
        {
          label: 'orders',
          description: undefined,
          contextValue: 'table',
          state: vscode.TreeItemCollapsibleState.Collapsed,
          icon: 'table',
        },
      );
      assert.equal(
        tooltip(orders),
        [
          '`sales.orders`',
          '',
          'Customer orders',
          '',
          '- Rows in data files (inlined rows not included): 2',
          '- Data files: 1',
          '- Size: 1.9 KB',
        ].join('\n'),
      );

      const view = await itemAt('sales', 'Views', 'big_orders');
      assert.deepEqual(
        [view.contextValue, view.collapsibleState, icon(view)],
        ['view', vscode.TreeItemCollapsibleState.Collapsed, 'eye'],
      );
      const column = await itemAt('sales', 'Tables', 'orders', 'Columns', 'customer', 'name');
      assert.deepEqual(
        [column.contextValue, column.collapsibleState, column.description, icon(column)],
        ['column', vscode.TreeItemCollapsibleState.None, 'varchar', 'symbol-field'],
      );
      assert.equal((await itemAt('sales')).contextValue, 'schema');

      for (const [path, contextValue] of [
        [['sales', 'Tables'], 'folder.tables'],
        [['sales', 'Views'], 'folder.views'],
        [['sales', 'Tables', 'orders', 'Columns'], 'folder.columns'],
      ] as const) {
        const folder = await itemAt(...path);
        assert.deepEqual(
          [folder.label, folder.description, folder.contextValue, folder.collapsibleState, icon(folder)],
          [path.at(-1), undefined, contextValue, vscode.TreeItemCollapsibleState.Collapsed, 'folder'],
        );
      }
      const statisticsNode = await nodeAt(tree, 'Lake A', 'sales', 'Tables', 'orders', 'Statistics');
      const statistics = provider.getTreeItem(statisticsNode);
      assert.deepEqual(
        [
          statistics.label,
          statistics.description,
          statistics.contextValue,
          statistics.collapsibleState,
          icon(statistics),
        ],
        ['Statistics', undefined, 'folder.statistics', vscode.TreeItemCollapsibleState.None, 'graph'],
      );
      assert.deepEqual(statistics.command, {
        command: 'aantje.showStatistics',
        title: 'Statistics',
        arguments: [statisticsNode],
      });
      const historyNode = await nodeAt(tree, 'Lake A', 'sales', 'Tables', 'orders', 'History');
      const history = provider.getTreeItem(historyNode);
      assert.deepEqual(
        [history.label, history.description, history.contextValue, history.collapsibleState, icon(history)],
        ['History', undefined, 'folder.history', vscode.TreeItemCollapsibleState.None, 'history'],
      );
      assert.deepEqual(history.command, {
        command: 'aantje.showSchemaHistory',
        title: 'Show History',
        arguments: [historyNode],
      });
      assert.equal(orders.command, undefined, 'a click on a table runs nothing');
      const bigOrders = await itemAt('sales', 'Views', 'big_orders');
      assert.deepEqual(
        [bigOrders.contextValue, icon(bigOrders), tooltip(bigOrders)],
        [
          'view',
          'eye',
          [
            '`sales.big_orders`',
            '',
            'Orders above 1',
            '',
            'Definition (dialect: duckdb):',
            '',
            '```sql',
            'SELECT * FROM sales.orders WHERE (amount > 1)',
            '```',
          ].join('\n'),
        ],
      );
      await assert.rejects(
        itemAt('sales', 'Views', 'big_orders', 'Definition'),
        'a view has no Definition node',
      );
    });

    it('marks the tables and views of an Azure DuckLake, so that the menus can leave Create Notebook out', async () => {
      const provider = new CatalogTreeProvider(tree, (id) => id === a.ref.connectionId);
      onTeardown(() => provider.dispose());
      await connect(a);
      const contextAt = async (...path: string[]) =>
        provider.getTreeItem(await nodeAt(tree, 'Lake A', ...path)).contextValue;

      assert.deepEqual(
        [
          await contextAt('sales', 'Tables', 'orders'),
          await contextAt('sales', 'Views', 'big_orders'),
          await contextAt('sales'),
          await contextAt('sales', 'Tables', 'orders', 'Columns', 'customer'),
        ],
        ['table.azure', 'view.azure', 'schema', 'column'],
      );
      // A lake that is not on Azure keeps the plain values.
      const plain = new CatalogTreeProvider(tree);
      onTeardown(() => plain.dispose());
      assert.equal(
        plain.getTreeItem(await nodeAt(tree, 'Lake A', 'sales', 'Tables', 'orders')).contextValue,
        'table',
      );
    });

    it('tells VS Code about the connected state only after it is in place, for the same item: the last change of a connect reads as connected', async () => {
      const provider = new CatalogTreeProvider(tree);
      onTeardown(() => provider.dispose());
      const seen: { node: TreeNode | undefined; contextValue: string | undefined }[] = [];
      provider.onDidChangeTreeData((node) => {
        seen.push({ node, contextValue: node && provider.getTreeItem(node).contextValue });
      });

      await connect(a);

      assert.deepEqual(seen, [
        { node: a, contextValue: 'connection.disconnected' },
        { node: a, contextValue: 'connection.connected' },
      ]);
      assert.equal(provider.getTreeItem(a).contextValue, 'connection.connected');
    });

    it('lets VS Code walk the tree: roots, children and parents, and tells it about changes', async () => {
      const provider = new CatalogTreeProvider(tree);
      onTeardown(() => provider.dispose());
      const changes: (TreeNode | undefined)[] = [];
      provider.onDidChangeTreeData((node) => changes.push(node));
      await connect(a);

      assert.deepEqual(provider.getChildren(), [a, b]);
      const schemas = await provider.getChildren(a);
      assert.deepEqual(
        schemas?.map((node) => node.label),
        ['main', 'sales', 'Snapshots'],
      );
      const [, sales] = schemas ?? [];
      assert.ok(sales);
      assert.equal(provider.getParent(sales), a);
      assert.equal(provider.getParent(a), undefined);

      const folders = await provider.getChildren(sales);
      assert.deepEqual(
        folders?.map((node) => node.label),
        ['Tables', 'Views', 'Macros'],
      );
      const [tables] = folders ?? [];
      assert.ok(tables);
      assert.equal(provider.getParent(tables), sales);
      const [orders] = (await provider.getChildren(tables)) ?? [];
      assert.ok(orders);
      assert.equal(provider.getParent(orders), tables, 'a table is revealed through its folder');

      changes.length = 0;
      tree.selectSnapshot(idA, SNAPSHOT.insertTmp);
      assert.deepEqual(changes, [a]);
    });
  });
});
