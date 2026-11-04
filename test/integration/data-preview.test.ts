import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { CatalogTree } from '../../src/tree/model';
import {
  copyDataFixture,
  dataMessages,
  gridTabs,
  observeWebviews,
  requireEngine,
  setSetting,
  useExtensionCache,
} from './data';
import type { DataFixture, WebviewRecord } from './data';
import { Desktop, pick } from './desktop';
import { ORDER_1, ORDER_2, ORDER_3, ORDERS_GRID_COLUMNS } from './expectations';
import { activate, nodeAt, setConnections, tempDir, waitFor } from './support';

/** The title names the connection and the snapshot that the panel shows (the data fixture has 13 snapshots). */
const panelTitle = (connection: string, snapshot: number): string =>
  `sales.orders (top 1000) · ${connection} @${snapshot}`;

/** What the grid page was sent as data, without the time the query took. */
function shownBy(record: WebviewRecord, index: number): unknown {
  const message = dataMessages(record)[index] as { type: string; data: { elapsedMs: unknown } };
  assert.equal(typeof message.data.elapsedMs, 'number', 'the page is told how long the query took');
  const { elapsedMs: _, ...data } = message.data;
  return { type: message.type, data };
}

function orders(rows: unknown[][]): unknown {
  return {
    type: 'data',
    data: {
      table: { schema: 'sales', table: 'orders' },
      columns: ORDERS_GRID_COLUMNS,
      rows,
      limit: 1000,
      truncated: false,
    },
  };
}

describe('Select Top 1000 Rows', function () {
  before(async function () {
    await requireEngine(this);
  });

  let tree: CatalogTree;
  let desktop: Desktop;
  let webviews: WebviewRecord[];

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
    webviews = observeWebviews();
    await useExtensionCache();
  });

  afterEach(() => {
    desktop.assertDone();
  });

  /** Adds the data fixture as a connection and clicks Connect, like the user. */
  async function connected(kind: 'sqlite' | 'duckdb'): Promise<{ fixture: DataFixture; name: string }> {
    const fixture = await copyDataFixture(kind);
    const { name } = fixture.profile;
    await setConnections([fixture.profile]);
    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, name));
    return { fixture, name };
  }

  for (const kind of ['sqlite', 'duckdb'] as const) {
    it(`opens a grid tab with the rows of the table for a ${kind} catalog, read from its Parquet files`, async () => {
      const { name } = await connected(kind);

      await vscode.commands.executeCommand(
        'aantje.previewTable',
        await nodeAt(tree, name, 'sales', 'Tables', 'orders'),
      );
      const [grid] = webviews;
      assert.ok(grid);
      await waitFor('the grid page to ask for its data and get it', () => dataMessages(grid).length > 0);

      assert.deepEqual(gridTabs(), [panelTitle(name, 13)]);
      assert.deepEqual(
        webviews.map(({ viewType, title }) => ({ viewType, title })),
        [{ viewType: 'aantje.grid', title: panelTitle(name, 13) }],
      );
      assert.deepEqual(desktop.progress, ['Reading sales.orders...']);
      // Snapshot 6 deleted order 2: the tree shows snapshot 13, so the grid does too.
      assert.deepEqual(shownBy(grid, 0), orders([ORDER_1, ORDER_3]));
      assert.deepEqual(desktop.errors, []);
    });
  }

  it('shows the same panel again, with fresh data, when the same table is read a second time', async () => {
    const { name } = await connected('sqlite');
    const node = await nodeAt(tree, name, 'sales', 'Tables', 'orders');

    await vscode.commands.executeCommand('aantje.previewTable', node);
    const [grid] = webviews;
    assert.ok(grid);
    await waitFor('the first data', () => dataMessages(grid).length === 1);
    await vscode.commands.executeCommand('aantje.previewTable', node);
    await waitFor('the second data', () => dataMessages(grid).length === 2);

    assert.equal(webviews.length, 1, 'no second panel was created');
    assert.deepEqual(gridTabs(), [panelTitle(name, 13)]);
    assert.deepEqual(shownBy(grid, 1), orders([ORDER_1, ORDER_3]));
    assert.deepEqual(desktop.progress, ['Reading sales.orders...', 'Reading sales.orders...']);
  });

  it('reads the table at the snapshot that the tree shows: snapshot 5 still has the deleted order', async () => {
    const { name } = await connected('sqlite');
    await vscode.commands.executeCommand(
      'aantje.previewTable',
      await nodeAt(tree, name, 'sales', 'Tables', 'orders'),
    );
    const [latest] = webviews;
    assert.ok(latest);
    await waitFor('the data at the latest snapshot', () => dataMessages(latest).length === 1);

    desktop.answer(pick('@5'));
    await vscode.commands.executeCommand('aantje.selectSnapshot', await nodeAt(tree, name));
    await vscode.commands.executeCommand(
      'aantje.previewTable',
      await nodeAt(tree, name, 'sales', 'Tables', 'orders'),
    );
    const pinned = webviews[1];
    assert.ok(pinned);
    await waitFor('the data at snapshot 5', () => dataMessages(pinned).length === 1);

    assert.deepEqual(
      gridTabs(),
      [panelTitle(name, 13), panelTitle(name, 5)],
      'one panel per snapshot, told apart by the snapshot in the title',
    );
    assert.deepEqual(shownBy(latest, 0), orders([ORDER_1, ORDER_3]));
    assert.deepEqual(shownBy(pinned, 0), orders([ORDER_1, ORDER_2, ORDER_3]));

    // The pinned snapshot has its panel already: reading again updates that one.
    await vscode.commands.executeCommand(
      'aantje.previewTable',
      await nodeAt(tree, name, 'sales', 'Tables', 'orders'),
    );
    await waitFor('the data again', () => dataMessages(pinned).length === 2);
    assert.equal(webviews.length, 2);
    assert.equal(dataMessages(latest).length, 1);
  });

  it('shows the error and opens no tab when the DuckDB extensions cannot be installed, and names the setting', async () => {
    // A file where the directory of the extensions should be: DuckDB cannot install into it, with or without network.
    const blocker = join(tempDir(), 'not-a-directory');
    writeFileSync(blocker, '');
    await setSetting('duckdb.extensionDirectory', blocker);
    const { name } = await connected('sqlite');

    await vscode.commands.executeCommand(
      'aantje.previewTable',
      await nodeAt(tree, name, 'sales', 'Tables', 'orders'),
    );

    assert.equal(desktop.errors.length, 1);
    assert.match(desktop.errors[0] ?? '', /aantje\.duckdb\.extensionDirectory/);
    assert.deepEqual(gridTabs(), []);
    assert.deepEqual(webviews, []);
  });

  it('does nothing for a node that is no table or view, and for a call without a node', async () => {
    const { name } = await connected('sqlite');

    for (const path of [[], ['sales'], ['sales', 'Tables', 'orders', 'Columns', 'amount']]) {
      await vscode.commands.executeCommand('aantje.previewTable', await nodeAt(tree, name, ...path));
    }
    await vscode.commands.executeCommand('aantje.previewTable');

    assert.deepEqual(desktop.progress, []);
    assert.deepEqual([desktop.errors, desktop.infos, desktop.confirmations], [[], [], []]);
    assert.deepEqual(webviews, []);
  });
});
