import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { CatalogTree } from '../../src/tree/model';
import { SNAPSHOT } from '../support/expected';
import {
  BIG_ORDERS_ALTER,
  BIG_ORDERS_ALTER_AT_10,
  BIG_ORDERS_DROP,
  createWithDrop,
  ORDERS_ALTER,
  ORDERS_DROP,
  ORDERS_DROP_AT_5,
  PLAIN_ALTER_AT_CREATION,
} from '../support/scripts';
import { Desktop } from './desktop';
import { BIG_ORDERS_DDL, ORDERS_DDL, PLAIN_DDL_AT_CREATION } from './expectations';
import {
  activate,
  copyFixture,
  extension,
  nodeAt,
  onTeardownAsync,
  setConnections,
  uniqueId,
} from './support';

interface Manifest {
  readonly contributes: {
    readonly commands: readonly { command: string; title: string; category?: string }[];
    readonly submenus: readonly { id: string; label: string }[];
    readonly menus: Record<
      string,
      readonly { command?: string; submenu?: string; when?: string; group?: string }[]
    >;
  };
}

const manifest = (): Manifest => extension().packageJSON as Manifest;

const ORDERS_COLUMNS = `SELECT
  "id",
  "customer",
  "attrs",
  "amount",
  "created"`;

const ORDERS_SELECT = `${ORDERS_COLUMNS}
FROM "sales"."orders"
LIMIT 1000;`;

const ORDERS_SELECT_AT_5 = `-- Time travel to snapshot 5
${ORDERS_COLUMNS}
FROM "sales"."orders" AT (VERSION => 5)
LIMIT 1000;`;

const BIG_ORDERS_SELECT = `SELECT *
FROM "sales"."big_orders"
LIMIT 1000;`;

const BIG_ORDERS_SELECT_AT_10 = `-- Time travel to snapshot 10
SELECT *
FROM "sales"."big_orders" AT (VERSION => 10)
LIMIT 1000;`;

const PLAIN_SELECT_AT_CREATION = `-- Time travel to snapshot 12
SELECT
  "x",
  "y"
FROM "main"."plain" AT (VERSION => 12)
LIMIT 1000;`;

const SCRIPT_COMMANDS = [
  'aantje.scriptCreate',
  'aantje.scriptSelect',
  'aantje.scriptInsert',
  'aantje.scriptAlter',
  'aantje.scriptDrop',
];

describe('the Script as commands', () => {
  let api: ExtensionApi;
  let tree: CatalogTree;
  let desktop: Desktop;
  let id: string;

  beforeEach(async () => {
    api = await activate();
    ({ tree } = api);
    desktop = Desktop.install();
    id = uniqueId('script');
    await setConnections([{ id, name: id, kind: 'sqlite', path: copyFixture('ducklake.sqlite') }]);
    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, id));
  });

  afterEach(() => {
    desktop.assertDone();
  });

  const untitledDocuments = (): vscode.TextDocument[] =>
    vscode.workspace.textDocuments.filter((document) => document.isUntitled);

  /** Runs the command on the node at the path and returns the document it opened, or undefined when none opened. */
  async function scriptOf(command: string, ...path: string[]): Promise<vscode.TextDocument | undefined> {
    const before = new Set(untitledDocuments());
    await vscode.commands.executeCommand(command, await nodeAt(tree, id, ...path));
    const opened = untitledDocuments().filter((document) => !before.has(document));
    // The untitled document is dirty: revert it, or closing it would ask whether to save.
    onTeardownAsync(async () => {
      for (let count = opened.length; count > 0; count--) {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
    });
    assert.ok(opened.length <= 1, 'at most one document per command');
    const [document] = opened;
    if (document) {
      assert.equal(vscode.window.activeTextEditor?.document, document, 'the document is shown in the editor');
    }
    return document;
  }

  async function textOf(command: string, ...path: string[]): Promise<string> {
    const document = await scriptOf(command, ...path);
    assert.ok(document, `${command} opened a document`);
    assert.equal(document.languageId, 'sql');
    assert.ok(document.isUntitled);
    return document.getText();
  }

  describe('declaration', () => {
    it('declares the five commands in the category aantje and hides them from the command palette', () => {
      const { commands, menus } = manifest().contributes;
      assert.deepEqual(
        commands
          .filter(({ command }) => command.startsWith('aantje.script'))
          .map(({ command, title, category }) => [command, title, category]),
        [
          ['aantje.scriptCreate', 'Script as CREATE', 'aantje'],
          ['aantje.scriptSelect', 'Script as SELECT', 'aantje'],
          ['aantje.scriptInsert', 'Script as INSERT', 'aantje'],
          ['aantje.scriptAlter', 'Script as ALTER', 'aantje'],
          ['aantje.scriptDrop', 'Script as DROP', 'aantje'],
        ],
      );
      const hidden = (menus.commandPalette ?? [])
        .filter(({ when }) => when === 'false')
        .map((e) => e.command);
      for (const command of SCRIPT_COMMANDS) {
        assert.ok(hidden.includes(command), `${command} is hidden from the command palette`);
      }
    });

    it('offers the submenu Script as in the group before the data entries, and the five entries in this order', () => {
      const { submenus, menus } = manifest().contributes;
      assert.deepEqual(
        submenus.filter(({ id }) => id === 'aantje.script'),
        [{ id: 'aantje.script', label: 'Script as' }],
      );
      const opener = (menus['view/item/context'] ?? []).filter(({ submenu }) => submenu === 'aantje.script');
      assert.equal(opener.length, 1);
      assert.equal(opener[0]?.group, '2_script');
      assert.deepEqual(
        (menus['aantje.script'] ?? []).map(({ command }) => command),
        [
          'aantje.scriptSelect',
          'aantje.scriptInsert',
          'aantje.scriptCreate',
          'aantje.scriptAlter',
          'aantje.scriptDrop',
        ],
      );
    });
  });

  describe('Script as CREATE', () => {
    it('opens the statement that Copy DDL copies, with the drop as a comment above it, in a new untitled SQL document, for a table and a view', async () => {
      assert.equal(
        await textOf('aantje.scriptCreate', 'sales', 'Tables', 'orders'),
        createWithDrop(
          'DROP TABLE "sales"."orders";',
          [
            ORDERS_DDL,
            '-- The partitioning, the sort order and the comments of the table',
            `-- COMMENT ON TABLE "sales"."orders" IS 'Customer orders';`,
            `-- COMMENT ON COLUMN "sales"."orders"."amount" IS 'Net amount in EUR';`,
          ].join('\n'),
        ),
      );
      assert.equal(
        await textOf('aantje.scriptCreate', 'sales', 'Views', 'big_orders'),
        createWithDrop('DROP VIEW "sales"."big_orders";', BIG_ORDERS_DDL),
      );
      assert.deepEqual(desktop.copied, [], 'the clipboard is not used');
    });

    it('writes the columns of the snapshot that the tree shows', async () => {
      tree.selectSnapshot(id, SNAPSHOT.createPlain);
      assert.equal(
        await textOf('aantje.scriptCreate', 'main', 'Tables', 'plain'),
        createWithDrop(
          'DROP TABLE "main"."plain";',
          PLAIN_DDL_AT_CREATION,
          '-- The tree shows snapshot @12; this statement acts on the newest state.',
        ),
      );
    });

    it('says so when the connection was closed, and opens nothing', async () => {
      const orders = await nodeAt(tree, id, 'sales', 'Tables', 'orders');
      await tree.disconnect(id);
      const before = untitledDocuments().length;

      await vscode.commands.executeCommand('aantje.scriptCreate', orders);

      assert.deepEqual(desktop.errors, ['The connection is closed. Connect again to script the CREATE.']);
      assert.equal(untitledDocuments().length, before);
    });
  });

  describe('Script as SELECT', () => {
    it('opens a SELECT with every top-level column of a table and LIMIT 1000, and SELECT * for a view', async () => {
      assert.equal(await textOf('aantje.scriptSelect', 'sales', 'Tables', 'orders'), ORDERS_SELECT);
      assert.equal(await textOf('aantje.scriptSelect', 'sales', 'Views', 'big_orders'), BIG_ORDERS_SELECT);
      assert.deepEqual(desktop.copied, [], 'the clipboard is not used');
    });

    it('travels to the snapshot that the tree shows, and follows "latest" again', async () => {
      tree.selectSnapshot(id, SNAPSHOT.insertTmp);
      assert.equal(await textOf('aantje.scriptSelect', 'sales', 'Tables', 'orders'), ORDERS_SELECT_AT_5);

      tree.selectSnapshot(id, SNAPSHOT.createPlain);
      assert.equal(await textOf('aantje.scriptSelect', 'main', 'Tables', 'plain'), PLAIN_SELECT_AT_CREATION);

      tree.selectSnapshot(id, SNAPSHOT.commentOnView);
      assert.equal(
        await textOf('aantje.scriptSelect', 'sales', 'Views', 'big_orders'),
        BIG_ORDERS_SELECT_AT_10,
      );

      tree.selectSnapshot(id, 'latest');
      assert.equal(await textOf('aantje.scriptSelect', 'sales', 'Tables', 'orders'), ORDERS_SELECT);
    });

    it('says so when the connection was closed, and opens nothing', async () => {
      const orders = await nodeAt(tree, id, 'sales', 'Tables', 'orders');
      await tree.disconnect(id);
      const before = untitledDocuments().length;

      await vscode.commands.executeCommand('aantje.scriptSelect', orders);

      assert.deepEqual(desktop.errors, ['The connection is closed. Connect again to script the SELECT.']);
      assert.equal(untitledDocuments().length, before);
    });
  });

  describe('Script as INSERT', () => {
    it('opens one row to insert into a table, with a placeholder per column that names its type, default and NOT NULL', async () => {
      const text = await textOf('aantje.scriptInsert', 'sales', 'Tables', 'orders');
      assert.deepEqual(
        text.split('\n').filter((line) => !line.startsWith('--')),
        [
          'INSERT INTO "sales"."orders" ("id", "customer", "attrs", "amount", "created")',
          'VALUES (',
          '  <"id" INTEGER NOT NULL>,',
          '  <"customer" STRUCT("name" VARCHAR, "tags" VARCHAR[])>,',
          '  <"attrs" MAP(VARCHAR, INTEGER)>,',
          '  <"amount" DECIMAL(10,2) DEFAULT 0>,',
          '  <"created" TIMESTAMP>',
          ');',
        ],
      );
    });
  });

  describe('Script as ALTER', () => {
    it('opens CREATE OR REPLACE VIEW with the stored SQL for a view, at the latest and at an older snapshot', async () => {
      assert.equal(await textOf('aantje.scriptAlter', 'sales', 'Views', 'big_orders'), BIG_ORDERS_ALTER);

      tree.selectSnapshot(id, SNAPSHOT.commentOnView);
      assert.equal(
        await textOf('aantje.scriptAlter', 'sales', 'Views', 'big_orders'),
        BIG_ORDERS_ALTER_AT_10,
      );
    });

    it('opens a template of commented statements for a table, with the columns of the snapshot that the tree shows', async () => {
      assert.equal(await textOf('aantje.scriptAlter', 'sales', 'Tables', 'orders'), ORDERS_ALTER);

      tree.selectSnapshot(id, SNAPSHOT.createPlain);
      assert.equal(await textOf('aantje.scriptAlter', 'main', 'Tables', 'plain'), PLAIN_ALTER_AT_CREATION);
      assert.deepEqual(desktop.copied, [], 'the clipboard is not used');
    });

    it('says so when the connection was closed, and opens nothing for a table', async () => {
      const orders = await nodeAt(tree, id, 'sales', 'Tables', 'orders');
      await tree.disconnect(id);
      const before = untitledDocuments().length;

      await vscode.commands.executeCommand('aantje.scriptAlter', orders);

      assert.deepEqual(desktop.errors, ['The connection is closed. Connect again to script the ALTER.']);
      assert.equal(untitledDocuments().length, before);
    });
  });

  describe('Script as DROP', () => {
    it('opens DROP TABLE for a table and DROP VIEW for a view, with a comment above', async () => {
      assert.equal(await textOf('aantje.scriptDrop', 'sales', 'Tables', 'orders'), ORDERS_DROP);
      assert.equal(await textOf('aantje.scriptDrop', 'sales', 'Views', 'big_orders'), BIG_ORDERS_DROP);
    });

    it('says that it acts on the newest state when the tree shows an older snapshot', async () => {
      tree.selectSnapshot(id, SNAPSHOT.insertTmp);
      assert.equal(await textOf('aantje.scriptDrop', 'sales', 'Tables', 'orders'), ORDERS_DROP_AT_5);
    });
  });

  describe('the document that every script opens', () => {
    it('belongs to the connection of the node, so that F5 runs it there, and nothing has run: opening is not running', async () => {
      for (const command of SCRIPT_COMMANDS) {
        for (const path of [
          ['sales', 'Tables', 'orders'],
          ['sales', 'Views', 'big_orders'],
        ]) {
          const document = await scriptOf(command, ...path);
          if (command === 'aantje.scriptInsert' && path[1] === 'Views') {
            assert.equal(document, undefined, 'only a table has an INSERT script');
            continue;
          }
          assert.ok(document, `${command} opened a document for ${path.join('/')}`);
          const key = document.uri.toString();
          assert.equal(api.editors.connectionOf(key), id, `${command} associates the document`);
          assert.deepEqual(
            [api.editors.state(key)?.running, api.editors.state(key)?.sessionOpen],
            [false, false],
            `${command} runs nothing and opens no session`,
          );
        }
      }
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });
  });

  describe('the scripts of the nodes above and below a table', () => {
    const first = (text: string): string => text.split('\n')[0] ?? '';

    it('opens a template for the connection and for a schema, with the names of the schema filled in, that belong to the connection', async () => {
      const connection = await scriptOf('aantje.scriptCreate');
      assert.ok(connection, 'the connection has a CREATE script');
      assert.match(connection.getText(), /CREATE SCHEMA "new_schema";/);
      assert.match(connection.getText(), /CREATE TABLE "main"."new_table"/);
      assert.equal(api.editors.connectionOf(connection.uri.toString()), id);

      const schema = await scriptOf('aantje.scriptCreate', 'sales');
      assert.ok(schema, 'a schema has a CREATE script');
      assert.match(schema.getText(), /CREATE TABLE "sales"."new_table"/);
      assert.match(schema.getText(), /CREATE VIEW "sales"."new_view"/);
      assert.match(schema.getText(), /CREATE MACRO "sales"."add_one"/);
      assert.equal(api.editors.connectionOf(schema.uri.toString()), id);
      assert.deepEqual([desktop.errors, desktop.infos, desktop.copied], [[], [], []]);
    });

    it('opens DROP SCHEMA as a live statement with the CASCADE form as a comment, and the drops of a folder as comments', async () => {
      assert.equal(
        await textOf('aantje.scriptDrop', 'sales'),
        [
          '-- Drops the schema. It must be empty: DuckLake refuses otherwise. Run it in a read/write SQL session.',
          'DROP SCHEMA "sales";',
          '-- Drops the schema and everything in it',
          '-- DROP SCHEMA "sales" CASCADE;',
        ].join('\n'),
      );
      const tables = await textOf('aantje.scriptDrop', 'sales', 'Tables');
      assert.deepEqual(
        tables.split('\n').filter((line) => line !== '' && !line.startsWith('--')),
        [],
        'every statement is a comment',
      );
      assert.ok(tables.includes('-- DROP TABLE "sales"."orders";'));
    });

    it('opens the SELECTs of a schema and of a folder, a column and the leaves of a table, with time travel while the tree is pinned', async () => {
      const schema = await textOf('aantje.scriptSelect', 'sales');
      assert.ok(schema.includes('FROM "sales"."orders"\nLIMIT 1000;'));
      assert.ok(schema.includes('FROM "sales"."big_orders"\nLIMIT 1000;'));
      assert.equal(
        await textOf('aantje.scriptSelect', 'sales', 'Tables', 'orders', 'Columns', 'customer', 'name'),
        'SELECT "customer"."name"\nFROM "sales"."orders"\nLIMIT 1000;',
      );
      assert.ok(
        (await textOf('aantje.scriptSelect', 'sales', 'Tables', 'orders', 'Statistics')).includes(
          "ducklake_list_files('lake', 'orders', schema => 'sales')",
        ),
      );
      assert.ok(
        first(await textOf('aantje.scriptSelect', 'sales', 'Tables', 'orders', 'History')).startsWith(
          '-- What the snapshots up to @',
        ),
      );
      assert.equal(
        await textOf('aantje.scriptSelect', 'Snapshots', '@5'),
        "-- The snapshot, with what it changed\nSELECT * FROM ducklake_snapshots('lake') WHERE snapshot_id = 5;",
      );

      tree.selectSnapshot(id, SNAPSHOT.insertTmp);
      assert.ok((await textOf('aantje.scriptSelect', 'sales')).includes('-- Time travel to snapshot 5\n'));
    });

    it('opens the column scripts, and the scripts of the Columns folder, as templates with the table filled in', async () => {
      const folder = await textOf('aantje.scriptCreate', 'sales', 'Tables', 'orders', 'Columns');
      assert.ok(folder.includes('ALTER TABLE "sales"."orders" ADD COLUMN "new_column" VARCHAR;'));
      assert.equal(
        await textOf('aantje.scriptDrop', 'sales', 'Tables', 'orders', 'Columns', 'amount'),
        '-- Drops the column. Run it in a read/write SQL session.\nALTER TABLE "sales"."orders" DROP COLUMN "amount";',
      );
      const alter = await textOf(
        'aantje.scriptAlter',
        'sales',
        'Tables',
        'orders',
        'Columns',
        'customer',
        'name',
      );
      assert.ok(
        alter.includes('-- ALTER TABLE "sales"."orders" RENAME COLUMN "customer"."name" TO <new_name>;'),
      );
    });
  });

  it('does nothing for a call without a node, and for a node without a script', async () => {
    const before = untitledDocuments().length;

    for (const command of SCRIPT_COMMANDS) {
      await vscode.commands.executeCommand(command);
    }
    // Only a table has a Partitioning folder to alter; the leaves of a table have a SELECT and nothing else.
    for (const [command, path] of [
      ['aantje.scriptAlter', ['sales']],
      ['aantje.scriptAlter', ['sales', 'Tables']],
      ['aantje.scriptCreate', ['sales', 'Tables', 'orders', 'Statistics']],
      ['aantje.scriptDrop', ['sales', 'Tables', 'orders', 'History']],
      ['aantje.scriptCreate', ['Snapshots']],
      ['aantje.scriptDrop', ['Snapshots', '@5']],
    ] as const) {
      await vscode.commands.executeCommand(command, await nodeAt(tree, id, ...path));
    }

    assert.equal(untitledDocuments().length, before);
    assert.deepEqual([desktop.errors, desktop.infos, desktop.copied], [[], [], []]);
  });
});
