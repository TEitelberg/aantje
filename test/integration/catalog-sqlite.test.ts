import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import * as vscode from 'vscode';
import type { CatalogTree } from '../../src/tree/model';
import type { TreeNode } from '../../src/tree/refs';
import { LATEST_SNAPSHOT, SNAPSHOT, SPEC_VERSION } from '../support/expected';
import { Desktop, pick } from './desktop';
import {
  BIG_ORDERS_DDL,
  ORDERS_DDL,
  PLAIN_DDL_AT_CREATION,
  PLAIN_DDL_AT_LATEST,
  SEARCH_ROWS,
  SNAPSHOT_ROWS,
  treeAtLatest,
  treeAtSnapshot5,
} from './expectations';
import {
  activate,
  copyFixture,
  extension,
  nodeAt,
  observeReveals,
  observeTree,
  outline,
  setConnections,
  tempDir,
  uniqueId,
  waitFor,
  waitUntilClosed,
} from './support';

const NAME = 'Fixture lake';

/** Runs statements against a catalog file, like another process that writes to it. */
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

/** Another process commits a snapshot that creates the schema "late" to the catalog file. */
function commitSchemaLate(path: string): Promise<void> {
  return editCatalog(path, [
    "INSERT INTO ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (14, '2026-10-30 08:00:00.000000+00', 11, 8, 3)",
    `INSERT INTO ducklake_snapshot_changes (snapshot_id, changes_made) VALUES (14, 'created_schema:"late"')`,
    "INSERT INTO ducklake_schema (schema_id, schema_uuid, begin_snapshot, schema_name, path, path_is_relative) VALUES (6, 'late', 14, 'late', 'late/', 1)",
  ]);
}

describe('a SQLite catalog in the explorer', () => {
  let tree: CatalogTree;
  let view: vscode.TreeView<TreeNode>;
  let id: string;
  let path: string;
  let desktop: Desktop;

  beforeEach(async () => {
    ({ tree, view } = await activate());
    desktop = Desktop.install();
    id = uniqueId('sqlite');
    path = copyFixture('ducklake.sqlite');
    await setConnections([{ id, name: NAME, kind: 'sqlite', path }]);
  });

  afterEach(() => {
    desktop.assertDone();
  });

  /** What the user does: click "Connect" on the connection. */
  async function connect(): Promise<TreeNode> {
    const root = await nodeAt(tree, NAME);
    await vscode.commands.executeCommand('aantje.connect', root);
    return root;
  }

  it('lists the profile of the setting as a connection that is not opened yet', () => {
    const [root, ...others] = tree.roots();
    assert.deepEqual(others, []);
    assert.deepEqual(
      { label: root?.label, description: root?.description, contextValue: root?.contextValue },
      { label: NAME, description: 'sqlite', contextValue: 'connection.disconnected' },
    );
    assert.deepEqual(tree.state(id), { status: 'disconnected', snapshot: 'latest' });
    assert.equal(tree.reader(id), undefined);
  });

  it('shows the exact schemas, tables, views and nested columns of the catalog after "Connect"', async () => {
    const root = await connect();

    assert.deepEqual(tree.state(id), {
      status: 'connected',
      specVersion: SPEC_VERSION,
      latestSnapshot: LATEST_SNAPSHOT,
      snapshot: 'latest',
    });
    assert.equal(root.contextValue, 'connection.connected');
    assert.deepEqual(await outline(tree, root), treeAtLatest(`${NAME} : sqlite · DuckLake 1.1 · @13`));
    assert.deepEqual(desktop.errors, []);
  });

  it('copies the qualified name of schemas, tables, views and nested columns', async () => {
    await connect();
    const copyName = async (...path: string[]) =>
      desktop.copiedBy('aantje.copyName', await nodeAt(tree, NAME, ...path));

    assert.deepEqual(await copyName('sales', 'Tables', 'orders', 'Columns', 'customer', 'name'), [
      '"sales"."orders"."customer"."name"',
    ]);
    assert.deepEqual(await copyName('sales', 'Tables', 'orders', 'Columns', 'customer', 'tags', 'element'), [
      '"sales"."orders"."customer"."tags"."element"',
    ]);
    assert.deepEqual(await copyName('sales', 'Tables', 'orders', 'Columns', 'amount'), [
      '"sales"."orders"."amount"',
    ]);
    assert.deepEqual(await copyName('sales', 'Tables', 'orders'), ['"sales"."orders"']);
    assert.deepEqual(await copyName('sales', 'Views', 'big_orders'), ['"sales"."big_orders"']);
    assert.deepEqual(await copyName('main'), ['"main"']);
    assert.deepEqual(await copyName(), [], 'a connection has no name in SQL');
    assert.equal(desktop.statusMessages.at(0), 'Copied "sales"."orders"."customer"."name"');
    assert.equal(desktop.statusMessages.length, 6, 'one confirmation per copy');
  });

  it('copies the CREATE statement of a table with its nested columns and of a view', async () => {
    await connect();
    const copyDdl = async (...path: string[]) =>
      desktop.copiedBy('aantje.copyDdl', await nodeAt(tree, NAME, ...path));

    assert.deepEqual(await copyDdl('sales', 'Tables', 'orders'), [ORDERS_DDL]);
    assert.deepEqual(await copyDdl('sales', 'Views', 'big_orders'), [BIG_ORDERS_DDL]);
    assert.deepEqual(await copyDdl('sales'), [], 'a schema has no CREATE statement');
    assert.deepEqual(
      await copyDdl('sales', 'Tables', 'orders', 'Columns', 'amount'),
      [],
      'a column has no CREATE statement',
    );
    assert.deepEqual(desktop.statusMessages, ['Copied the DDL of orders', 'Copied the DDL of big_orders']);
  });

  it('shows the catalog as it was at an older snapshot and copies the DDL of that snapshot', async () => {
    const root = await connect();
    const copyPlainDdl = async () =>
      desktop.copiedBy('aantje.copyDdl', await nodeAt(tree, NAME, 'main', 'Tables', 'plain'));

    tree.selectSnapshot(id, SNAPSHOT.insertTmp);
    assert.deepEqual(
      await outline(tree, root),
      treeAtSnapshot5(`${NAME} : sqlite · DuckLake 1.1 · @5 (pinned)`),
    );

    tree.selectSnapshot(id, SNAPSHOT.createPlain);
    assert.deepEqual(await copyPlainDdl(), [PLAIN_DDL_AT_CREATION]);

    tree.selectSnapshot(id, 'latest');
    assert.deepEqual(await copyPlainDdl(), [PLAIN_DDL_AT_LATEST]);
    assert.deepEqual(await outline(tree, root), treeAtLatest(`${NAME} : sqlite · DuckLake 1.1 · @13`));
  });

  it('pins the snapshot that the user picks in "Show Catalog at Snapshot" and follows the latest again on "Latest"', async () => {
    const root = await connect();

    desktop.answer(pick('@5'));
    await vscode.commands.executeCommand('aantje.selectSnapshot', root);
    assert.deepEqual(
      desktop.picks[0]?.rows.map(({ label, detail }) => ({ label, detail })),
      SNAPSHOT_ROWS,
    );
    assert.equal(desktop.picks[0]?.rows[0]?.description, '@13');
    assert.ok(
      desktop.picks[0]?.rows
        .slice(1)
        .every((row) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/.test(row.description ?? '')),
      'the other rows show the commit time in UTC',
    );
    assert.deepEqual(desktop.picks[0]?.active, ['Latest']);
    assert.equal(desktop.picks[0]?.title, `Snapshot of "${NAME}"`);
    assert.equal(desktop.picks[0]?.placeholder, 'Choose the snapshot the tree shows');
    assert.equal(tree.state(id).snapshot, SNAPSHOT.insertTmp);
    assert.deepEqual(
      await outline(tree, root),
      treeAtSnapshot5(`${NAME} : sqlite · DuckLake 1.1 · @5 (pinned)`),
    );

    desktop.answer(pick('Latest'));
    await vscode.commands.executeCommand('aantje.selectSnapshot', root);
    assert.deepEqual(desktop.picks[1]?.active, ['@5'], 'the picker highlights the snapshot that is shown');
    assert.equal(tree.state(id).snapshot, 'latest');
    desktop.assertDone();
  });

  it('offers the snapshots of a catalog whose newest snapshot is 0', async () => {
    const fresh = copyFixture('ducklake.sqlite');
    await editCatalog(fresh, ['DELETE FROM ducklake_snapshot WHERE snapshot_id > 0']);
    await setConnections([{ id, name: NAME, kind: 'sqlite', path: fresh }]);
    const root = await connect();
    assert.equal(tree.state(id).latestSnapshot, 0);
    desktop.answer(pick('Latest'));

    await vscode.commands.executeCommand('aantje.selectSnapshot', root);

    desktop.assertDone();
    assert.deepEqual(
      desktop.picks[0]?.rows.map(({ label }) => label),
      ['Latest', '@0'],
    );
    assert.deepEqual(desktop.infos, []);
  });

  it('keeps the snapshot when the user cancels the picker', async () => {
    const root = await connect();
    desktop.answer(pick(undefined));
    await vscode.commands.executeCommand('aantje.selectSnapshot', root);
    assert.equal(tree.state(id).snapshot, 'latest');
    desktop.assertDone();
  });

  it('lists every table and view of the catalog in the search, sorted by schema and name', async () => {
    await connect();
    desktop.answer(pick(undefined));

    await vscode.commands.executeCommand('aantje.search');

    desktop.assertDone();
    assert.equal(desktop.picks[0]?.title, `Search "${NAME}"`);
    assert.equal(desktop.picks[0]?.placeholder, 'Type the name of a table or view');
    assert.deepEqual(
      desktop.picks[0]?.rows.map(({ label, description }) => ({ label, description })),
      SEARCH_ROWS,
    );
  });

  it('searches the snapshot that the tree shows, also when it is the first one', async () => {
    await connect();
    tree.selectSnapshot(id, 0);
    desktop.answer(pick(undefined));

    await vscode.commands.executeCommand('aantje.search');

    desktop.assertDone();
    assert.deepEqual(desktop.infos, []);
    assert.deepEqual(desktop.picks[0]?.rows, []);
  });

  it('searches the tables and views of the snapshot that the tree shows, not of the newest one', async () => {
    await connect();
    tree.selectSnapshot(id, SNAPSHOT.insertTmp);
    const parents = observeTree(tree, 'parent');
    desktop.answer(pick('sales.tmp'));

    await vscode.commands.executeCommand('aantje.search');

    desktop.assertDone();
    assert.deepEqual(desktop.picks[0]?.rows, [
      { label: 'sales.orders', description: 'table' },
      { label: 'sales.tmp', description: 'table' },
    ]);
    await waitFor('the tree view to reveal "tmp"', () =>
      parents.some(([node]) => (node as TreeNode).label === 'tmp'),
    );
  });

  it('lets the user find a snapshot by what changed and a table by its kind', async () => {
    const root = await connect();
    desktop.answer(pick(undefined), pick(undefined));

    await vscode.commands.executeCommand('aantje.selectSnapshot', root);
    await vscode.commands.executeCommand('aantje.search');

    desktop.assertDone();
    assert.deepEqual(desktop.pickerOptions, [
      { matchOnDescription: true, matchOnDetail: true },
      { matchOnDescription: true, matchOnDetail: true },
    ]);
  });

  for (const [hit, name, folder] of [
    ['main.plain', 'plain', 'Tables'],
    ['sales.big_orders', 'big_orders', 'Views'],
    ['sales.orders', 'orders', 'Tables'],
  ] as const) {
    it(`reveals "${hit}" in the tree view when the user picks it in the search`, async () => {
      await connect();
      const parents = observeTree(tree, 'parent');
      const reveals = observeReveals(view);
      desktop.answer(pick(hit));

      await vscode.commands.executeCommand('aantje.search');

      desktop.assertDone();
      await waitFor(`"${name}" to be selected in the tree view`, () => view.selection[0]?.label === name);
      const revealed = () => parents.map(([node]) => (node as TreeNode).label);
      await waitFor(`the tree view to reveal "${name}"`, () => revealed().includes(name));
      await waitFor(`the tree view to reveal the folder "${folder}" of "${name}"`, () =>
        revealed().includes(folder),
      );
      const hits = ['plain', 'big_orders', 'orders'];
      assert.deepEqual(
        revealed().filter((label) => hits.includes(label)),
        [name],
        'no other hit is revealed',
      );
      assert.deepEqual(
        reveals,
        [{ select: true, focus: true }],
        'the hit is selected and the view gets the focus',
      );
    });
  }

  it('opens the catalog again on "Refresh", so that the latest snapshot and new commits show up', async () => {
    const root = await connect();
    const before = tree.reader(id);
    assert.ok(before);
    await commitSchemaLate(path);
    assert.equal(
      tree.state(id).latestSnapshot,
      LATEST_SNAPSHOT,
      'a connected catalog does not change by itself',
    );

    await vscode.commands.executeCommand('aantje.refresh', root);

    await waitFor('the refreshed catalog', () => tree.state(id).latestSnapshot === LATEST_SNAPSHOT + 1);
    assert.deepEqual((await outline(tree, root)).slice(0, 2), [
      `${NAME} : sqlite · DuckLake 1.1 · @14`,
      '  late',
    ]);
    await waitUntilClosed(before);
  });

  it('refreshes all connections when the command runs without a node (title bar button)', async () => {
    await connect();
    await commitSchemaLate(path);

    await vscode.commands.executeCommand('aantje.refresh');

    await waitFor('the refreshed catalog', () => tree.state(id).latestSnapshot === LATEST_SNAPSHOT + 1);
  });

  it('closes the reader and forgets the pinned snapshot on "Disconnect"', async () => {
    const root = await connect();
    tree.selectSnapshot(id, SNAPSHOT.insertTmp);
    const reader = tree.reader(id);
    assert.ok(reader);

    await vscode.commands.executeCommand('aantje.disconnect', root);

    assert.deepEqual(tree.state(id), { status: 'disconnected', snapshot: 'latest' });
    assert.equal(root.contextValue, 'connection.disconnected');
    assert.equal(
      root.hasChildren,
      false,
      'a disconnected connection does not reconnect when the view re-reads it',
    );
    assert.equal(tree.reader(id), undefined);
    await waitUntilClosed(reader);
  });

  it('removes the node and closes the reader when the profile leaves the setting', async () => {
    await connect();
    const reader = tree.reader(id);
    assert.ok(reader);

    await setConnections(undefined);

    assert.deepEqual(tree.roots(), []);
    assert.equal(tree.reader(id), undefined);
    await waitUntilClosed(reader);
  });

  it('tests a connection without opening it in the tree', async () => {
    const root = await nodeAt(tree, NAME);

    await vscode.commands.executeCommand('aantje.testConnection', root);

    assert.deepEqual(desktop.progress, [`Testing connection "${NAME}"...`]);
    assert.deepEqual(desktop.infos, [
      `The connection "${NAME}" works. DuckLake spec version 1.1, latest snapshot 13.`,
    ]);
    assert.deepEqual(desktop.errors, []);
    assert.deepEqual(tree.state(id), { status: 'disconnected', snapshot: 'latest' });
  });

  describe('when the catalog file is missing', () => {
    let missing: string;

    beforeEach(async () => {
      missing = join(tempDir(), 'missing.sqlite');
      await setConnections([{ id, name: 'Missing lake', kind: 'sqlite', path: missing }]);
    });

    it('reports the failure of "Test Connection"', async () => {
      await vscode.commands.executeCommand('aantje.testConnection', await nodeAt(tree, 'Missing lake'));

      assert.deepEqual(desktop.errors, [`Connection test failed: Cannot read "${missing}": ENOENT.`]);
      assert.deepEqual(desktop.infos, []);
    });

    it('shows the error on the connection and in a message on "Connect"', async () => {
      const root = await nodeAt(tree, 'Missing lake');

      await vscode.commands.executeCommand('aantje.connect', root);

      const message = `Cannot read "${missing}": ENOENT.`;
      assert.deepEqual(tree.state(id), { status: 'error', snapshot: 'latest', error: message });
      assert.deepEqual(desktop.errors, [`Cannot connect to "Missing lake": ${message}`]);
      assert.equal(root.contextValue, 'connection.error');
      assert.deepEqual(await outline(tree, root), [
        'Missing lake : sqlite · connection failed',
        `  ${message}`,
      ]);
    });
  });
});
