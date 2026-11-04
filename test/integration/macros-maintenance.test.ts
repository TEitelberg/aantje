import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { CatalogTree } from '../../src/tree/model';
import { HISTORY_SNAPSHOT } from '../support/expected-history';
import { Desktop } from './desktop';
import {
  activate,
  assertDryRunFirst,
  copyFixture,
  nodeAt,
  onTeardownAsync,
  setConnections,
  uniqueId,
} from './support';

const MAINTENANCE_IDS = [
  'aantje.maintenanceCheckpoint',
  'aantje.maintenanceMerge',
  'aantje.maintenanceRewrite',
  'aantje.maintenanceFlush',
  'aantje.maintenanceExpire',
  'aantje.maintenanceCleanup',
  'aantje.maintenanceOrphans',
  'aantje.maintenanceOption',
];
const TABLE_COMMANDS = ['Merge', 'Rewrite', 'Flush', 'Option'].map((name) => `aantje.maintenance${name}`);

const HEADER = `-- Maintenance of the DuckLake. The SQL editor of aantje attaches the lake as "lake", so the statements below use that name.
-- Run them in a read/write SQL session.`;

/** The statements of a script that run when it is run: its lines that are no comment. The exact texts are pinned in test/unit/maintenance.test.ts. */
const statementsOf = (text: string): string[] =>
  text.split('\n').filter((line) => line !== '' && !line.startsWith('--'));

const GROSS_CREATE = 'CREATE OR REPLACE MACRO "shop"."gross"("net", "rate" := 1.19) AS (net * rate);';
const RECENT_EVENTS_CREATE =
  'CREATE OR REPLACE MACRO "shop"."recent_events"("n") AS TABLE SELECT * FROM shop.events ORDER BY ts DESC LIMIT n;';
const NEWEST = (snapshot: number): string =>
  `-- The tree shows snapshot @${snapshot}; this statement acts on the newest state.`;
const DROP_FIRST = '-- To drop it before it is created again, remove the "-- " of the next line.';
const GROSS_DROP_COMMENT = '-- DROP MACRO "shop"."gross";';
/** The CREATE script of the macro `gross`: the drop as a comment above the statement. */
const GROSS_SCRIPT = [DROP_FIRST, GROSS_DROP_COMMENT, GROSS_CREATE].join('\n');
const GROSS_ALTER = `-- Edit the macro, then run the statement in a read/write SQL session to replace it. The statement holds all its overloads.\n${GROSS_CREATE}\n-- Drop the macro\n${GROSS_DROP_COMMENT}`;

describe('the Script as commands for macros and the Maintenance commands', () => {
  let api: ExtensionApi;
  let tree: CatalogTree;
  let desktop: Desktop;
  let id: string;

  beforeEach(async () => {
    api = await activate();
    ({ tree } = api);
    desktop = Desktop.install();
    id = uniqueId('macros');
    await setConnections([{ id, name: id, kind: 'sqlite', path: copyFixture('history/history.sqlite') }]);
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

  describe('the Macros folder', () => {
    it('is under every schema, also an empty one, and tells that it is empty', async () => {
      for (const schema of ['main', 'shop']) {
        const folders = (await tree.children(await nodeAt(tree, id, schema))).map(({ label }) => label);
        assert.equal(folders.at(-1), 'Macros', `${schema} has the folder`);
      }
      const empty = await nodeAt(tree, id, 'main', 'Macros');
      assert.equal(empty.contextValue, 'folder.macros');
      assert.equal(empty.hasChildren, true);
      assert.deepEqual(
        (await tree.children(empty)).map(({ contextValue }) => contextValue),
        ['message'],
      );
      assert.deepEqual(
        (await tree.children(await nodeAt(tree, id, 'shop', 'Macros'))).map(({ label }) => label),
        ['gross', 'recent_events'],
      );
    });

    it('writes the template with the two examples for the schema, also for an empty one', async () => {
      for (const schema of ['shop', 'main']) {
        const text = await textOf('aantje.scriptCreate', schema, 'Macros');
        assert.ok(text.startsWith('-- Two examples of a macro in this schema.'));
        assert.deepEqual(statementsOf(text), [
          `CREATE MACRO "${schema}"."add_one"(x) AS x + 1;`,
          `CREATE MACRO "${schema}"."first_rows"(n := 10) AS TABLE SELECT 42 AS answer FROM range(n);`,
        ]);
      }
      assert.deepEqual([desktop.errors, desktop.infos, desktop.copied], [[], [], []]);
    });
  });

  describe('the scripts of a macro', () => {
    it('writes CREATE, ALTER and DROP for a scalar macro, with the parameters quoted and the default kept, and DROP MACRO TABLE for a table macro', async () => {
      assert.equal(await textOf('aantje.scriptCreate', 'shop', 'Macros', 'gross'), GROSS_SCRIPT);
      assert.equal(await textOf('aantje.scriptAlter', 'shop', 'Macros', 'gross'), GROSS_ALTER);
      assert.equal(
        await textOf('aantje.scriptDrop', 'shop', 'Macros', 'gross'),
        '-- Drops the scalar macro with all its overloads. Run it in a read/write SQL session.\nDROP MACRO "shop"."gross";',
      );

      assert.equal(
        await textOf('aantje.scriptCreate', 'shop', 'Macros', 'recent_events'),
        [DROP_FIRST, '-- DROP MACRO TABLE "shop"."recent_events";', RECENT_EVENTS_CREATE].join('\n'),
      );
      assert.equal(
        await textOf('aantje.scriptDrop', 'shop', 'Macros', 'recent_events'),
        '-- Drops the table macro with all its overloads. Run it in a read/write SQL session.\nDROP MACRO TABLE "shop"."recent_events";',
      );
    });

    it('shows the macro as it was at the snapshot that the tree shows, and says that ALTER, DROP and the maintenance of a table act on the newest state', async () => {
      tree.selectSnapshot(id, HISTORY_SNAPSHOT.createGrossMacro);
      assert.equal(
        await textOf('aantje.scriptAlter', 'shop', 'Macros', 'gross'),
        `-- Edit the macro, then run the statement in a read/write SQL session to replace it. The statement holds all its overloads.\n${NEWEST(HISTORY_SNAPSHOT.createGrossMacro)}\n${GROSS_CREATE}\n-- Drop the macro\n${GROSS_DROP_COMMENT}`,
      );
      assert.equal(
        await textOf('aantje.scriptDrop', 'shop', 'Macros', 'gross'),
        `-- Drops the scalar macro with all its overloads. Run it in a read/write SQL session.\n${NEWEST(HISTORY_SNAPSHOT.createGrossMacro)}\nDROP MACRO "shop"."gross";`,
      );
      assert.equal(
        await textOf('aantje.scriptCreate', 'shop', 'Macros', 'gross'),
        [NEWEST(HISTORY_SNAPSHOT.createGrossMacro), DROP_FIRST, GROSS_DROP_COMMENT, GROSS_CREATE].join('\n'),
      );

      const merge = await textOf('aantje.maintenanceMerge', 'shop', 'Tables', 'events');
      assert.ok(merge.split('\n').includes(NEWEST(HISTORY_SNAPSHOT.createGrossMacro)));
      assert.deepEqual(statementsOf(merge), [
        "CALL ducklake_merge_adjacent_files('lake', 'events', schema => 'shop');",
      ]);
    });

    it('writes a call with a placeholder for each argument that has no default, for a macro and, as comments, for the folder', async () => {
      assert.equal(
        await textOf('aantje.scriptSelect', 'shop', 'Macros', 'gross'),
        '-- Replace the <arg> placeholders with values.\nSELECT "shop"."gross"(<arg1>);',
      );
      assert.equal(
        await textOf('aantje.scriptSelect', 'shop', 'Macros', 'recent_events'),
        '-- Replace the <arg> placeholders with values.\nSELECT * FROM "shop"."recent_events"(<arg1>) LIMIT 1000;',
      );
      assert.deepEqual(
        (await textOf('aantje.scriptSelect', 'shop', 'Macros'))
          .split('\n')
          .filter((line) => line.startsWith('-- SELECT')),
        ['-- SELECT "shop"."gross"(<arg1>);', '-- SELECT * FROM "shop"."recent_events"(<arg1>) LIMIT 1000;'],
      );
    });
  });

  describe('Maintenance', () => {
    it('writes the script of each entry for the connection, the dry run first for what destroys data, and the scripts of a schema and a table with string literals', async () => {
      assert.ok((await textOf('aantje.maintenanceCheckpoint')).startsWith(HEADER));
      assert.deepEqual(statementsOf(await textOf('aantje.maintenanceCheckpoint')), ['CHECKPOINT lake;']);
      for (const [command, statement] of [
        ['aantje.maintenanceMerge', "CALL ducklake_merge_adjacent_files('lake');"],
        ['aantje.maintenanceRewrite', "CALL ducklake_rewrite_data_files('lake');"],
        ['aantje.maintenanceFlush', "CALL ducklake_flush_inlined_data('lake');"],
      ] as const) {
        assert.deepEqual(statementsOf(await textOf(command)), [statement]);
      }
      for (const [command, procedure] of [
        ['aantje.maintenanceExpire', 'ducklake_expire_snapshots'],
        ['aantje.maintenanceCleanup', 'ducklake_cleanup_old_files'],
        ['aantje.maintenanceOrphans', 'ducklake_delete_orphaned_files'],
      ] as const) {
        assertDryRunFirst(await textOf(command), procedure);
      }
      assert.deepEqual(
        statementsOf(await textOf('aantje.maintenanceOption')),
        [],
        'every statement of the option template is a comment',
      );

      // A schema: the merge names each table of the schema (DuckLake merges one table per call), the flush the schema.
      const tables = (await tree.children(await nodeAt(tree, id, 'shop', 'Tables'))).map(
        ({ label }) => label,
      );
      assert.ok(tables.length > 1);
      assert.deepEqual(
        statementsOf(await textOf('aantje.maintenanceMerge', 'shop')).toSorted(),
        tables
          .map((table) => `CALL ducklake_merge_adjacent_files('lake', '${table}', schema => 'shop');`)
          .toSorted(),
      );
      assert.deepEqual(statementsOf(await textOf('aantje.maintenanceFlush', 'shop')), [
        "CALL ducklake_flush_inlined_data('lake', schema_name => 'shop');",
      ]);
      assert.deepEqual(statementsOf(await textOf('aantje.maintenanceOption', 'shop')), []);

      assert.deepEqual(statementsOf(await textOf('aantje.maintenanceMerge', 'shop', 'Tables', 'events')), [
        "CALL ducklake_merge_adjacent_files('lake', 'events', schema => 'shop');",
      ]);
      assert.deepEqual(
        statementsOf(await textOf('aantje.maintenanceOption', 'shop', 'Tables', 'events')),
        [],
      );
      assert.ok(
        (await textOf('aantje.maintenanceRewrite', 'shop', 'Tables', 'events')).endsWith(
          "CALL ducklake_rewrite_data_files('lake', 'events', schema => 'shop');",
        ),
      );
      assert.ok(
        (await textOf('aantje.maintenanceFlush', 'shop', 'Tables', 'events')).endsWith(
          "CALL ducklake_flush_inlined_data('lake', schema_name => 'shop', table_name => 'events');",
        ),
      );
      assert.deepEqual(desktop.copied, [], 'the clipboard is not used');
    });
  });

  describe('the document that every script opens', () => {
    it('belongs to the connection of the node, so that F5 runs it there, and nothing has run: opening is not running', async () => {
      const cases: [string, string[]][] = [
        ['aantje.scriptCreate', ['shop', 'Macros']],
        ['aantje.scriptCreate', ['shop', 'Macros', 'gross']],
        ['aantje.scriptAlter', ['shop', 'Macros', 'recent_events']],
        ['aantje.scriptDrop', ['shop', 'Macros', 'recent_events']],
        ...MAINTENANCE_IDS.map((command): [string, string[]] => [command, []]),
        ...TABLE_COMMANDS.map((command): [string, string[]] => [command, ['shop']]),
        ...TABLE_COMMANDS.map((command): [string, string[]] => [command, ['shop', 'Tables', 'events']]),
      ];
      for (const [command, path] of cases) {
        const document = await scriptOf(command, ...path);
        assert.ok(document, `${command} opened a document for ${path.join('/') || 'the connection'}`);
        const key = document.uri.toString();
        assert.equal(api.editors.connectionOf(key), id, `${command} associates the document`);
        assert.deepEqual(
          [api.editors.state(key)?.running, api.editors.state(key)?.sessionOpen],
          [false, false],
          `${command} runs nothing and opens no session`,
        );
      }
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });
  });

  it('does nothing for a call without a node, for the nodes that a script does not stand for, and for a schema or a table when the entry is one that only the connection has', async () => {
    const before = untitledDocuments().length;
    const nodes = [
      ['shop', 'Tables'],
      ['shop', 'Views'],
      ['shop', 'Tables', 'events', 'Columns'],
      ['shop', 'Tables', 'events', 'Columns', 'kind'],
      ['shop', 'Tables', 'events', 'Statistics'],
      ['Snapshots'],
      ['Snapshots', '@24'],
    ];

    for (const command of MAINTENANCE_IDS) {
      await vscode.commands.executeCommand(command);
      for (const path of nodes) {
        await vscode.commands.executeCommand(command, await nodeAt(tree, id, ...path));
      }
    }
    for (const command of MAINTENANCE_IDS.filter((command) => !TABLE_COMMANDS.includes(command))) {
      for (const path of [['shop'], ['shop', 'Tables', 'events']]) {
        await vscode.commands.executeCommand(command, await nodeAt(tree, id, ...path));
      }
    }
    // The Script as commands need a node, and the Macros folder has no ALTER.
    for (const command of [
      'aantje.scriptSelect',
      'aantje.scriptCreate',
      'aantje.scriptAlter',
      'aantje.scriptDrop',
    ]) {
      await vscode.commands.executeCommand(command);
    }
    await vscode.commands.executeCommand('aantje.scriptAlter', await nodeAt(tree, id, 'shop', 'Macros'));

    assert.equal(untitledDocuments().length, before);
    assert.deepEqual([desktop.errors, desktop.infos, desktop.copied], [[], [], []]);
  });
});
