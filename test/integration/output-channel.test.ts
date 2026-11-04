import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { CatalogTree } from '../../src/tree/model';
import { LATEST_SNAPSHOT } from '../support/expected';
import { Desktop, input, pick } from './desktop';
import {
  activate,
  copyFixture,
  freePort,
  nodeAt,
  readOutputChannel,
  setConnections,
  tempDir,
  uniqueId,
  waitFor,
} from './support';

// VS Code writes the "aantje" output channel to a log file of the extension host; these tests read that file.
describe('the "aantje" output channel', () => {
  let tree: CatalogTree;
  let desktop: Desktop;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
  });

  afterEach(() => {
    desktop.assertDone();
  });

  const logs = (text: string) =>
    waitFor(`the output channel to say: ${text}`, () => readOutputChannel().includes(text));

  it('records that a catalog was opened, with its version and newest snapshot, and that it was closed', async () => {
    const name = uniqueId('Logged lake');
    await setConnections([{ id: name, name, kind: 'sqlite', path: copyFixture('ducklake.sqlite') }]);
    const node = await nodeAt(tree, name);

    await vscode.commands.executeCommand('aantje.connect', node);
    await logs(`[info] Connected to "${name}" (DuckLake 1.1, latest snapshot ${LATEST_SNAPSHOT})`);

    await vscode.commands.executeCommand('aantje.disconnect', node);
    await logs(`[info] Disconnected from "${name}"`);
  });

  it('records why a connection failed, with the code and the path that the user message leaves out', async () => {
    const name = uniqueId('Failing lake');
    const missing = join(tempDir(), 'missing.sqlite');
    await setConnections([{ id: name, name, kind: 'sqlite', path: missing }]);

    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, name));

    await logs(`[error] Cannot connect to "${name}"`);
    await logs(`FILE_NOT_FOUND: Cannot read "${missing}"`);
  });

  it('masks a password that the user typed, also where the name of a connection contains it', async () => {
    const password = 'tiger-4711-pw';
    const name = `Secret ${password}`;
    desktop.answer(
      pick('PostgreSQL'),
      input(name),
      input('127.0.0.1'),
      input(String(await freePort())),
      input('ducklake'),
      pick('Password'),
      input('catalog_user'),
      pick('No'),
      input(password),
      pick('No'),
      pick('Save anyway'),
    );
    await vscode.commands.executeCommand('aantje.addConnection');
    desktop.assertDone();

    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, name));

    await logs('[error] Cannot connect to "Secret ***"');
    assert.ok(!readOutputChannel().includes(password), 'the output channel never shows the password');
  });
});
