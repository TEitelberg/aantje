import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { CatalogTree } from '../../src/tree/model';
import {
  copyHistoryDataFixture,
  dataMessages,
  gridTabs,
  observeWebviews,
  requireEngine,
  useExtensionCache,
} from './data';
import type { WebviewRecord } from './data';
import { Desktop, pick } from './desktop';
import { activate, extension, nodeAt, setConnections, waitFor } from './support';

const FEED_COLUMNS = [
  { name: 'snapshot_id', type: 'BIGINT', kind: 'number' },
  { name: 'rowid', type: 'BIGINT', kind: 'number' },
  { name: 'change_type', type: 'VARCHAR', kind: 'text' },
  { name: 'id', type: 'INTEGER', kind: 'number' },
  { name: 'name', type: 'VARCHAR', kind: 'text' },
  { name: 'tier', type: 'VARCHAR', kind: 'text' },
];

const INSERTS = [
  ['16', '0', 'insert', 1, 'ada', 'bronze'],
  ['16', '1', 'insert', 2, 'bob', 'bronze'],
  ['16', '2', 'insert', 3, 'cy', 'silver'],
  ['16', '3', 'insert', 4, 'di', 'silver'],
];
const UPDATE = [
  ['17', '1', 'update_preimage', 2, 'bob', 'bronze'],
  ['17', '1', 'update_postimage', 2, 'bob', 'gold'],
];
const DELETE = [['18', '3', 'delete', 4, 'di', 'silver']];

/** What the grid page was sent for the changes of shop.customers, without the time the query took. */
function changes(rows: unknown[][], rowKinds: string[], summary: string): unknown {
  return {
    type: 'data',
    data: {
      table: { schema: 'shop', table: 'customers' },
      columns: FEED_COLUMNS,
      rows,
      limit: 1000,
      truncated: false,
      rowKinds,
      summary,
    },
  };
}

function shownBy(record: WebviewRecord, index: number): unknown {
  const message = dataMessages(record)[index] as { type: string; data: { elapsedMs: unknown } };
  assert.equal(typeof message.data.elapsedMs, 'number', 'the page is told how long the query took');
  const { elapsedMs: _, ...data } = message.data;
  return { type: message.type, data };
}

const title = (connection: string, from: number, to: number): string =>
  `shop.customers changes @${from} → @${to} · ${connection}`;

describe('Show Changes and Show Rows Changed', function () {
  before(async function () {
    await requireEngine(this);
  });

  let tree: CatalogTree;
  let desktop: Desktop;
  let webviews: WebviewRecord[];
  let name: string;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
    webviews = observeWebviews();
    await useExtensionCache();
    const { profile } = await copyHistoryDataFixture('sqlite');
    ({ name } = profile);
    await setConnections([profile]);
    await vscode.commands.executeCommand('aantje.connect', await nodeAt(tree, name));
  });

  afterEach(() => {
    desktop.assertDone();
  });

  const customers = (): ReturnType<typeof nodeAt> => nodeAt(tree, name, 'shop', 'Tables', 'customers');
  /** The leaf of a snapshot that names a table, e.g. the first change of `@17`. */
  const leaf = (snapshot: number, label = 'shop.customers'): ReturnType<typeof nodeAt> =>
    nodeAt(tree, name, 'Snapshots', `@${snapshot}`, label);

  describe('declaration', () => {
    it('declares both commands in the category aantje, hidden from the command palette, in the places that the plan names', () => {
      const { commands, menus } = (
        extension().packageJSON as {
          contributes: {
            commands: { command: string; title: string; category?: string }[];
            menus: Record<string, { command?: string; when?: string; group?: string }[]>;
          };
        }
      ).contributes;

      assert.deepEqual(
        commands
          .filter(({ command }) => /^aantje\.(showChanges|showSnapshotChanges)$/.test(command))
          .map(({ command, title, category }) => [command, title, category]),
        [
          ['aantje.showChanges', 'Show Changes...', 'aantje'],
          ['aantje.showSnapshotChanges', 'Show Rows Changed', 'aantje'],
        ],
      );
      const hidden = (menus.commandPalette ?? [])
        .filter(({ when }) => when === 'false')
        .map((e) => e.command);
      assert.ok(hidden.includes('aantje.showChanges') && hidden.includes('aantje.showSnapshotChanges'));
      assert.deepEqual(
        (menus['aantje.timeTravel'] ?? []).filter(({ command }) => command === 'aantje.showChanges'),
        [{ command: 'aantje.showChanges', when: 'viewItem =~ /^table(\\.azure)?$/', group: 'travel@3' }],
      );
      assert.deepEqual(
        (menus['view/item/context'] ?? []).filter(({ command }) => command === 'aantje.showSnapshotChanges'),
        [
          {
            command: 'aantje.showSnapshotChanges',
            when: 'view == aantje.catalogs && viewItem == detail.table',
            group: '1_changes@1',
          },
        ],
      );
    });
  });

  describe('Show Changes...', () => {
    it('asks for the two snapshots and shows the rows that were inserted, updated and deleted in a grid', async () => {
      desktop.answer(pick('@15'), pick('@18'));

      await vscode.commands.executeCommand('aantje.showChanges', await customers());
      const [grid] = webviews;
      assert.ok(grid);
      await waitFor('the grid page to ask for its data and get it', () => dataMessages(grid).length > 0);

      assert.deepEqual(
        desktop.picks.map(({ title: t, placeholder, active, rows }) => [t, placeholder, active, rows.length]),
        [
          [
            'Show changes of shop.customers (1/2)',
            'Choose the snapshot to compare against: the changes made after it are shown',
            // The tree shows the newest snapshot, which cannot be a start: nothing comes after it.
            [],
            42,
          ],
          [
            'Show changes of shop.customers (2/2)',
            'Choose the last snapshot to include: the changes after @15 up to it are shown',
            ['@56'],
            41,
          ],
        ],
      );
      assert.deepEqual(gridTabs(), [title(name, 15, 18)]);
      assert.deepEqual(
        webviews.map(({ viewType, title: t }) => ({ viewType, title: t })),
        [{ viewType: 'aantje.grid', title: title(name, 15, 18) }],
      );
      assert.deepEqual(desktop.progress, ['Reading the changes of shop.customers...']);
      assert.deepEqual(
        shownBy(grid, 0),
        changes(
          [...INSERTS, ...UPDATE, ...DELETE],
          ['insert', 'insert', 'insert', 'insert', 'update-before', 'update-after', 'delete'],
          '4 inserted, 1 updated, 1 deleted (6 changes) after @15 until @18 · @16 +4 · @17 ~1 · @18 −1',
        ),
      );
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });

    it('shows only the changes after the first snapshot: since @16 the insert is not part of it', async () => {
      desktop.answer(pick('@16'), pick('@17'));

      await vscode.commands.executeCommand('aantje.showChanges', await customers());
      const [grid] = webviews;
      assert.ok(grid);
      await waitFor('the data', () => dataMessages(grid).length > 0);

      assert.deepEqual(gridTabs(), [title(name, 16, 17)]);
      assert.deepEqual(
        shownBy(grid, 0),
        changes(
          UPDATE,
          ['update-before', 'update-after'],
          '1 updated (1 change) after @16 until @17 · @17 ~1',
        ),
      );
    });

    it('reads a renamed table by the name it has at the end of the range, not by the name that the tree shows', async () => {
      // The tree shows main.evolved; until @30 the table was still called main.evolving.
      desktop.answer(pick('@26'), pick('@30'));

      await vscode.commands.executeCommand(
        'aantje.showChanges',
        await nodeAt(tree, name, 'main', 'Tables', 'evolved'),
      );
      const [grid] = webviews;
      assert.ok(grid);
      await waitFor('the data', () => dataMessages(grid).length > 0);

      const { data } = shownBy(grid, 0) as { data: { table: unknown; rows: unknown[][] } };
      assert.deepEqual(data.table, { schema: 'main', table: 'evolving' });
      assert.deepEqual(data.rows, [['27', '0', 'insert', 1, 'one', '{"a":1,"b":"x"}', '10', null]]);
      assert.deepEqual(gridTabs(), [`main.evolving changes @26 → @30 · ${name}`]);
      assert.deepEqual([desktop.errors, desktop.infos], [[], []]);
    });

    it('reuses the panel of a range that it shows again, and opens another panel for another range', async () => {
      desktop.answer(pick('@16'), pick('@17'), pick('@16'), pick('@17'), pick('@17'), pick('@18'));
      const node = await customers();

      await vscode.commands.executeCommand('aantje.showChanges', node);
      const [grid] = webviews;
      assert.ok(grid);
      await waitFor('the first data', () => dataMessages(grid).length === 1);
      await vscode.commands.executeCommand('aantje.showChanges', node);
      await waitFor('the second data', () => dataMessages(grid).length === 2);
      await vscode.commands.executeCommand('aantje.showChanges', node);
      const other = webviews[1];
      assert.ok(other);
      await waitFor('the data of the other range', () => dataMessages(other).length === 1);

      assert.equal(webviews.length, 2);
      assert.deepEqual(gridTabs(), [title(name, 16, 17), title(name, 17, 18)]);
      assert.deepEqual(
        shownBy(other, 0),
        changes(DELETE, ['delete'], '1 deleted (1 change) after @17 until @18 · @18 −1'),
      );
    });

    it('does nothing when the user cancels either question', async () => {
      desktop.answer(pick(undefined), pick('@16'), pick(undefined));
      const node = await customers();

      await vscode.commands.executeCommand('aantje.showChanges', node);
      await vscode.commands.executeCommand('aantje.showChanges', node);

      assert.equal(desktop.picks.length, 3);
      assert.deepEqual(desktop.progress, []);
      assert.deepEqual([desktop.errors, desktop.infos, webviews, gridTabs()], [[], [], [], []]);
    });

    it('says that the connection is closed and asks nothing', async () => {
      const node = await customers();
      await tree.disconnect(node.ref.connectionId);

      await vscode.commands.executeCommand('aantje.showChanges', node);

      assert.deepEqual(desktop.errors, ['The connection is closed. Connect again to show its changes.']);
      assert.deepEqual([desktop.picks, webviews], [[], []]);
    });

    it('does nothing for a view, a schema, a folder, a column, a connection or a call without a node', async () => {
      for (const path of [
        [],
        ['shop'],
        ['shop', 'Views'],
        ['shop', 'Views', 'big_events'],
        ['shop', 'Tables', 'customers', 'Columns'],
        ['shop', 'Tables', 'customers', 'Columns', 'tier'],
        ['Snapshots', '@17'],
      ]) {
        await vscode.commands.executeCommand('aantje.showChanges', await nodeAt(tree, name, ...path));
      }
      await vscode.commands.executeCommand('aantje.showChanges');

      assert.deepEqual([desktop.picks, desktop.progress, webviews, gridTabs()], [[], [], [], []]);
      assert.deepEqual([desktop.errors, desktop.infos, desktop.confirmations], [[], [], []]);
    });
  });

  describe('Show Rows Changed on the change of a snapshot', () => {
    const SNAPSHOTS: [string, number, unknown[][], string[], string][] = [
      [
        'the insert of snapshot 16',
        16,
        INSERTS,
        ['insert', 'insert', 'insert', 'insert'],
        '4 inserted (4 changes) after @15 until @16 · @16 +4',
      ],
      [
        'the update of snapshot 17',
        17,
        UPDATE,
        ['update-before', 'update-after'],
        '1 updated (1 change) after @16 until @17 · @17 ~1',
      ],
      [
        'the delete of snapshot 18',
        18,
        DELETE,
        ['delete'],
        '1 deleted (1 change) after @17 until @18 · @18 −1',
      ],
    ];
    for (const [what, snapshot, rows, kinds, summary] of SNAPSHOTS) {
      it(`opens the grid with exactly the rows of ${what}, without asking anything`, async () => {
        await vscode.commands.executeCommand('aantje.showSnapshotChanges', await leaf(snapshot));
        const [grid] = webviews;
        assert.ok(grid);
        await waitFor('the data', () => dataMessages(grid).length > 0);

        assert.deepEqual(gridTabs(), [title(name, snapshot - 1, snapshot)]);
        assert.deepEqual(shownBy(grid, 0), changes(rows, kinds, summary));
        assert.deepEqual(desktop.progress, ['Reading the changes of shop.customers...']);
        assert.deepEqual([desktop.picks, desktop.errors, desktop.infos], [[], [], []]);
      });
    }

    it('opens the same panel as Show Changes for the same range', async () => {
      desktop.answer(pick('@16'), pick('@17'));

      await vscode.commands.executeCommand('aantje.showChanges', await customers());
      const [grid] = webviews;
      assert.ok(grid);
      await waitFor('the first data', () => dataMessages(grid).length === 1);
      await vscode.commands.executeCommand('aantje.showSnapshotChanges', await leaf(17));
      await waitFor('the second data', () => dataMessages(grid).length === 2);

      assert.equal(webviews.length, 1);
      assert.deepEqual(shownBy(grid, 1), shownBy(grid, 0));
    });

    it('offers the command on the change of a table only: the context value tells the menu', async () => {
      assert.equal((await leaf(17)).contextValue, 'detail.table');
      assert.equal((await nodeAt(tree, name, 'Snapshots', '@39', 'shop.big_events')).contextValue, 'detail');
    });

    it('says that a table that the snapshot dropped has no rows to show', async () => {
      await vscode.commands.executeCommand('aantje.showSnapshotChanges', await leaf(45, 'shop.old_stuff'));

      assert.deepEqual(desktop.infos, [
        '"shop.old_stuff" does not exist at snapshot @45 (it was dropped there or is not created yet), so it has no rows to show.',
      ]);
      assert.deepEqual([desktop.progress, webviews, desktop.errors], [[], [], []]);
    });

    it('does nothing for the change of a view or a macro, a column or a folder', async () => {
      for (const path of [
        ['Snapshots', '@39', 'shop.big_events'],
        ['Snapshots', '@46', 'shop.gross'],
        ['Snapshots', '@17'],
        ['Snapshots'],
        ['shop', 'Tables', 'customers'],
        ['shop', 'Tables', 'customers', 'Columns', 'tier'],
      ]) {
        await vscode.commands.executeCommand('aantje.showSnapshotChanges', await nodeAt(tree, name, ...path));
      }
      await vscode.commands.executeCommand('aantje.showSnapshotChanges');

      assert.deepEqual([desktop.picks, desktop.progress, webviews, gridTabs()], [[], [], [], []]);
      assert.deepEqual([desktop.errors, desktop.infos, desktop.confirmations], [[], [], []]);
    });
  });
});
