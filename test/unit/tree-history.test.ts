import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Driver } from '../../src/catalog/drivers/driver';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { createCatalogReader } from '../../src/catalog/reader';
import { CatalogTree } from '../../src/tree/model';
import type { TreeNode } from '../../src/tree/refs';
import { HISTORY_ID, HISTORY_LATEST_SNAPSHOT, HISTORY_SNAPSHOT } from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { historyFixture, historySources } from '../support/sources/history';

/** The catalog of the main fixture as DuckDB 1.5 wrote it (DuckLake specification 1.0). */
const FIXTURE_V1_0 = fileURLToPath(new URL('../fixtures/ducklake-1.0.sqlite', import.meta.url));

const UTC = String.raw`\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC`;

const trees: CatalogTree[] = [];
const opened: Driver[] = [];
let directory: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'aantje-tree-history-'));
});
afterEach(async () => {
  await Promise.all(trees.splice(0).map((tree) => tree.dispose()));
  await Promise.all(opened.splice(0).map((driver) => driver.close().catch(() => undefined)));
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** A tree on the real reader; `open` gives the driver of the catalog. */
function treeOn(open: () => Promise<Driver>): CatalogTree {
  const tree = new CatalogTree({
    profiles: () => [{ id: 'h', name: 'Lake', kind: 'sqlite', path: 'unused' }],
    open: async () => {
      const driver = await open();
      opened.push(driver);
      const reader = createCatalogReader(driver);
      return { reader, info: await reader.info() };
    },
  });
  trees.push(tree);
  return tree;
}

let copies = 0;

/** A copy of a SQLite catalog after `statements` ran on it, opened with the real SQLite driver. */
async function treeOnCopy(source: string, ...statements: string[]): Promise<CatalogTree> {
  const wasm = readFileSync(wasmPath);
  const SQL = await initSqlJs({
    wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
  });
  const db = new SQL.Database(readFileSync(source));
  for (const statement of statements) {
    db.run(statement);
  }
  const path = join(directory, `copy-${copies++}.sqlite`);
  writeFileSync(path, db.export());
  db.close();
  return treeOn(() => openSqlite({ path, wasmPath }));
}

/** The node at a path of labels from the connection down; the nodes on the way are expanded, the result is not. */
async function find(tree: CatalogTree, ...labels: string[]): Promise<TreeNode> {
  let nodes = tree.roots();
  let found: TreeNode | undefined;
  for (const label of labels) {
    if (found) {
      nodes = await tree.children(found);
    }
    found = nodes.find((node) => node.label === label);
    if (!found) {
      throw new Error(`No "${label}" among ${nodes.map((node) => `"${node.label}"`).join(', ')}.`);
    }
  }
  if (!found) {
    throw new Error('Expected a path.');
  }
  return found;
}

const labelsBelow = async (tree: CatalogTree, ...labels: string[]): Promise<string[]> =>
  (await tree.children(await find(tree, 'Lake', ...labels))).map((node) => node.label);

/** Label and description of every child. */
const shownBelow = async (tree: CatalogTree, ...labels: string[]): Promise<string[][]> =>
  (await tree.children(await find(tree, 'Lake', ...labels))).map((node) => [
    node.label,
    node.description ?? '',
  ]);

async function allNodes(tree: CatalogTree): Promise<TreeNode[]> {
  const nodes: TreeNode[] = [];
  const visit = async (list: readonly TreeNode[]): Promise<void> => {
    for (const node of list) {
      nodes.push(node);
      await visit(await tree.children(node));
    }
  };
  await visit(tree.roots());
  return nodes;
}

const SHOP = ['Lake', 'shop'];
const EVENTS = [...SHOP, 'Tables', 'events'];

for (const source of historySources) {
  const skipReason = source.skipReason();
  describe.skipIf(skipReason !== undefined)(
    `the tree of the history fixture, ${source.name}${skipReason === undefined ? '' : ` (skipped: ${skipReason})`}`,
    () => {
      const open = () => treeOn(() => source.open());
      const at = async (snapshot: number): Promise<CatalogTree> => {
        const tree = open();
        await tree.connect('h');
        tree.selectSnapshot('h', snapshot);
        return tree;
      };

      it('lists the schemas and the Snapshots folder, and in it the newest 50 snapshots, newest first', async () => {
        const tree = open();
        const children = await tree.children(await find(tree, 'Lake'));

        expect(children.map(({ label, contextValue, id }) => [label, contextValue, id])).toEqual([
          ['main', 'schema.main', 'h/s0'],
          ['shop', 'schema', 'h/s1'],
          ['Snapshots', 'folder.snapshots', 'h/snapshots'],
        ]);
        expect(await labelsBelow(await at(HISTORY_SNAPSHOT.createMain))).toEqual(['main', 'Snapshots']);

        const nodes = await tree.children(await find(tree, 'Lake', 'Snapshots'));
        expect(nodes.map(({ label }) => label)).toEqual(
          Array.from({ length: 50 }, (_, index) => `@${HISTORY_LATEST_SNAPSHOT - index}`),
        );
        expect(nodes[0]).toMatchObject({
          id: 'h/snapshots/n56',
          contextValue: 'snapshot',
          hasChildren: true,
          ref: { kind: 'snapshot', connectionId: 'h', snapshot: { id: 56 } },
        });
        expect(nodes[0]?.description).toMatch(new RegExp(`^${UTC}$`));
      });

      it('lists the objects that a snapshot changed, with the table that its rows can be shown for', async () => {
        const tree = open();
        const leaves = async (snapshot: number) =>
          tree.children(await find(tree, 'Lake', 'Snapshots', `@${snapshot}`));

        const two = await leaves(HISTORY_SNAPSHOT.twoTablesInOneTransaction);
        expect(
          two.map(({ id, label, contextValue, hasChildren }) => [id, label, contextValue, hasChildren]),
        ).toEqual([
          ['h/snapshots/n23/c0', 'shop.events', 'detail.table', false],
          ['h/snapshots/n23/c1', 'shop.customers', 'detail.table', false],
        ]);
        expect(two.map(({ ref }) => ref)).toEqual([
          {
            kind: 'detail',
            connectionId: 'h',
            change: { snapshot: 23, table: { schema: 'shop', table: 'events' } },
          },
          {
            kind: 'detail',
            connectionId: 'h',
            change: { snapshot: 23, table: { schema: 'shop', table: 'customers' } },
          },
        ]);

        // Only a change of rows of a table gets the menu of a table; dropped and renamed objects are named.
        const expected: [number, string[], string][] = [
          [HISTORY_SNAPSHOT.dropOldStuff, ['shop.old_stuff'], 'detail.table'],
          [HISTORY_SNAPSHOT.renameTable, ['main.evolved'], 'detail.table'],
          [HISTORY_SNAPSHOT.createAndInsertInOneTransaction, ['shop.audit', 'shop.audit'], 'detail.table'],
          [HISTORY_SNAPSHOT.updateNote, ['shop.notes', 'shop.notes'], 'detail.table'],
          [HISTORY_SNAPSHOT.mergeLog, ['shop.log'], 'detail'],
          [HISTORY_SNAPSHOT.createGrossMacro, ['shop.gross'], 'detail'],
          [HISTORY_SNAPSHOT.dropTmpView, ['shop.tmp_view'], 'detail'],
          [HISTORY_SNAPSHOT.createBigEventsView, ['shop.big_events'], 'detail'],
        ];
        for (const [snapshot, names, contextValue] of expected) {
          const nodes = await leaves(snapshot);
          expect(
            nodes.map(({ label }) => label),
            `@${snapshot}`,
          ).toEqual(names);
          expect(nodes[0]?.contextValue, `@${snapshot}`).toBe(contextValue);
          if (contextValue === 'detail') {
            expect(nodes[0]?.ref, `@${snapshot}`).toEqual({ kind: 'detail', connectionId: 'h' });
          }
        }
      });

      it('shows the macros that exist at the shown snapshot', async () => {
        const tree = open();
        expect(await labelsBelow(tree, 'main')).toEqual(['Tables', 'Views', 'Macros']);
        expect((await tree.children(await find(tree, ...SHOP))).map(({ id }) => id)).toEqual([
          'h/s1/tables',
          'h/s1/views',
          'h/s1/macros',
        ]);

        const names = async (snapshot: number) => {
          const shown = await at(snapshot);
          const folders = await labelsBelow(shown, 'shop');
          return folders.includes('Macros') ? labelsBelow(shown, 'shop', 'Macros') : undefined;
        };
        expect(await names(HISTORY_SNAPSHOT.dropOldStuff)).toHaveLength(1);
        expect(await names(HISTORY_SNAPSHOT.createGrossMacro)).toEqual(['gross']);
        expect(await names(HISTORY_SNAPSHOT.createRecentEventsMacro)).toEqual(['gross', 'recent_events']);
        expect(await names(HISTORY_SNAPSHOT.createLegacyFeeMacro)).toEqual([
          'gross',
          'legacy_fee',
          'recent_events',
        ]);
        expect(await names(HISTORY_SNAPSHOT.dropLegacyFeeMacro)).toEqual(['gross', 'recent_events']);

        const [gross] = await tree.children(await find(tree, ...SHOP, 'Macros'));
        expect(gross).toMatchObject({
          id: 'h/s1/macros/m16',
          label: 'gross',
          contextValue: 'macro',
          hasChildren: false,
          ref: { kind: 'macro', macro: { id: HISTORY_ID.grossMacro } },
        });
        expect(gross?.tooltip).toContain('(net * rate)');
      });

      it('shows Partitioning and Sort Order as they were at the shown snapshot, and only once they exist', async () => {
        const tree = open();
        expect(await labelsBelow(tree, ...EVENTS.slice(1))).toEqual([
          'Statistics',
          'History',
          'Columns',
          'Partitioning',
        ]);
        expect(await labelsBelow(tree, 'shop', 'Tables', 'readings')).toEqual([
          'Statistics',
          'History',
          'Columns',
          'Sort Order',
        ]);
        expect(await labelsBelow(tree, 'shop', 'Tables', 'customers')).toEqual([
          'Statistics',
          'History',
          'Columns',
        ]);
        expect((await tree.children(await find(tree, ...EVENTS))).map(({ id }) => id)).toEqual([
          'h/s1/tables/t3/statistics',
          'h/s1/tables/t3/history',
          'h/s1/tables/t3/columns',
          'h/s1/tables/t3/partitioning',
        ]);

        const partitions = async (snapshot: number) =>
          shownBelow(await at(snapshot), ...EVENTS.slice(1), 'Partitioning');
        expect(await partitions(HISTORY_SNAPSHOT.insertEventsBulk)).toEqual([
          ['kind', 'identity'],
          ['ts', 'year'],
        ]);
        expect(await partitions(HISTORY_LATEST_SNAPSHOT)).toEqual([
          ['kind', 'identity'],
          ['ts', 'month'],
        ]);
        expect(await labelsBelow(await at(HISTORY_SNAPSHOT.createEvents), ...EVENTS.slice(1))).toEqual([
          'Statistics',
          'History',
          'Columns',
        ]);

        const sorts = async (snapshot: number) =>
          shownBelow(await at(snapshot), 'shop', 'Tables', 'readings', 'Sort Order');
        expect(await sorts(HISTORY_SNAPSHOT.sortReadingsBySensor)).toEqual([
          ['sensor', 'ASC NULLS LAST'],
          ['taken_at', 'DESC NULLS LAST'],
        ]);
        expect(await sorts(HISTORY_LATEST_SNAPSHOT)).toEqual([['"value"', 'DESC NULLS FIRST']]);
        expect(
          await labelsBelow(await at(HISTORY_SNAPSHOT.createReadings), 'shop', 'Tables', 'readings'),
        ).toEqual(['Statistics', 'History', 'Columns']);
      });

      it('has the leaves Statistics and History that run their commands, and rows that follow the snapshot', async () => {
        const tree = open();
        const [statistics, history] = await tree.children(await find(tree, ...EVENTS));

        for (const [leaf, folder, command] of [
          [statistics, 'statistics', 'aantje.showStatistics'],
          [history, 'history', 'aantje.showSchemaHistory'],
        ] as const) {
          expect(leaf).toMatchObject({
            contextValue: `folder.${folder}`,
            hasChildren: false,
            command: { id: command },
            ref: { kind: 'folder', folder, connectionId: 'h', table: { id: HISTORY_ID.events } },
          });
          expect(await tree.children(leaf as TreeNode)).toEqual([]);
        }

        /** The rows that the tooltip of the table states, and nothing else of its figures. */
        const rows = async (snapshot: number, name: string) =>
          /not included\): (\S+)/.exec(
            (await find(await at(snapshot), ...SHOP, 'Tables', name)).tooltip ?? '',
          )?.[1];
        expect(await rows(HISTORY_LATEST_SNAPSHOT, 'events')).toBe('52');
        expect(await rows(HISTORY_SNAPSHOT.insertEventView2026, 'events')).toBe('7');
        expect(await rows(HISTORY_SNAPSHOT.insertEventsBulk, 'events')).toBe('47');
        expect(await rows(HISTORY_SNAPSHOT.createEvents, 'events')).toBe('0');
        // A compacted file or a delete file that holds a later delete makes the rows approximate.
        expect(await rows(HISTORY_SNAPSHOT.insertLog2, 'log')).toBe('~4');
        expect(await rows(HISTORY_SNAPSHOT.insertLog4, 'log')).toBe('4');
        expect(await rows(HISTORY_SNAPSHOT.updateCustomer, 'customers')).toBe('~3');
      });

      it('has unique ids in the whole tree, each extending the id of its parent, the same after a refresh', async () => {
        const tree = open();
        const nodes = await allNodes(tree);

        expect(nodes.length).toBeGreaterThan(150);
        expect(new Set(nodes.map(({ id }) => id)).size).toBe(nodes.length);
        for (const node of nodes) {
          const parent = tree.parent(node);
          if (parent) {
            expect(node.id.startsWith(`${parent.id}/`), node.id).toBe(true);
          }
        }
        // No node other than a table or a view stands for one.
        expect([...new Set(nodes.map(({ ref }) => ref.kind))].sort()).toEqual([
          'column',
          'connection',
          'detail',
          'folder',
          'macro',
          'message',
          'schema',
          'snapshot',
          'table',
          'view',
        ]);
        const before = nodes.map(({ id }) => id);
        tree.refresh();
        await tree.connect('h');
        expect((await allNodes(tree)).map(({ id }) => id)).toEqual(before);
      });
    },
  );
}

describe('a history that is longer than the Snapshots folder shows', () => {
  // Snapshots 57 to 116 change shop.log again: 60 more snapshots and 117 snapshots.
  it('lists only the newest 50 of 117 snapshots', async () => {
    const tree = await treeOnCopy(
      historyFixture.sqlite,
      `WITH RECURSIVE n(i) AS (SELECT 57 UNION ALL SELECT i + 1 FROM n WHERE i < 116)
       INSERT INTO ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id)
       SELECT i, '2026-10-30 08:00:00.000000+00', 12, 20, 30 FROM n`,
      `INSERT INTO ducklake_snapshot_changes (snapshot_id, changes_made)
       SELECT snapshot_id, 'inserted_into_table:19' FROM ducklake_snapshot WHERE snapshot_id > 56`,
    );
    const nodes = await tree.children(await find(tree, 'Lake', 'Snapshots'));

    expect([nodes[0]?.label, nodes.at(-1)?.label, nodes.length]).toEqual(['@116', '@67', 50]);
  });
});

/** The driver of a catalog that fails the statements matching `failing` and reports the rows of every other one. */
function watched(failing: RegExp, rowsRead: { sql: string; rows: number }[]): () => Promise<Driver> {
  return async () => {
    const driver = await openSqlite({ path: historyFixture.sqlite, wasmPath });
    return {
      query: async (sql, params, options) => {
        if (failing.test(sql)) {
          throw new Error('The table cannot be read.');
        }
        const rows = await driver.query(sql, params, options);
        rowsRead.push({ sql, rows: rows.length });
        return rows;
      },
      close: () => driver.close(),
    };
  };
}

describe('what the folders read of a big or an odd catalog', () => {
  it('reads only the newest 50 snapshots when the Snapshots folder is expanded', async () => {
    const read: { sql: string; rows: number }[] = [];
    const tree = treeOn(watched(/^$/, read));
    const nodes = await tree.children(await find(tree, 'Lake', 'Snapshots'));

    expect(nodes).toHaveLength(50);
    expect(
      read.filter(({ sql }) => sql.includes('FROM ducklake_snapshot s')).map(({ rows }) => rows),
    ).toEqual([50]);
  });

  it('still shows the schemas when the number of snapshots cannot be read, and lists the snapshots', async () => {
    const tree = treeOn(watched(/snapshot_count/, []));
    const children = await tree.children(await find(tree, 'Lake'));
    const folder = children.find(({ label }) => label === 'Snapshots');

    expect(children.map(({ label }) => label)).toEqual(['main', 'shop', 'Snapshots']);
    expect(folder?.hasChildren).toBe(true);
    expect(await tree.children(folder as TreeNode)).toHaveLength(50);
  });

  it('shows the Snapshots folder of a catalog that reports no snapshot as one without children', async () => {
    const tree = new CatalogTree({
      profiles: () => [{ id: 'h', name: 'Lake', kind: 'sqlite', path: 'unused' }],
      open: async () => {
        const driver = await openSqlite({ path: historyFixture.sqlite, wasmPath });
        opened.push(driver);
        const reader = createCatalogReader(driver);
        return {
          reader: { ...reader, snapshotCount: () => Promise.resolve(0) },
          info: await reader.info(),
        };
      },
    });
    trees.push(tree);

    const folder = (await tree.children(await find(tree, 'Lake'))).find(({ label }) => label === 'Snapshots');

    expect(folder?.hasChildren).toBe(false);
  });

  it('puts the macros of a schema in the order of the other objects, not in that of the database', async () => {
    const tree = await treeOnCopy(
      historyFixture.sqlite,
      "UPDATE ducklake_macro SET macro_name = 'Zeta' WHERE macro_id = 16",
      "UPDATE ducklake_macro SET macro_name = 'alpha' WHERE macro_id = 17",
    );

    expect(await labelsBelow(tree, 'shop', 'Macros')).toEqual(['alpha', 'Zeta']);
  });

  it('offers the rows of a snapshot only for the changes of a table that did change rows, not for the maintenance of its files', async () => {
    // Snapshot 30 compacts, merges, rewrites and flushes events (3), then inserts into customers (9).
    const tree = await treeOnCopy(
      historyFixture.sqlite,
      `UPDATE ducklake_snapshot_changes
         SET changes_made = 'compacted_table:3,merge_adjacent:3,rewrite_delete:3,flushed_inlined:3,inserted_into_table:9'
       WHERE snapshot_id = 30`,
    );
    const leaves = await tree.children(await find(tree, 'Lake', 'Snapshots', '@30'));

    expect(leaves.map(({ label, contextValue }) => [label, contextValue])).toEqual([
      ['shop.events', 'detail'],
      ['shop.events', 'detail'],
      ['shop.events', 'detail'],
      ['shop.events', 'detail'],
      ['shop.customers', 'detail.table'],
    ]);
  });
});

describe('a catalog with few snapshots', () => {
  it('lists every snapshot of a catalog whose old snapshots expired', async () => {
    const tree = treeOn(() => openSqlite({ path: historyFixture.expired, wasmPath }));
    const nodes = await tree.children(await find(tree, 'Lake', 'Snapshots'));

    expect(nodes.map(({ label }) => label)).toEqual(['@56', '@55', '@0']);
  });

  it('shows a message node for a snapshot without recorded changes', async () => {
    const tree = await treeOnCopy(
      historyFixture.sqlite,
      'DELETE FROM ducklake_snapshot_changes WHERE snapshot_id = 30',
    );
    const [message] = await tree.children(await find(tree, 'Lake', 'Snapshots', '@30'));

    expect(message).toMatchObject({
      id: 'h/snapshots/n30/message',
      contextValue: 'message',
      ref: { kind: 'message' },
    });
  });
});

describe('a catalog of specification 1.0, which has none of the optional tables', () => {
  it('shows the folders that every catalog has, and the changes of a snapshot', async () => {
    const tree = treeOn(() => openSqlite({ path: FIXTURE_V1_0, wasmPath }));

    expect(await labelsBelow(tree)).toEqual(['main', 'sales', 'Snapshots']);
    expect(await labelsBelow(tree, 'sales')).toEqual(['Tables', 'Views', 'Macros']);
    expect(await labelsBelow(tree, 'sales', 'Tables', 'orders')).toEqual([
      'Statistics',
      'History',
      'Columns',
    ]);
    expect(await labelsBelow(tree, 'Snapshots', '@13')).toEqual(['main.plain']);
    expect((await find(tree, 'Lake', 'sales', 'Tables', 'orders')).tooltip).toContain('not included): 2');
  });
});

describe('tags that are not comments', () => {
  // Table 9 is shop.customers; column 3 is `tier`.
  const tagged = (): Promise<CatalogTree> =>
    treeOnCopy(
      historyFixture.sqlite,
      `INSERT INTO ducklake_tag VALUES
         (9, 40, NULL, 'owner', 'team-a'),
         (9, 40, 50, 'retired', 'gone again'),
         (9, 45, NULL, 'z"quote', 'two' || char(10) || 'lines')`,
      `INSERT INTO ducklake_column_tag VALUES (9, 3, 40, NULL, 'pii', 'false')`,
    );
  const CUSTOMERS = ['shop', 'Tables', 'customers'];

  it('lists the tags of the table first, then those of the columns with their path', async () => {
    const tree = await tagged();
    const folder = await find(tree, 'Lake', ...CUSTOMERS, 'Tags');
    const leaves = await tree.children(folder);

    expect(await labelsBelow(tree, ...CUSTOMERS)).toEqual(['Statistics', 'History', 'Columns', 'Tags']);
    expect(folder.id).toBe('h/s1/tables/t9/tags');
    expect(leaves.map(({ id, label, description }) => [id, label, description])).toEqual([
      ['h/s1/tables/t9/tags/k0', 'owner', 'team-a'],
      ['h/s1/tables/t9/tags/k1', 'z"quote', 'two\nlines'],
      ['h/s1/tables/t9/tags/k2', 'tier', 'pii: false'],
    ]);
  });

  it('shows the tags that are in force at the shown snapshot, and the folder only for a table that has tags', async () => {
    const tree = await tagged();
    const tags = async (snapshot: number) => {
      tree.selectSnapshot('h', snapshot);
      const folders = await labelsBelow(tree, ...CUSTOMERS);
      return folders.includes('Tags') ? (await labelsBelow(tree, ...CUSTOMERS, 'Tags')).join(',') : undefined;
    };

    expect(await tags(39)).toBeUndefined();
    expect(await tags(40)).toBe('owner,retired,tier');
    expect(await tags(49)).toBe('owner,retired,z"quote,tier');
    expect(await tags(50)).toBe('owner,z"quote,tier');
    expect(await labelsBelow(await tagged(), 'shop', 'Tables', 'events')).not.toContain('Tags');

    const onColumn = await treeOnCopy(
      historyFixture.sqlite,
      "INSERT INTO ducklake_column_tag VALUES (3, 1, 40, NULL, 'pii', 'false')",
    );
    const onTable = await treeOnCopy(
      historyFixture.sqlite,
      "INSERT INTO ducklake_tag VALUES (3, 40, NULL, 'owner', 'team-a')",
    );
    expect(await labelsBelow(onColumn, 'shop', 'Tables', 'events', 'Tags')).toEqual(['id']);
    expect(await labelsBelow(onTable, 'shop', 'Tables', 'events', 'Tags')).toEqual(['owner']);
  });
});

describe('text that the catalog stores, shown in the tree', () => {
  it('keeps the Markdown of author, commit message, column, macro and tag out of the tooltips', async () => {
    const tree = await treeOnCopy(
      historyFixture.sqlite,
      `UPDATE ducklake_snapshot_changes
         SET author = 'a' || char(96) || 'b', commit_message = '**bold** [x](http://evil) <b>' || char(10) || '# head'
       WHERE snapshot_id = 30`,
      `UPDATE ducklake_column SET column_name = 'ki' || char(96) || 'nd' WHERE table_id = 3 AND column_id = 2`,
      `UPDATE ducklake_macro_impl SET sql = 'SELECT ' || char(96) || char(96) || char(96) || ' x' WHERE macro_id = 16`,
      `UPDATE ducklake_macro SET macro_name = 'gr' || char(96) || 'oss ' || char(10) || '# x' WHERE macro_id = 16`,
      `INSERT INTO ducklake_tag VALUES (9, 40, NULL, '**k**' || char(96), '[v](http://evil)')`,
    );

    const snapshot = await find(tree, 'Lake', 'Snapshots', '@30');
    expect(snapshot.label).toBe('@30');
    expect(snapshot.tooltip).toContain('``a`b``');
    expect(snapshot.tooltip).toContain('\\*\\*bold\\*\\* \\[x\\]\\(http\\:\\/\\/evil\\) \\<b\\>  \n\\# head');
    expect(snapshot.tooltip).not.toContain('**bold**');
    expect(snapshot.tooltip).not.toContain('<b>');

    const [kind] = await tree.children(await find(tree, 'Lake', 'shop', 'Tables', 'events', 'Partitioning'));
    expect(kind?.label).toBe('ki`nd');
    expect(kind?.tooltip).toContain('``shop.events.ki`nd``');

    const macros = await tree.children(await find(tree, 'Lake', 'shop', 'Macros'));
    const macro = macros.find(({ id }) => id.endsWith('/m16'));
    expect(macro?.label).toBe('gr`oss \n# x');
    expect(macro?.tooltip?.split('\n\n')[0]).toContain('``shop.gr`oss # x``');
    expect(macro?.tooltip).toContain('````sql\nSELECT ``` x\n````');

    const [tag] = await tree.children(await find(tree, 'Lake', 'shop', 'Tables', 'customers', 'Tags'));
    expect(tag?.tooltip).toContain('`` **k**` ``');
    expect(tag?.tooltip).toContain('`[v](http://evil)`');
  });
});
