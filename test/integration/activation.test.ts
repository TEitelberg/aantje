import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { Desktop } from './desktop';
import {
  activate,
  connectionsSetting,
  copyFixture,
  extension,
  observeTree,
  setConnections,
  uniqueId,
  waitFor,
} from './support';

interface Manifest {
  readonly contributes: {
    readonly commands: readonly { readonly command: string }[];
  };
}

describe('the extension host of the test run', () => {
  it('has a profile of its own: no other extension, no connections, and the test workspace', () => {
    const userExtensions = vscode.extensions.all.filter(
      (candidate) => !(candidate.packageJSON as { isBuiltin?: boolean }).isBuiltin,
    );
    assert.deepEqual(
      userExtensions.map((candidate) => candidate.id),
      ['teitelberg.aantje'],
    );
    assert.equal(
      extension().isActive,
      false,
      'the extension is activated by the first command or view, not by start-up',
    );
    assert.equal(connectionsSetting(), undefined, 'the user settings of the developer do not leak in');
    const same = (path: string): string => resolve(path).toLowerCase();
    assert.deepEqual(
      vscode.workspace.workspaceFolders?.map((folder) => same(folder.uri.fsPath)),
      [same(join(extension().extensionPath, 'test', 'integration', 'workspace'))],
    );
  });
});

// The first test of this suite needs the extension to be inactive, so it must run before anything activates it.
describe('activation', () => {
  it('reports an invalid entry of "aantje.connections" once while it starts, and shows the valid ones', async () => {
    assert.equal(extension().isActive, false);
    const id = uniqueId('startup');
    const valid = { id, name: 'Valid lake', kind: 'sqlite', path: copyFixture('ducklake.sqlite') };
    const invalid = { name: 'Broken lake', kind: 'oracle' };
    await setConnections([valid, invalid]);
    const desktop = Desktop.install();

    const { tree } = await activate();

    assert.deepEqual(desktop.warnings, [
      'An entry of "aantje.connections" is invalid and was skipped. See the "aantje" output channel.',
    ]);
    assert.deepEqual(
      tree.roots().map((node) => node.label),
      ['Valid lake'],
    );
    // The next change of the setting still contains the same invalid entry: no second warning.
    const second = { id: uniqueId('startup'), name: 'Second lake', kind: 'sqlite', path: valid.path };
    await setConnections([valid, invalid, second]);
    assert.deepEqual(
      tree.roots().map((node) => node.label),
      ['Valid lake', 'Second lake'],
    );
    assert.equal(desktop.warnings.length, 1);
    desktop.assertDone();
  });

  it('hands out the tree and offers no connection while the setting is empty', async () => {
    const api = await activate();

    assert.ok(extension().isActive);
    assert.deepEqual(api.tree.roots(), []);
  });

  it('registers every command that package.json declares, and no other', async () => {
    await activate();
    const declared = (extension().packageJSON as Manifest).contributes.commands.map(({ command }) => command);

    // VS Code registers aantje.catalogs.focus, .open and a few more for the view itself.
    const registered = (await vscode.commands.getCommands(true)).filter(
      (command) => command.startsWith('aantje.') && !command.startsWith('aantje.catalogs.'),
    );

    assert.deepEqual(registered.toSorted(), declared.toSorted());
  });

  it('opens the aantje view container, and the tree view asks the tree for its connections', async () => {
    const { tree } = await activate();
    const roots = observeTree(tree, 'roots');
    // Dirty while the view is hidden, so that showing the view has to read the roots again.
    tree.refresh();
    await vscode.commands.executeCommand('workbench.action.closeSidebar');

    await vscode.commands.executeCommand('workbench.view.extension.aantje');

    await waitFor('the tree view to read the roots from the provider', () => roots.length > 0);
  });
});
