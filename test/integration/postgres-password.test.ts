import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { CatalogTree } from '../../src/tree/model';
import { Desktop, KEEP, input, pick } from './desktop';
import { RIGHT_PASSWORD, startFakePostgres } from './fake-postgres';
import { activate, nodeAt, setConnections, uniqueId, waitFor } from './support';

describe('the password prompt of a PostgreSQL connection', () => {
  let tree: CatalogTree;
  let desktop: Desktop;
  let port: number;
  let id: string;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
    port = await startFakePostgres();
    id = uniqueId('fake-pg');
    await setConnections([
      {
        id,
        name: 'Fake pg',
        kind: 'postgres',
        host: '127.0.0.1',
        port,
        database: 'ducklake',
        user: 'catalog_user',
        ssl: false,
      },
    ]);
  });

  afterEach(() => {
    desktop.assertDone();
  });

  it('asks for the password when the server wants one and none is stored, as a masked input, and fails without one', async () => {
    desktop.answer(input(undefined));

    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, 'Fake pg'));

    desktop.assertDone();
    assert.deepEqual(
      desktop.inputs.map(({ password }) => password),
      [true],
    );
    assert.equal(tree.state(id).status, 'error');
    assert.equal(desktop.errors.length, 1);
    assert.ok(desktop.errors[0]?.includes('catalog_user'), 'the message names the user without a password');
  });

  it('opens the connection once with the new password when one edit changes the profile and the password', async () => {
    const node = await nodeAt(tree, 'Fake pg');
    desktop.answer(input(undefined));
    await vscode.commands.executeCommand('aantje.connect', node);
    assert.equal(tree.state(id).status, 'error');
    desktop.errors.length = 0;
    desktop.answer(
      input(KEEP),
      input(KEEP),
      input(KEEP),
      input('other_database'),
      pick('Password'),
      input(KEEP),
      pick('No'),
      input(RIGHT_PASSWORD),
      pick('No'),
      pick('Save anyway'),
    );

    await vscode.commands.executeCommand('aantje.editConnection', node);

    // The setting changes before the password is stored. If that change reopened the connection, it would find
    // no password, ask for one (a prompt the script does not expect) and report the old failure.
    desktop.assertDone();
    await waitFor(
      'the connection to fail with the new password: the fake server accepts it and then refuses the database',
      () => tree.state(id).error?.includes('database "ducklake" does not exist') ?? false,
    );
    assert.equal(tree.state(id).status, 'error');
  });

  // Last: when the typed password is not used, the answer stays in the script and fails only this test.
  it('tests the connection with the password that the user typed', async () => {
    desktop.answer(input(RIGHT_PASSWORD));

    await vscode.commands.executeCommand('aantje.testConnection', await nodeAt(tree, 'Fake pg'));

    desktop.assertDone();
    assert.equal(desktop.errors.length, 1);
    assert.ok(desktop.errors[0]?.includes('database "ducklake" does not exist'), desktop.errors[0]);
    assert.deepEqual(desktop.infos, []);
  });
});
