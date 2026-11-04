import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { formatUtc } from '../../src/snapshot';
import type { CatalogTree } from '../../src/tree/model';
import {
  copyDataFixture,
  dataMessages,
  gridTabs,
  observeWebviews,
  recordNotebooks,
  requireEngine,
  useExtensionCache,
} from './data';
import type { WebviewRecord } from './data';
import { confirm, Desktop, pick } from './desktop';
import { ORDER_1, ORDER_2, ORDER_3, ORDERS_GRID_COLUMNS } from './expectations';
import {
  activate,
  copyFixture,
  extension,
  nodeAt,
  onTeardownAsync,
  setConnections,
  uniqueId,
  waitFor,
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

/** The ids newest first, like the rows of a picker. */
const newestFirst = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `@${to - i}`);

const EVOLVED_AT_30 = `CREATE TABLE "main"."evolving" (
  "id" INTEGER,
  "title" VARCHAR,
  "info" STRUCT("a" INTEGER, "b" VARCHAR),
  "n" BIGINT,
  "extra" DOUBLE
);`;

const EVOLVED_AT_35 = `CREATE TABLE "main"."evolved" (
  "id" INTEGER,
  "title" VARCHAR,
  "info" STRUCT("a" INTEGER, "b" VARCHAR, "c" DOUBLE),
  "n" BIGINT,
  "flag" BOOLEAN DEFAULT true
);`;

const CLOSED = (goal: string): string => `The connection is closed. Connect again to ${goal}.`;

/** The tabs that show a diff editor, with the two documents. */
function diffTabs(): { label: string; original: vscode.Uri; modified: vscode.Uri }[] {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .flatMap((tab) =>
      tab.input instanceof vscode.TabInputTextDiff
        ? [{ label: tab.label, original: tab.input.original, modified: tab.input.modified }]
        : [],
    );
}

const untitledDocuments = (): vscode.TextDocument[] =>
  vscode.workspace.textDocuments.filter((document) => document.isUntitled);

describe('Time Travel: Query at Snapshot, Compare Schema and Compare Snapshots', () => {
  let tree: CatalogTree;
  let desktop: Desktop;
  let id: string;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
    onTeardownAsync(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    });
  });

  afterEach(() => {
    desktop.assertDone();
  });

  /** The history catalog (57 snapshots, `main.evolving` renamed to `evolved` at 35) as an open connection. */
  async function connectHistory(): Promise<void> {
    id = uniqueId('travel');
    await setConnections([{ id, name: 'Lake', kind: 'sqlite', path: copyFixture('history/history.sqlite') }]);
    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, 'Lake'));
  }

  const evolved = (): ReturnType<typeof nodeAt> => nodeAt(tree, 'Lake', 'main', 'Tables', 'evolved');

  describe('declaration', () => {
    it('declares the three commands in the category aantje and hides them from the command palette', () => {
      const { commands, menus } = manifest().contributes;
      assert.deepEqual(
        commands
          .filter(({ command }) => /^aantje\.(queryAtSnapshot|compareSchema|compareSnapshots)$/.test(command))
          .map(({ command, title, category }) => [command, title, category]),
        [
          ['aantje.queryAtSnapshot', 'Query at Snapshot...', 'aantje'],
          ['aantje.compareSchema', 'Compare Schema...', 'aantje'],
          ['aantje.compareSnapshots', 'Compare Snapshots...', 'aantje'],
        ],
      );
      const hidden = (menus.commandPalette ?? [])
        .filter(({ when }) => when === 'false')
        .map((e) => e.command);
      for (const command of ['aantje.queryAtSnapshot', 'aantje.compareSchema', 'aantje.compareSnapshots']) {
        assert.ok(hidden.includes(command), `${command} is hidden`);
      }
    });

    it('offers the submenu Time Travel on tables and views between Script as and the data entries, and Compare Snapshots on a connection', () => {
      const { submenus, menus } = manifest().contributes;
      assert.deepEqual(
        submenus.filter((submenu) => submenu.id === 'aantje.timeTravel'),
        [{ id: 'aantje.timeTravel', label: 'Time Travel' }],
      );
      const context = menus['view/item/context'] ?? [];
      assert.deepEqual(
        context.filter(({ submenu }) => submenu === 'aantje.timeTravel'),
        [
          {
            submenu: 'aantje.timeTravel',
            when: 'view == aantje.catalogs && viewItem =~ /^(table|view)$/',
            group: '2_travel',
          },
        ],
      );
      assert.deepEqual(
        (menus['aantje.timeTravel'] ?? []).map(({ command, when }) => [command, when]),
        [
          ['aantje.queryAtSnapshot', undefined],
          ['aantje.compareSchema', 'viewItem == table'],
          ['aantje.showChanges', 'viewItem == table'],
        ],
      );
      assert.deepEqual(
        context.filter(({ command }) => command === 'aantje.compareSnapshots'),
        [
          {
            command: 'aantje.compareSnapshots',
            when: 'view == aantje.catalogs && viewItem =~ /^connection\\.connected(\\.azure)?$/',
            group: '2_travel@1',
          },
        ],
      );
    });
  });

  describe('Query at Snapshot, Create Notebook', () => {
    beforeEach(connectHistory);

    it('pins the notebook to the chosen snapshot and names the table as it was then', async () => {
      const notebooks = recordNotebooks();
      desktop.answer(pick('@30'), pick('Create Notebook'));

      await vscode.commands.executeCommand('aantje.queryAtSnapshot', await evolved());

      // The tree shows snapshot 56, where the table is `evolved`; at 30 it is `evolving`.
      assert.deepEqual(
        desktop.picks.map(({ title, placeholder, active }) => [title, placeholder, active]),
        [
          ['Query main.evolved at a snapshot', 'Choose the snapshot to read', ['@56']],
          ['Query main.evolved at @30', 'Choose what to open', []],
        ],
      );
      // The table exists from snapshot 26 on: 31 rows, newest first, without "Latest".
      assert.deepEqual(
        desktop.picks[0]?.rows.map(({ label }) => label),
        newestFirst(26, 56),
      );
      assert.deepEqual(desktop.picks[0]?.rows.at(-1), {
        label: '@26',
        description: desktop.picks[0]?.rows.at(-1)?.description,
        detail: 'Created table main.evolving',
      });
      assert.deepEqual(
        desktop.picks[1]?.rows.map(({ label }) => label),
        ['Top 1000 Rows', 'Create Notebook', 'Open as SQL'],
      );
      assert.equal(notebooks.length, 1);
      const [cells] = notebooks;
      assert.ok(cells?.[0]?.includes('pinned to snapshot 30'), 'the title cell says so');
      assert.ok(
        cells?.some((cell) => /^SNAPSHOT = 30$/m.test(cell)),
        'the configuration pins SNAPSHOT',
      );
      assert.ok(
        cells?.some((cell) => cell.includes('SELECT * FROM lake."main"."evolving" LIMIT 1000')),
        'the query names the table as it was at snapshot 30',
      );
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });

    it('keeps following the tree for Create Notebook: pinned when the tree is pinned, latest otherwise', async () => {
      const notebooks = recordNotebooks();
      await vscode.commands.executeCommand('aantje.createNotebook', await evolved());
      tree.selectSnapshot(id, 30);
      // At snapshot 30 the node carries the name of that time.
      await vscode.commands.executeCommand(
        'aantje.createNotebook',
        await nodeAt(tree, 'Lake', 'main', 'Tables', 'evolving'),
      );

      assert.deepEqual(
        notebooks.map((cells) => cells.find((cell) => cell.startsWith('# '))?.includes('follows the latest')),
        [true, false],
      );
      assert.ok(notebooks[0]?.some((cell) => /^SNAPSHOT = None$/m.test(cell)));
      assert.ok(notebooks[1]?.some((cell) => /^SNAPSHOT = 30$/m.test(cell)));
    });

    it('preselects the snapshot that the tree shows, and lists only the snapshots at which a dropped table existed', async () => {
      const notebooks = recordNotebooks();
      tree.selectSnapshot(id, 44);
      desktop.answer(pick('@43'), pick('Create Notebook'));

      await vscode.commands.executeCommand(
        'aantje.queryAtSnapshot',
        await nodeAt(tree, 'Lake', 'shop', 'Tables', 'old_stuff'),
      );

      // shop.old_stuff exists at 43 and 44; snapshot 45 dropped it.
      assert.deepEqual(
        desktop.picks[0]?.rows.map(({ label }) => label),
        ['@44', '@43'],
      );
      assert.deepEqual(desktop.picks[0]?.active, ['@44']);
      assert.ok(notebooks[0]?.some((cell) => /^SNAPSHOT = 43$/m.test(cell)));
    });

    it('does nothing when the user cancels the snapshot or the choice of what to open', async () => {
      const notebooks = recordNotebooks();
      desktop.answer(pick(undefined), pick('@30'), pick(undefined));

      await vscode.commands.executeCommand('aantje.queryAtSnapshot', await evolved());
      await vscode.commands.executeCommand('aantje.queryAtSnapshot', await evolved());

      assert.equal(desktop.picks.length, 3);
      assert.deepEqual(notebooks, []);
      assert.deepEqual([desktop.errors, desktop.infos, desktop.progress, gridTabs()], [[], [], [], []]);
    });

    it('says that the connection is closed, and asks nothing', async () => {
      const node = await evolved();
      await tree.disconnect(id);

      await vscode.commands.executeCommand('aantje.queryAtSnapshot', node);

      assert.deepEqual(desktop.errors, [CLOSED('query at a snapshot')]);
      assert.deepEqual(desktop.picks, []);
    });

    it('does nothing for a folder, a schema, a column, a connection or a call without a node', async () => {
      const notebooks = recordNotebooks();
      for (const path of [
        [],
        ['main'],
        ['main', 'Tables'],
        ['main', 'Tables', 'evolved', 'Columns'],
        ['main', 'Tables', 'evolved', 'Columns', 'info'],
      ]) {
        await vscode.commands.executeCommand('aantje.queryAtSnapshot', await nodeAt(tree, 'Lake', ...path));
      }
      await vscode.commands.executeCommand('aantje.queryAtSnapshot');

      assert.deepEqual(desktop.picks, []);
      assert.deepEqual([desktop.errors, desktop.infos, desktop.confirmations, notebooks], [[], [], [], []]);
    });
  });

  describe('Query at Snapshot, Open as SQL', () => {
    beforeEach(connectHistory);

    const EVOLVING_AT_30 = `-- Time travel to snapshot 30
SELECT
  "id",
  "title",
  "info",
  "n",
  "extra"
FROM "main"."evolving" AT (VERSION => 30)
LIMIT 1000;`;

    /** Runs the command with the answers and returns the untitled documents that it opened. */
    async function open(
      node: unknown,
      ...answers: ReturnType<typeof pick>[]
    ): Promise<vscode.TextDocument[]> {
      const before = new Set(untitledDocuments());
      desktop.answer(...answers);
      await vscode.commands.executeCommand('aantje.queryAtSnapshot', node);
      const opened = untitledDocuments().filter((document) => !before.has(document));
      // The untitled document is dirty: revert it, or closing it would ask whether to save.
      onTeardownAsync(async () => {
        for (let count = opened.length; count > 0; count--) {
          await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
        }
      });
      return opened;
    }

    it('opens the SELECT of the chosen snapshot in a SQL document of the connection, as the table was then, and runs nothing', async () => {
      const notebooks = recordNotebooks();

      // The tree shows snapshot 56, where the table is `evolved` with other columns.
      const [document, ...others] = await open(await evolved(), pick('@30'), pick('Open as SQL'));

      assert.deepEqual(others, []);
      assert.ok(document, 'a document opened');
      assert.equal(document.languageId, 'sql');
      assert.equal(document.getText(), EVOLVING_AT_30);
      assert.equal(vscode.window.activeTextEditor?.document, document);
      const { editors } = await activate();
      const key = document.uri.toString();
      assert.equal(editors.connectionOf(key), id, 'the document belongs to the connection');
      assert.deepEqual([editors.state(key)?.running, editors.state(key)?.sessionOpen], [false, false]);
      assert.deepEqual(notebooks, []);
      assert.deepEqual([desktop.errors, desktop.infos, desktop.progress, gridTabs()], [[], [], [], []]);
    });

    it('writes the current name and columns for a snapshot after the rename, and SELECT * for a view, without the trust question', async () => {
      const [later] = await open(await evolved(), pick('@40'), pick('Open as SQL'));
      assert.ok(later?.getText().includes('FROM "main"."evolved" AT (VERSION => 40)'));
      assert.ok(later?.getText().includes('"flag"'), 'the column that the table had gained by then');
      assert.ok(!later?.getText().includes('"extra"'), 'and not the one it had lost');

      tree.selectSnapshot(id, 41);
      const [view] = await open(
        await nodeAt(tree, 'Lake', 'shop', 'Views', 'tmp_view'),
        pick('@41'),
        pick('Open as SQL'),
      );
      assert.equal(
        view?.getText(),
        '-- Time travel to snapshot 41\nSELECT *\nFROM "shop"."tmp_view" AT (VERSION => 41)\nLIMIT 1000;',
      );
      assert.deepEqual(
        desktop.confirmations,
        [],
        'a view is not resolved, so no one is asked to trust the catalog',
      );
    });

    it('does nothing when the user cancels the snapshot or the choice, and for a node that is neither table nor view', async () => {
      assert.deepEqual(await open(await evolved(), pick(undefined)), []);
      assert.deepEqual(await open(await evolved(), pick('@30'), pick(undefined)), []);
      assert.deepEqual(await open(await nodeAt(tree, 'Lake', 'main', 'Tables')), []);
      assert.deepEqual(await open(undefined), []);
      assert.equal(desktop.picks.length, 3);
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });
  });

  describe('Query at Snapshot, Top 1000 Rows', function () {
    before(async function () {
      await requireEngine(this);
    });

    let webviews: WebviewRecord[];
    let name: string;
    let profileId: string;

    beforeEach(async () => {
      webviews = observeWebviews();
      await useExtensionCache();
      const { profile } = await copyDataFixture('sqlite');
      ({ name } = profile);
      profileId = profile.id;
      await setConnections([profile]);
      await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, name));
    });

    const title = (table: string, snapshot: number): string =>
      `sales.${table} (top 1000) · ${name} @${snapshot}`;
    const orders = (): ReturnType<typeof nodeAt> => nodeAt(tree, name, 'sales', 'Tables', 'orders');
    const dataOf = (record: WebviewRecord): unknown => {
      const { columns, rows } = (dataMessages(record)[0] as { data: { columns: unknown; rows: unknown } })
        .data;
      return { columns, rows };
    };

    it('opens the grid of the chosen snapshot next to the one of the tree, each in a panel of its own', async () => {
      desktop.answer(pick('@5'), pick('Top 1000 Rows'));

      await vscode.commands.executeCommand('aantje.queryAtSnapshot', await orders());
      await vscode.commands.executeCommand('aantje.previewTable', await orders());
      const [chosen, shown] = webviews;
      assert.ok(chosen && shown);
      await waitFor(
        'both grids',
        () => dataMessages(chosen).length === 1 && dataMessages(shown).length === 1,
      );

      // orders exists from snapshot 2 on, and the tree shows 13.
      assert.deepEqual(
        desktop.picks[0]?.rows.map(({ label }) => label),
        newestFirst(2, 13),
      );
      assert.deepEqual(desktop.picks[0]?.active, ['@13']);
      assert.deepEqual(gridTabs(), [title('orders', 5), title('orders', 13)]);
      // Snapshot 6 deleted order 2: at 5 the grid still shows it, at 13 it does not.
      assert.deepEqual(dataOf(chosen), { columns: ORDERS_GRID_COLUMNS, rows: [ORDER_1, ORDER_2, ORDER_3] });
      assert.deepEqual(dataOf(shown), { columns: ORDERS_GRID_COLUMNS, rows: [ORDER_1, ORDER_3] });
      assert.deepEqual(desktop.progress, ['Reading sales.orders...', 'Reading sales.orders...']);
    });

    it('reads again into the same panel when the same snapshot is chosen a second time', async () => {
      desktop.answer(pick('@5'), pick('Top 1000 Rows'), pick('@5'), pick('Top 1000 Rows'));

      await vscode.commands.executeCommand('aantje.queryAtSnapshot', await orders());
      const [grid] = webviews;
      assert.ok(grid);
      await waitFor('the first data', () => dataMessages(grid).length === 1);
      await vscode.commands.executeCommand('aantje.queryAtSnapshot', await orders());
      await waitFor('the second data', () => dataMessages(grid).length === 2);

      assert.equal(webviews.length, 1);
      assert.deepEqual(gridTabs(), [title('orders', 5)]);
    });

    it('lists only the snapshots at which a table that is dropped now existed, with the one the tree shows highlighted', async () => {
      tree.selectSnapshot(profileId, 5);
      desktop.answer(pick('@3'), pick('Top 1000 Rows'));

      await vscode.commands.executeCommand(
        'aantje.queryAtSnapshot',
        await nodeAt(tree, name, 'sales', 'Tables', 'tmp'),
      );
      const [grid] = webviews;
      assert.ok(grid);
      await waitFor('the data of tmp', () => dataMessages(grid).length === 1);

      // sales.tmp was created at 3 and dropped at 11.
      assert.deepEqual(
        desktop.picks[0]?.rows.map(({ label }) => label),
        newestFirst(3, 10),
      );
      assert.deepEqual(desktop.picks[0]?.active, ['@5']);
      assert.deepEqual(gridTabs(), [title('tmp', 3)]);
      assert.deepEqual(dataOf(grid), { columns: [{ name: 'a', type: 'INTEGER', kind: 'number' }], rows: [] });
    });

    it('does nothing when the user cancels either question', async () => {
      desktop.answer(pick(undefined), pick('@5'), pick(undefined));

      await vscode.commands.executeCommand('aantje.queryAtSnapshot', await orders());
      await vscode.commands.executeCommand('aantje.queryAtSnapshot', await orders());

      assert.equal(desktop.picks.length, 3);
      assert.deepEqual(
        [desktop.errors, desktop.infos, desktop.progress, gridTabs(), webviews],
        [[], [], [], [], []],
      );
    });

    it('asks about the snapshot first and the trust second, and reads the view at the chosen snapshot once the user accepts', async () => {
      const view = (): ReturnType<typeof nodeAt> => nodeAt(tree, name, 'sales', 'Views', 'big_orders');
      desktop.answer(
        pick('@9'),
        pick('Top 1000 Rows'),
        confirm(false),
        pick('@9'),
        pick('Top 1000 Rows'),
        confirm(true),
      );

      await vscode.commands.executeCommand('aantje.queryAtSnapshot', await view());
      assert.deepEqual(desktop.infos, [
        `You did not trust the connection "${name}", so its views are not resolved.`,
      ]);
      assert.deepEqual([desktop.progress, gridTabs()], [[], []], 'nothing was read');

      await vscode.commands.executeCommand('aantje.queryAtSnapshot', await view());
      const [grid] = webviews;
      assert.ok(grid);
      await waitFor('the rows of the view', () => dataMessages(grid).length === 1);

      // The view exists from snapshot 7 on.
      assert.deepEqual(
        desktop.picks[0]?.rows.map(({ label }) => label),
        newestFirst(7, 13),
      );
      assert.deepEqual(gridTabs(), [title('big_orders', 9)]);
      assert.deepEqual(dataOf(grid), { columns: ORDERS_GRID_COLUMNS, rows: [ORDER_1, ORDER_3] });
      assert.equal(desktop.confirmations.length, 2);
    });
  });

  describe('Compare Schema', () => {
    beforeEach(connectHistory);

    /** The text of both documents of the one diff editor that is open. */
    async function openDiff(): Promise<{ label: string; left: string; right: string; uris: string[] }> {
      const [tab] = await waitFor('the diff editor', () => {
        const tabs = diffTabs();
        return tabs.length > 0 ? tabs : undefined;
      });
      assert.ok(tab);
      const [left, right] = await Promise.all([
        vscode.workspace.openTextDocument(tab.original),
        vscode.workspace.openTextDocument(tab.modified),
      ]);
      assert.deepEqual([left.languageId, right.languageId], ['sql', 'sql']);
      return {
        label: tab.label,
        left: left.getText(),
        right: right.getText(),
        uris: [tab.original, tab.modified].map((uri) => `${uri.scheme}:${uri.path}?${uri.query}`),
      };
    }

    it('opens the diff editor over the CREATE TABLE of both snapshots and tells what changed', async () => {
      desktop.answer(pick('@30'), pick('@35'));

      await vscode.commands.executeCommand('aantje.compareSchema', await evolved());
      const diff = await openDiff();

      assert.equal(diff.label, 'main.evolved: @30 ↔ @35');
      assert.equal(diff.left, EVOLVED_AT_30);
      assert.equal(diff.right, EVOLVED_AT_35);
      // Keyed by table and snapshot, with the connection in the query: no name, no secret.
      assert.deepEqual(diff.uris, [`aantje-schema:/12@30.sql?${id}`, `aantje-schema:/12@35.sql?${id}`]);
      assert.deepEqual(desktop.infos, ['table renamed, 2 columns added, 1 removed between @30 and @35']);
      assert.deepEqual(
        desktop.picks.map(({ title, rows, active }) => [title, rows.length, rows[0]?.label, active]),
        [
          ['Compare "main.evolved" (1/2)', 31, '@56', ['@56']],
          // A is not offered a second time; the newest of the rest is highlighted.
          ['Compare "main.evolved" (2/2)', 30, '@56', ['@56']],
        ],
      );
      assert.ok(!desktop.picks[1]?.rows.some(({ label }) => label === '@30'));
      assert.deepEqual([desktop.errors, desktop.warnings], [[], []]);
    });

    it('puts the older snapshot on the left, whichever is chosen first, and starts A at the snapshot of the tree', async () => {
      tree.selectSnapshot(id, 35);
      desktop.answer(pick('@35'), pick('@30'));

      await vscode.commands.executeCommand('aantje.compareSchema', await evolved());
      const diff = await openDiff();

      assert.deepEqual(desktop.picks[0]?.active, ['@35']);
      assert.equal(diff.label, 'main.evolved: @30 ↔ @35');
      assert.deepEqual([diff.left, diff.right], [EVOLVED_AT_30, EVOLVED_AT_35]);
    });

    it('only says so, and opens no diff editor, when the schema is the same at both snapshots', async () => {
      desktop.answer(pick('@36'), pick('@56'));

      await vscode.commands.executeCommand('aantje.compareSchema', await evolved());

      assert.deepEqual(desktop.infos, ['No schema changes between @36 and @56']);
      assert.deepEqual(diffTabs(), []);
    });

    it('does nothing when the user cancels the choice of A or of B', async () => {
      desktop.answer(pick(undefined), pick('@30'), pick(undefined));

      await vscode.commands.executeCommand('aantje.compareSchema', await evolved());
      await vscode.commands.executeCommand('aantje.compareSchema', await evolved());

      assert.equal(desktop.picks.length, 3);
      assert.deepEqual([desktop.infos, desktop.errors, diffTabs()], [[], [], []]);
    });

    it('says that the connection is closed, and asks nothing', async () => {
      const node = await evolved();
      await tree.disconnect(id);

      await vscode.commands.executeCommand('aantje.compareSchema', node);

      assert.deepEqual(desktop.errors, [CLOSED('compare its schema')]);
      assert.deepEqual(desktop.picks, []);
    });

    it('does nothing for a view, a folder, a schema, a column, a connection or a call without a node', async () => {
      for (const path of [
        [],
        ['shop'],
        ['shop', 'Views', 'big_events'],
        ['main', 'Tables'],
        ['main', 'Tables', 'evolved', 'Columns', 'info'],
      ]) {
        await vscode.commands.executeCommand('aantje.compareSchema', await nodeAt(tree, 'Lake', ...path));
      }
      await vscode.commands.executeCommand('aantje.compareSchema');

      assert.deepEqual(desktop.picks, []);
      assert.deepEqual([desktop.infos, desktop.errors, diffTabs()], [[], [], []]);
    });
  });

  describe('Compare Snapshots', () => {
    beforeEach(connectHistory);

    const connection = (): ReturnType<typeof nodeAt> => nodeAt(tree, 'Lake');

    it('opens a Markdown report of two snapshots of the catalog in a new untitled document', async () => {
      const reader = tree.reader(id);
      assert.ok(reader);
      const times = new Map(
        (await reader.snapshots()).map((snapshot) => [snapshot.id, formatUtc(snapshot.time)]),
      );
      const before = new Set(untitledDocuments());
      onTeardownAsync(async () => {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      });
      desktop.answer(pick('@30'), pick('@35'));

      await vscode.commands.executeCommand('aantje.compareSnapshots', await connection());

      const [document, ...more] = untitledDocuments().filter((candidate) => !before.has(candidate));
      assert.ok(document && more.length === 0, 'one document');
      assert.equal(document.languageId, 'markdown');
      assert.equal(vscode.window.activeTextEditor?.document, document);
      assert.equal(
        document.getText(),
        [
          '# Lake: @30 to @35',
          '',
          `- From: @30, ${times.get(30)}`,
          `- To: @35, ${times.get(35)}`,
          '',
          '## Tables and views',
          '',
          '### Renamed (1)',
          '',
          '- table `main.evolving` is now `main.evolved`',
          '',
          '## Columns',
          '',
          'Compared 6 tables that exist at both snapshots. 1 of them has column changes.',
          '',
          '### `main.evolved`',
          '',
          '- added `info.c` (`float64`)',
          '- added `flag` (`boolean`)',
          '- removed `extra` (`float64`)',
          '',
        ].join('\n'),
      );
      assert.deepEqual(
        desktop.picks.map(({ title, rows, active }) => [
          title,
          rows.length,
          rows[0]?.label,
          rows.at(-1)?.label,
          active,
        ]),
        [
          ['Compare "Lake" (1/2)', 57, '@56', '@0', ['@56']],
          ['Compare "Lake" (2/2)', 56, '@56', '@0', ['@56']],
        ],
      );
      assert.deepEqual(desktop.progress, ['Comparing snapshots...']);
      assert.deepEqual([desktop.infos, desktop.errors], [[], []]);
    });

    it('does nothing when the user cancels the choice of A or of B', async () => {
      const before = untitledDocuments().length;
      desktop.answer(pick(undefined), pick('@3'), pick(undefined));

      await vscode.commands.executeCommand('aantje.compareSnapshots', await connection());
      await vscode.commands.executeCommand('aantje.compareSnapshots', await connection());

      assert.equal(desktop.picks.length, 3);
      assert.equal(untitledDocuments().length, before);
      assert.deepEqual([desktop.progress, desktop.infos, desktop.errors], [[], [], []]);
    });

    it('asks to connect first when the connection is closed', async () => {
      const node = await connection();
      await tree.disconnect(id);

      await vscode.commands.executeCommand('aantje.compareSnapshots', node);

      assert.deepEqual(desktop.infos, ['Connect to a catalog first to compare snapshots.']);
      assert.deepEqual(desktop.picks, []);
    });

    it('does nothing for a schema, a table, a column or a call without a node', async () => {
      const before = untitledDocuments().length;
      for (const path of [
        ['main'],
        ['main', 'Tables', 'evolved'],
        ['main', 'Tables', 'evolved', 'Columns', 'info'],
      ]) {
        await vscode.commands.executeCommand('aantje.compareSnapshots', await nodeAt(tree, 'Lake', ...path));
      }
      await vscode.commands.executeCommand('aantje.compareSnapshots');

      assert.deepEqual(desktop.picks, []);
      assert.equal(untitledDocuments().length, before);
      assert.deepEqual([desktop.infos, desktop.errors, desktop.progress], [[], [], []]);
    });
  });
});
