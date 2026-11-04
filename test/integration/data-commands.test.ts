import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { CatalogTree } from '../../src/tree/model';
import { gridTabs, observeWebviews } from './data';
import { confirm, Desktop } from './desktop';
import { activate, copyFixture, nodeAt, setConnections, uniqueId } from './support';

describe('Create Notebook', () => {
  let tree: CatalogTree;
  let desktop: Desktop;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
  });

  afterEach(() => {
    desktop.assertDone();
  });

  /** The metadata-only catalog suffices: nothing reads table data before the notebook is opened. */
  async function connected(): Promise<string> {
    const id = uniqueId('notebook');
    await setConnections([{ id, name: id, kind: 'sqlite', path: copyFixture('ducklake.sqlite') }]);
    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, id));
    return id;
  }

  it('explains that the Jupyter extension is needed when it is not installed, and opens no notebook', async () => {
    const id = await connected();
    assert.equal(
      vscode.extensions.getExtension('ms-toolsai.jupyter'),
      undefined,
      'the test host has no Jupyter',
    );

    await vscode.commands.executeCommand(
      'aantje.createNotebook',
      await nodeAt(tree, id, 'sales', 'Tables', 'orders'),
    );

    assert.equal(desktop.errors.length, 1);
    assert.match(desktop.errors[0] ?? '', /ms-toolsai\.jupyter/);
    assert.deepEqual(vscode.workspace.notebookDocuments, []);
  });

  it('asks first when the node is a view, and does not go on when the user declines', async () => {
    const id = await connected();
    desktop.answer(confirm(false), confirm(true));
    const view = await nodeAt(tree, id, 'sales', 'Views', 'big_orders');

    await vscode.commands.executeCommand('aantje.createNotebook', view);
    await vscode.commands.executeCommand('aantje.createNotebook', view);

    assert.equal(desktop.confirmations.length, 2);
    // Declining is the user's choice and is reported as information; accepting leads to the missing Jupyter extension.
    assert.equal(desktop.infos.length, 1);
    assert.equal(desktop.errors.length, 1);
    assert.deepEqual(vscode.workspace.notebookDocuments, []);
  });

  it('does nothing for a schema, a column or a call without a node', async () => {
    const id = await connected();
    const webviews = observeWebviews();

    for (const path of [[], ['sales'], ['sales', 'Tables', 'orders', 'Columns', 'amount']]) {
      await vscode.commands.executeCommand('aantje.createNotebook', await nodeAt(tree, id, ...path));
    }
    await vscode.commands.executeCommand('aantje.createNotebook');

    assert.deepEqual(
      [desktop.errors, desktop.infos, desktop.confirmations, gridTabs(), webviews],
      [[], [], [], [], []],
    );
  });
});
