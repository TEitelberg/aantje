import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import type { CatalogTree } from '../../src/tree/model';
import type { TreeNode } from '../../src/tree/refs';
import { LATEST_SNAPSHOT, SNAPSHOT } from '../support/expected';
import { Desktop } from './desktop';
import { PLAIN_DDL_AT_CREATION, treeAtLatest, treeAtSnapshot5 } from './expectations';
import {
  activate,
  copyFixture,
  nodeAt,
  outline,
  setConnections,
  setQueryTimeout,
  uniqueId,
  waitFor,
  waitUntilClosed,
} from './support';

const NAME = 'Fixture lake (DuckDB)';
const CONNECTION = `${NAME} : duckdb · DuckLake 1.1 · @13`;

// The DuckDB driver imports the native binding (@duckdb/node-api) with a dynamic import() the first time a
// DuckDB catalog is opened. These tests prove that this works inside VS Code's extension host.
describe('a DuckDB catalog in the explorer', () => {
  let tree: CatalogTree;
  let id: string;
  let path: string;
  let desktop: Desktop;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
    id = uniqueId('duckdb');
    path = copyFixture('ducklake.duckdb');
    await setConnections([{ id, name: NAME, kind: 'duckdb', path }]);
  });

  afterEach(() => {
    desktop.assertDone();
  });

  /**
   * Windows lets a program delete a DuckDB file that is still open, and then refuses to remove the folder
   * until the file is really closed. Removing the folder is therefore the proof that nothing holds the file.
   */
  function removeCatalogFolder(): void {
    rmSync(dirname(path), { recursive: true, maxRetries: 40, retryDelay: 100 });
  }

  async function connect(): Promise<TreeNode> {
    const root = await nodeAt(tree, NAME);
    await vscode.commands.executeCommand('aantje.connect', root);
    return root;
  }

  it('loads the native DuckDB engine and shows the exact catalog after "Connect", also at an older snapshot', async () => {
    const root = await connect();

    assert.deepEqual(desktop.errors, [], 'the connection did not fail');
    assert.equal(tree.state(id).status, 'connected');
    assert.deepEqual(await outline(tree, root), treeAtLatest(CONNECTION));

    tree.selectSnapshot(id, SNAPSHOT.insertTmp);
    assert.deepEqual(
      await outline(tree, root),
      treeAtSnapshot5(`${NAME} : duckdb · DuckLake 1.1 · @5 (pinned)`),
    );
    tree.selectSnapshot(id, SNAPSHOT.createPlain);
    assert.deepEqual(
      await desktop.copiedBy('aantje.copyDdl', await nodeAt(tree, NAME, 'main', 'Tables', 'plain')),
      [PLAIN_DDL_AT_CREATION],
    );
  });

  it('opens the catalog again on "Refresh" and closes the reader it replaced', async () => {
    const root = await connect();
    const before = tree.reader(id);
    assert.ok(before);

    await vscode.commands.executeCommand('aantje.refresh', root);

    await waitFor('the catalog to be opened again', () => {
      const reader = tree.reader(id);
      return reader && reader !== before;
    });
    assert.deepEqual(await outline(tree, root), treeAtLatest(CONNECTION));
    await waitUntilClosed(before);
  });

  it('gives the file back on "Disconnect": the catalog can be deleted and the reader is closed', async () => {
    const root = await connect();
    const reader = tree.reader(id);
    assert.ok(reader);

    await vscode.commands.executeCommand('aantje.disconnect', root);

    await waitUntilClosed(reader);
    removeCatalogFolder();
    assert.deepEqual(tree.state(id), { status: 'disconnected', snapshot: 'latest' });
  });

  it('tests a connection without keeping the file open', async () => {
    await vscode.commands.executeCommand('aantje.testConnection', await nodeAt(tree, NAME));

    assert.equal(desktop.infos.length, 1);
    assert.match(desktop.infos[0] ?? '', new RegExp(`latest snapshot ${LATEST_SNAPSHOT}`));
    assert.deepEqual(desktop.errors, []);
    // The test connection closes its own reader, so nothing holds the file any more.
    removeCatalogFolder();
  });

  // The manifest only hints at a minimum of 1; VS Code hands a 0 to the extension all the same, and a time
  // limit of 0 seconds would cancel every query.
  it('falls back to the default time limit when aantje.queryTimeoutSeconds is 0', async () => {
    await setQueryTimeout(0);
    try {
      const root = await connect();

      assert.deepEqual(desktop.errors, [], 'the connection did not fail');
      assert.deepEqual(await outline(tree, root), treeAtLatest(CONNECTION));
    } finally {
      await setQueryTimeout(undefined);
    }
  });
});
