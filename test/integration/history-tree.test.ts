import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import type { CatalogTree } from '../../src/tree/model';
import type { TreeNode } from '../../src/tree/refs';
import { Desktop } from './desktop';
import { activate, copyFixture, nodeAt, setConnections, statusBar, uniqueId, waitFor } from './support';

/** The row count that the tooltip of a table states; the tree shows no count as a description. */
const rowsOf = (node: TreeNode): string | undefined => /not included\): (\S+)/.exec(node.tooltip ?? '')?.[1];

describe('the snapshots, the properties and the folders of the history catalog', () => {
  let tree: CatalogTree;
  let desktop: Desktop;
  let idA: string;
  let idB: string;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
    idA = uniqueId('history-a');
    idB = uniqueId('history-b');
    await setConnections([
      { id: idA, name: 'Lake A', kind: 'sqlite', path: copyFixture('history/history.sqlite') },
      { id: idB, name: 'Lake B', kind: 'sqlite', path: copyFixture('history/history.sqlite') },
    ]);
  });

  afterEach(() => {
    desktop.assertDone();
  });

  const connect = (name: string) =>
    vscode.commands.executeCommand(
      'aantje.connect',
      tree.roots().find((n) => n.label === name),
    );
  const untitledDocuments = (): vscode.TextDocument[] =>
    vscode.workspace.textDocuments.filter((document) => document.isUntitled);

  describe('the tree', () => {
    it('shows the folder Snapshots after the schemas and no Storage folder, the folders and the Statistics leaf of a table, and no count', async () => {
      await connect('Lake A');

      const lake = tree.roots()[0] as TreeNode;
      assert.deepEqual(
        (await tree.children(lake)).map(({ label, description }) => [label, description]),
        [
          ['main', undefined],
          ['shop', undefined],
          ['Snapshots', undefined],
        ],
      );
      assert.deepEqual(
        (await tree.children(await nodeAt(tree, 'Lake A', 'shop', 'Tables', 'events'))).map(
          ({ label, description }) => [label, description],
        ),
        [
          ['Statistics', undefined],
          ['History', undefined],
          ['Columns', undefined],
          ['Partitioning', undefined],
        ],
      );
      assert.deepEqual(
        (await tree.children(await nodeAt(tree, 'Lake A', 'shop'))).map(({ label }) => label),
        ['Tables', 'Views', 'Macros'],
      );
      const statistics = await nodeAt(tree, 'Lake A', 'shop', 'Tables', 'events', 'Statistics');
      assert.equal(statistics.hasChildren, false);
      assert.deepEqual(await tree.children(statistics), []);
      assert.equal(rowsOf(await nodeAt(tree, 'Lake A', 'shop', 'Tables', 'events')), '52');
    });

    it('does nothing for a snapshot, a macro, the Statistics leaf or a folder when a command that needs a table is run on it', async () => {
      await connect('Lake A');
      const nodes = [
        await nodeAt(tree, 'Lake A', 'Snapshots', '@24'),
        await nodeAt(tree, 'Lake A', 'Snapshots', '@24', 'shop.audit'),
        await nodeAt(tree, 'Lake A', 'shop', 'Macros', 'gross'),
        await nodeAt(tree, 'Lake A', 'shop', 'Tables', 'events', 'Statistics'),
        await nodeAt(tree, 'Lake A', 'shop', 'Tables', 'events', 'History'),
        await nodeAt(tree, 'Lake A', 'shop', 'Tables', 'events', 'Partitioning', 'kind'),
      ];
      const before = untitledDocuments().length;

      for (const command of [
        'aantje.copyName',
        'aantje.copyDdl',
        'aantje.scriptCreate',
        'aantje.scriptSelect',
        'aantje.scriptAlter',
        'aantje.scriptDrop',
        'aantje.previewTable',
        'aantje.createNotebook',
      ]) {
        for (const node of nodes) {
          // A macro has all four scripts (macros-maintenance.test.ts), and every node here has a SELECT but the partition
          // column, which shows a fact only; CREATE, ALTER and DROP are for tables, views, macros and the folders above them.
          if (node.ref.kind === 'macro' && command.startsWith('aantje.script')) {
            continue;
          }
          if (command === 'aantje.scriptSelect' && node.ref.kind !== 'detail') {
            continue;
          }
          if (command === 'aantje.scriptSelect' && node.ref.kind === 'detail' && node.ref.change) {
            continue;
          }
          await vscode.commands.executeCommand(command, node);
        }
      }

      assert.deepEqual(desktop.copied, []);
      assert.deepEqual(desktop.errors, []);
      assert.deepEqual(desktop.confirmations, []);
      assert.deepEqual(desktop.progress, []);
      assert.equal(untitledDocuments().length, before);
    });
  });

  describe('Show Catalog at this Snapshot', () => {
    it('pins the tree of that connection to the snapshot, makes the connection the active one, and can go on to another snapshot', async () => {
      await connect('Lake A');
      await connect('Lake B');
      await waitFor('"Lake B" in the status bar', () => statusBar().text.startsWith('$(database) Lake B'));

      await vscode.commands.executeCommand(
        'aantje.showSnapshot',
        await nodeAt(tree, 'Lake A', 'Snapshots', '@24'),
      );

      assert.equal(tree.state(idA).snapshot, 24);
      assert.equal(
        tree.state(idB).snapshot,
        'latest',
        'the other connection keeps following the latest snapshot',
      );
      assert.equal(rowsOf(await nodeAt(tree, 'Lake A', 'shop', 'Tables', 'customers')), '4');
      assert.equal(rowsOf(await nodeAt(tree, 'Lake B', 'shop', 'Tables', 'customers')), '5');
      assert.ok(statusBar().text.startsWith('$(database) Lake A'), 'Lake A is the active connection');
      assert.ok(statusBar().text.includes('@24'), statusBar().text);

      await vscode.commands.executeCommand(
        'aantje.showSnapshot',
        await nodeAt(tree, 'Lake A', 'Snapshots', '@10'),
      );

      assert.equal(tree.state(idA).snapshot, 10);
      assert.equal(rowsOf(await nodeAt(tree, 'Lake A', 'shop', 'Tables', 'events')), '51');
    });

    it('does nothing without a node and on a node that is not a snapshot', async () => {
      await connect('Lake A');

      await vscode.commands.executeCommand('aantje.showSnapshot');
      await vscode.commands.executeCommand('aantje.showSnapshot', await nodeAt(tree, 'Lake A', 'shop'));
      await vscode.commands.executeCommand(
        'aantje.showSnapshot',
        await nodeAt(tree, 'Lake A', 'Snapshots', '@24', 'shop.audit'),
      );

      assert.equal(tree.state(idA).snapshot, 'latest');
    });
  });

  describe('Show Latest Snapshot', () => {
    const run = (name: string) =>
      vscode.commands.executeCommand(
        'aantje.showLatestSnapshot',
        tree.roots().find((n) => n.label === name),
      );

    it('follows the newest snapshot again (also from a pin on the newest id), makes the connection the active one, and leaves the other connection alone', async () => {
      await connect('Lake A');
      await connect('Lake B');
      await waitFor('"Lake B" in the status bar', () => statusBar().text.startsWith('$(database) Lake B'));
      tree.selectSnapshot(idA, 24);
      tree.selectSnapshot(idB, 10);

      await run('Lake A');

      assert.equal(tree.state(idA).snapshot, 'latest');
      assert.equal(tree.state(idB).snapshot, 10, 'the other connection keeps its pin');
      assert.equal(rowsOf(await nodeAt(tree, 'Lake A', 'shop', 'Tables', 'customers')), '5');
      assert.ok(statusBar().text.startsWith('$(database) Lake A'), 'Lake A is the active connection');
      assert.ok(statusBar().text.includes(`(@${HISTORY_LATEST_SNAPSHOT})`), statusBar().text);

      tree.selectSnapshot(idA, HISTORY_LATEST_SNAPSHOT);
      assert.equal(tree.state(idA).snapshot, HISTORY_LATEST_SNAPSHOT);
      await run('Lake A');

      assert.equal(tree.state(idA).snapshot, 'latest');
      assert.deepEqual(desktop.infos, []);
    });

    it('says so and changes nothing when the connection already follows the newest snapshot, and asks to connect first when it is not open', async () => {
      await run('Lake A');
      assert.equal(desktop.infos.length, 1, 'connect first');
      assert.equal(tree.state(idA).snapshot, 'latest');

      await connect('Lake A');
      await connect('Lake B');
      await waitFor('"Lake B" in the status bar', () => statusBar().text.startsWith('$(database) Lake B'));

      await run('Lake A');

      assert.equal(desktop.infos.length, 2, 'already the latest');
      assert.ok(desktop.infos[1]?.includes('Lake A'), desktop.infos[1]);
      assert.equal(tree.state(idA).snapshot, 'latest');
      assert.ok(statusBar().text.startsWith('$(database) Lake B'), 'the active connection is not changed');
    });
  });
});
