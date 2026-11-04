import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { CatalogTree } from '../../src/tree/model';
import { LATEST_SNAPSHOT } from '../support/expected';
import { Desktop, KEEP, confirm, input, pick } from './desktop';
import type { Answer } from './desktop';
import { RIGHT_PASSWORD, startFakePostgres } from './fake-postgres';
import {
  activate,
  connectionsSetting,
  copyFixture,
  freePort,
  nodeAt,
  setConnections,
  tempDir,
  uniqueId,
  waitFor,
  waitUntilClosed,
} from './support';

const KIND_TITLE = 'Add Connection: where is the DuckLake metadata stored?';
const KIND_ROWS = [
  { label: 'PostgreSQL', description: 'Catalog stored in a PostgreSQL database' },
  { label: 'SQLite', description: 'Catalog stored in a SQLite database file' },
  { label: 'DuckDB', description: 'Catalog stored in a DuckDB database file' },
  { label: 'DuckDB + Quack', description: 'Catalog served by a DuckDB server over the Quack protocol' },
];
const READ_ONLY_PROMPT = {
  sqlite: 'Open SQL editor sessions read-only?',
  duckdb:
    'Open SQL editor sessions read-only? A writable session locks the DuckDB file exclusively, so the explorer cannot read it while the editor has it open.',
} as const;
const READ_ONLY_ROWS = [
  { label: 'No', description: 'Writable session: runs any statement the credentials allow' },
  { label: 'Yes', description: 'Read-only session: refuses statements that change the lake' },
];
const SAVED = (name: string): string =>
  `Saved connection "${name}". DuckLake spec version 1.1, latest snapshot ${LATEST_SNAPSHOT}.`;

describe('the connection wizard', () => {
  let tree: CatalogTree;
  let desktop: Desktop;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
  });

  afterEach(() => {
    desktop.assertDone();
  });

  /** Runs "Add Connection..." with a script for the prompts. */
  async function add(...answers: Answer[]): Promise<void> {
    desktop.answer(...answers);
    await vscode.commands.executeCommand('aantje.addConnection');
  }

  const prompts = () =>
    desktop.inputs.map(({ title, prompt, value, password }) => ({ title, prompt, value, password }));

  describe('adding a connection to a catalog file', () => {
    for (const [kind, label, fixture] of [
      ['sqlite', 'SQLite', 'ducklake.sqlite'],
      ['duckdb', 'DuckDB', 'ducklake.duckdb'],
    ] as const) {
      it(`asks for the kind, the name and the ${label} file, tests the connection and saves it`, async () => {
        const path = copyFixture(fixture);
        const name = `Wizard ${kind}`;

        await add(pick(label), input(name), input(path), pick(kind === 'duckdb' ? 'Yes' : 'No'));

        desktop.assertDone();
        assert.deepEqual(desktop.picks, [
          { title: KIND_TITLE, placeholder: undefined, rows: KIND_ROWS, active: [] },
          {
            title: `Add Connection (3/3): ${READ_ONLY_PROMPT[kind]}`,
            placeholder: undefined,
            rows: kind === 'duckdb' ? [...READ_ONLY_ROWS].reverse() : READ_ONLY_ROWS,
            active: [],
          },
        ]);
        assert.deepEqual(prompts(), [
          {
            title: 'Add Connection (1/3)',
            prompt: 'Name shown in the explorer',
            value: '',
            password: undefined,
          },
          {
            title: 'Add Connection (2/3)',
            prompt: `Path of the ${label} file that holds the DuckLake metadata`,
            value: '',
            password: undefined,
          },
        ]);
        assert.deepEqual(desktop.progress, [`Testing connection "${name}"...`]);
        assert.deepEqual(desktop.infos, [SAVED(name)]);
        assert.deepEqual(desktop.errors, []);
        const id = `wizard-${kind}`;
        assert.deepEqual(connectionsSetting(), [
          { id, name, kind, path, ...(kind === 'duckdb' ? { readOnly: true } : {}) },
        ]);
        assert.deepEqual(
          tree.roots().map((node) => ({ label: node.label, description: node.description })),
          [{ label: name, description: kind }],
        );

        // The saved profile is usable: the connection opens.
        await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, name));
        assert.deepEqual(tree.state(id).latestSnapshot, LATEST_SNAPSHOT);
      });
    }

    it('keeps the connections that are already in the setting, including entries it does not understand', async () => {
      const existing = [
        { id: uniqueId('kept'), name: 'Kept lake', kind: 'sqlite', path: copyFixture('ducklake.sqlite') },
        { name: 'Broken lake', kind: 'oracle' },
      ];
      await setConnections(existing);
      desktop.answer(pick(undefined));
      await vscode.commands.executeCommand('aantje.addConnection');
      desktop.assertDone();

      const path = copyFixture('ducklake.sqlite');
      await add(pick('SQLite'), input('Added lake'), input(path), pick('No'));

      desktop.assertDone();
      assert.deepEqual(connectionsSetting(), [
        ...existing,
        { id: 'added-lake', name: 'Added lake', kind: 'sqlite', path },
      ]);
    });

    it('checks the name and the path while the user types', async () => {
      await setConnections([
        { id: uniqueId('known'), name: 'Known lake', kind: 'sqlite', path: copyFixture('ducklake.sqlite') },
      ]);

      await add(pick('SQLite'), input('Another lake'), input(undefined));

      desktop.assertDone();
      const [name, path] = desktop.inputs;
      assert.deepEqual(
        ['', ' ', 'known LAKE', 'Another lake'].map((text) => name?.validate(text)),
        [
          'Name must not be empty.',
          'Name must not be empty.',
          'A connection with this name already exists.',
          undefined,
        ],
      );
      assert.deepEqual(
        ['', '"C:\\lakes\\a.sqlite"', 'C:\\lakes\\a.sqlite'].map((text) => path?.validate(text)),
        ['Path must not be empty.', 'Remove the quotes around the path.', undefined],
      );
    });

    for (const [step, answers] of [
      ['the kind', [pick(undefined)]],
      ['the name', [pick('SQLite'), input(undefined)]],
      ['the path', [pick('SQLite'), input('Cancelled lake'), input(undefined)]],
      [
        'the read-only question',
        [pick('SQLite'), input('Cancelled lake'), input(copyFixture('ducklake.sqlite')), pick(undefined)],
      ],
    ] as const) {
      it(`creates nothing when the user cancels at ${step}`, async () => {
        await add(...answers);

        desktop.assertDone();
        assert.equal(connectionsSetting(), undefined);
        assert.deepEqual(tree.roots(), []);
        assert.deepEqual([desktop.infos, desktop.errors, desktop.progress], [[], [], []]);
      });
    }
  });

  describe('when the command cannot do its work', () => {
    it('reports the failure, and leaves a setting that it does not understand alone', async () => {
      await setConnections('not an array');

      await add(pick('SQLite'), input('Wizard lake'), input(copyFixture('ducklake.sqlite')), pick('No'));

      desktop.assertDone();
      assert.deepEqual(desktop.errors, [
        'The setting "aantje.connections" is not an array. Fix it in the settings, then try again.',
      ]);
      assert.equal(connectionsSetting(), 'not an array');
      assert.deepEqual(desktop.infos, []);
    });
  });

  describe('when the connection test fails', () => {
    let name: string;
    let missing: string;
    const FAILED = (path: string): string => `Connection test failed: Cannot read "${path}": ENOENT.`;

    beforeEach(() => {
      name = 'Missing lake';
      missing = join(tempDir(), 'missing.sqlite');
    });

    it('offers to save anyway, edit or cancel, and creates nothing on cancel', async () => {
      await add(pick('SQLite'), input(name), input(missing), pick('No'), pick('Cancel'));

      desktop.assertDone();
      assert.deepEqual(desktop.errors, [FAILED(missing)]);
      assert.deepEqual(desktop.picks[2], {
        title: 'The connection test failed',
        placeholder: undefined,
        rows: [
          { label: 'Save anyway', description: 'Keep the connection although the test failed' },
          { label: 'Edit settings', description: 'Go back and change the values' },
          { label: 'Cancel', description: 'Discard the connection' },
        ],
        active: [],
      });
      assert.equal(connectionsSetting(), undefined);
      assert.deepEqual(desktop.infos, []);
    });

    it('keeps the connection on "Save anyway", and shows its error when it is opened', async () => {
      await add(pick('SQLite'), input(name), input(missing), pick('No'), pick('Save anyway'));

      desktop.assertDone();
      assert.deepEqual(connectionsSetting(), [{ id: 'missing-lake', name, kind: 'sqlite', path: missing }]);
      assert.deepEqual(desktop.infos, [], 'no "Saved" message for a connection that was not tested');

      await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, name));
      assert.deepEqual(tree.state('missing-lake').status, 'error');
    });

    it('asks the questions again with the values typed so far on "Edit settings"', async () => {
      const good = copyFixture('ducklake.sqlite');

      await add(
        pick('SQLite'),
        input(name),
        input(missing),
        pick('No'),
        pick('Edit settings'),
        input(KEEP),
        input(good),
        pick('No'),
      );

      desktop.assertDone();
      assert.deepEqual(
        prompts().map(({ title, value }) => [title, value]),
        [
          ['Add Connection (1/3)', ''],
          ['Add Connection (2/3)', ''],
          ['Add Connection (1/3)', name],
          ['Add Connection (2/3)', missing],
        ],
      );
      assert.deepEqual(desktop.errors, [FAILED(missing)]);
      assert.deepEqual(connectionsSetting(), [{ id: 'missing-lake', name, kind: 'sqlite', path: good }]);
      assert.deepEqual(desktop.infos, [SAVED(name)]);
    });
  });

  describe('adding a PostgreSQL connection', () => {
    it('asks for the server, keeps the password out of the setting and of every message', async () => {
      const port = await freePort();
      const password = 'wizard-secret-4711';

      await add(
        pick('PostgreSQL'),
        input('Wizard pg'),
        input('127.0.0.1'),
        input(String(port)),
        input('ducklake'),
        pick('Password'),
        input('catalog_user'),
        pick('No'),
        input(password),
        pick('No'),
        pick('Save anyway'),
      );

      desktop.assertDone();
      assert.deepEqual(
        prompts().map(({ title, prompt, value, password }) => [title, prompt, value, password]),
        [
          ['Add Connection (1/9)', 'Name shown in the explorer', '', undefined],
          ['Add Connection (2/9)', 'Host name or IP address of the PostgreSQL server', '', undefined],
          ['Add Connection (3/9)', 'Port of the PostgreSQL server', '5432', undefined],
          ['Add Connection (4/9)', 'Database that holds the DuckLake metadata', '', undefined],
          ['Add Connection (6/9)', 'User name', '', undefined],
          [
            'Add Connection (8/9)',
            'Password (leave empty if the server needs none). It is kept in the secret storage, not in the settings.',
            '',
            true,
          ],
        ],
      );
      assert.deepEqual(desktop.picks[2], {
        title: 'Add Connection (7/9): Use TLS for the connection?',
        placeholder: undefined,
        rows: [
          { label: 'No', description: 'Unencrypted; only for localhost or a trusted network' },
          { label: 'Yes', description: 'Encrypted; the server certificate must be trusted' },
        ],
        active: [],
      });
      assert.deepEqual(desktop.errors, [
        `Connection test failed: Cannot connect to 127.0.0.1:${port}: connection refused (is the server running on this port?).`,
      ]);
      assert.deepEqual(connectionsSetting(), [
        {
          id: 'wizard-pg',
          name: 'Wizard pg',
          kind: 'postgres',
          host: '127.0.0.1',
          port,
          database: 'ducklake',
          user: 'catalog_user',
          ssl: false,
        },
      ]);
      const everything = JSON.stringify([
        connectionsSetting(),
        desktop.errors,
        desktop.infos,
        desktop.warnings,
      ]);
      assert.ok(!everything.includes(password), 'the password is in no setting and in no message');
    });

    it('tests the connection with the password that was typed', async () => {
      const port = await startFakePostgres();

      await add(
        pick('PostgreSQL'),
        input('Wizard fake pg'),
        input('127.0.0.1'),
        input(String(port)),
        input('ducklake'),
        pick('Password'),
        input('catalog_user'),
        pick('No'),
        input(RIGHT_PASSWORD),
        pick('No'),
        pick('Save anyway'),
      );

      desktop.assertDone();
      assert.deepEqual(desktop.errors, [
        `Connection test failed: Cannot connect to 127.0.0.1:${port}: database "ducklake" does not exist.`,
      ]);
    });
  });

  describe('editing a connection', () => {
    let id: string;
    let path: string;

    beforeEach(async () => {
      id = uniqueId('edit');
      path = copyFixture('ducklake.sqlite');
      await setConnections([{ id, name: 'Old lake', kind: 'sqlite', path }]);
    });

    it('prefills the questions with the current values and keeps the id of the connection', async () => {
      desktop.answer(input('Renamed lake'), input(KEEP), pick('No'));

      await vscode.commands.executeCommand('aantje.editConnection', await nodeAt(tree, 'Old lake'));

      desktop.assertDone();
      assert.deepEqual(prompts(), [
        {
          title: 'Edit Connection "Old lake" (1/3)',
          prompt: 'Name shown in the explorer',
          value: 'Old lake',
          password: undefined,
        },
        {
          title: 'Edit Connection "Old lake" (2/3)',
          prompt: 'Path of the SQLite file that holds the DuckLake metadata',
          value: path,
          password: undefined,
        },
      ]);
      assert.deepEqual(connectionsSetting(), [{ id, name: 'Renamed lake', kind: 'sqlite', path }]);
      assert.deepEqual(desktop.infos, [SAVED('Renamed lake')]);
      assert.deepEqual(
        tree.roots().map((node) => node.label),
        ['Renamed lake'],
      );
    });

    it('opens an open connection again, also when nothing in the setting changed', async () => {
      const root = await nodeAt(tree, 'Old lake');
      await vscode.commands.executeCommand('aantje.connect', root);
      const before = tree.reader(id);
      assert.ok(before);
      desktop.answer(input(KEEP), input(KEEP), pick('No'));

      await vscode.commands.executeCommand('aantje.editConnection', root);

      desktop.assertDone();
      assert.deepEqual(connectionsSetting(), [{ id, name: 'Old lake', kind: 'sqlite', path }]);
      await waitFor('the connection to be opened again', () => {
        const reader = tree.reader(id);
        return reader && reader !== before;
      });
      await waitUntilClosed(before);
    });

    it('preselects the current read-only mode, and saves the one that the user picks', async () => {
      await setConnections([{ id, name: 'Old lake', kind: 'sqlite', path, readOnly: true }]);
      desktop.answer(input(KEEP), input(KEEP), pick('Yes'));
      await vscode.commands.executeCommand('aantje.editConnection', await nodeAt(tree, 'Old lake'));
      desktop.assertDone();
      assert.deepEqual(
        desktop.picks.at(-1)?.rows.map(({ label }) => label),
        ['Yes', 'No'],
      );
      assert.deepEqual(connectionsSetting(), [
        { id, name: 'Old lake', kind: 'sqlite', path, readOnly: true },
      ]);

      desktop.answer(input(KEEP), input(KEEP), pick('No'));
      await vscode.commands.executeCommand('aantje.editConnection', await nodeAt(tree, 'Old lake'));
      desktop.assertDone();
      assert.deepEqual(connectionsSetting(), [{ id, name: 'Old lake', kind: 'sqlite', path }]);
    });

    it('leaves the connection alone when the user cancels', async () => {
      desktop.answer(input('Renamed lake'), input(undefined));

      await vscode.commands.executeCommand('aantje.editConnection', await nodeAt(tree, 'Old lake'));

      desktop.assertDone();
      assert.deepEqual(connectionsSetting(), [{ id, name: 'Old lake', kind: 'sqlite', path }]);
    });

    it('does not open an open connection again when the user cancels', async () => {
      const root = await nodeAt(tree, 'Old lake');
      await vscode.commands.executeCommand('aantje.connect', root);
      const before = tree.reader(id);
      assert.ok(before);
      desktop.answer(input('Renamed lake'), input(undefined));

      await vscode.commands.executeCommand('aantje.editConnection', root);

      // A refresh leaves the status "connecting" at once, so no waiting is needed to see one.
      desktop.assertDone();
      assert.equal(tree.reader(id), before);
    });

    it('opens only the edited connection again, not the other open ones', async () => {
      const otherId = uniqueId('other');
      await setConnections([
        { id, name: 'Old lake', kind: 'sqlite', path },
        { id: otherId, name: 'Other lake', kind: 'sqlite', path: copyFixture('ducklake.sqlite') },
      ]);
      const [edited, other] = [await nodeAt(tree, 'Old lake'), await nodeAt(tree, 'Other lake')];
      await vscode.commands.executeCommand('aantje.connect', edited);
      await vscode.commands.executeCommand('aantje.connect', other);
      const [editedBefore, otherBefore] = [tree.reader(id), tree.reader(otherId)];
      assert.ok(editedBefore && otherBefore);
      desktop.answer(input(KEEP), input(KEEP), pick('No'));

      await vscode.commands.executeCommand('aantje.editConnection', edited);

      desktop.assertDone();
      assert.equal(tree.reader(otherId), otherBefore, 'the other connection was not touched');
      await waitFor('the edited connection to be opened again', () => {
        const reader = tree.reader(id);
        return reader && reader !== editedBefore;
      });
      assert.equal(tree.reader(otherId), otherBefore);
    });
  });

  describe('removing a connection', () => {
    let first: string;
    let second: string;

    beforeEach(async () => {
      first = uniqueId('first');
      second = uniqueId('second');
      await setConnections([
        { id: first, name: 'First lake', kind: 'sqlite', path: copyFixture('ducklake.sqlite') },
        { id: second, name: 'Second lake', kind: 'sqlite', path: copyFixture('ducklake.sqlite') },
      ]);
    });

    const QUESTION = (name: string): string =>
      `Remove the connection "${name}"? The catalog itself is not touched.`;

    it('removes the entry of that connection after the user confirms, and closes its reader', async () => {
      const node = await nodeAt(tree, 'Second lake');
      await vscode.commands.executeCommand('aantje.connect', node);
      const reader = tree.reader(second);
      assert.ok(reader);
      desktop.answer(confirm(true));

      await vscode.commands.executeCommand('aantje.removeConnection', node);

      desktop.assertDone();
      assert.deepEqual(desktop.confirmations, [QUESTION('Second lake')]);
      assert.deepEqual(
        (connectionsSetting() as { id: string }[]).map((entry) => entry.id),
        [first],
      );
      assert.deepEqual(
        tree.roots().map((root) => root.label),
        ['First lake'],
      );
      await waitUntilClosed(reader);
    });

    it('keeps the connection when the user does not confirm', async () => {
      desktop.answer(confirm(false));

      await vscode.commands.executeCommand('aantje.removeConnection', await nodeAt(tree, 'First lake'));

      desktop.assertDone();
      assert.deepEqual(desktop.confirmations, [QUESTION('First lake')]);
      assert.deepEqual(
        tree.roots().map((root) => root.label),
        ['First lake', 'Second lake'],
      );
    });
  });
});
