import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { openCatalog } from '../../src/catalog/open';
import {
  columns as columnsQuery,
  info as infoQuery,
  metadata as metadataQuery,
} from '../../src/catalog/queries/objects';
import { createCatalogReader } from '../../src/catalog/reader';
import type { ConnectionProfile, FileProfile, PostgresProfile } from '../../src/connections/profile';
import { AantjeError } from '../../src/errors';
import type { RelationColumn } from '../../src/data/types';
import type { Logger } from '../../src/log';
import { CatalogTree } from '../../src/tree/model';
import type { CatalogTreeDeps } from '../../src/tree/model';
import { connectionPresentation, schemaNode } from '../../src/tree/nodes';
import type { ConnectionState, TreeNode } from '../../src/tree/refs';
import { ID, LATEST_SNAPSHOT, SNAPSHOT, SPEC_VERSION } from '../support/expected';
import { fixturePath, wasmPath } from '../support/fixtures';
import { opened } from '../support/opened';

// The SQLite driver stays the real one; what reaches it is recorded, also when the real opener opens it.
const sqlite = vi.hoisted(() => ({ opened: 0, closed: 0, statements: [] as string[] }));

vi.mock('../../src/catalog/drivers/sqlite', async (importOriginal) => {
  const original = await importOriginal<{ openSqlite: typeof openSqlite }>();
  return {
    openSqlite: async (options: Parameters<typeof openSqlite>[0]) => {
      const driver = await original.openSqlite(options);
      sqlite.opened++;
      return {
        query: (...args: Parameters<typeof driver.query>) => {
          sqlite.statements.push(args[0]);
          return driver.query(...args);
        },
        close: () => {
          sqlite.closed++;
          return driver.close();
        },
      };
    },
  };
});

const fixtureProfile: FileProfile = {
  id: 'fixture',
  name: 'Fixture lake',
  kind: 'sqlite',
  path: fixturePath('ducklake.sqlite'),
};

const trees: CatalogTree[] = [];
/** Releases every gate that a test left closed, so that a failing assertion cannot hang the disposal. */
const releases: (() => void)[] = [];
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aantje-tree-'));
});
beforeEach(() => {
  Object.assign(sqlite, { opened: 0, closed: 0, statements: [] });
});
afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  await Promise.all(trees.splice(0).map((tree) => tree.dispose()));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A tree on the real reader and the real SQLite driver. The probe observes what the tree does to the catalogs
 * at the driver, and can make the catalogs misbehave like a network would.
 */
function createHarness(
  profiles: ConnectionProfile[] = [fixtureProfile],
  extra: Partial<CatalogTreeDeps> = {},
) {
  const probe = {
    profiles,
    opened: 0,
    closed: 0,
    /** Every query of every open catalog fails with it (a dropped connection). */
    broken: undefined as Error | undefined,
    /** `open` waits for it (a slow server). */
    gate: undefined as Promise<void> | undefined,
    /** `open` fails with it. */
    openFailure: undefined as Error | undefined,
    /** Closing a catalog fails with it, after the driver was closed (a dead socket). */
    closeFailure: undefined as Error | undefined,
    /** The catalog waits for it before it finishes closing (a slow socket). */
    closeGate: undefined as Promise<void> | undefined,
    errors: [] as string[],
    infos: [] as string[],
    /** The error argument of each logged error, in the order of `errors`. */
    causes: [] as unknown[],
  };
  const logger: Logger = {
    debug: () => undefined,
    info: (message) => {
      probe.infos.push(message);
    },
    warn: () => undefined,
    error: (message, error) => {
      probe.errors.push(message);
      probe.causes.push(error);
    },
  };
  const tree = new CatalogTree({
    profiles: () => probe.profiles,
    open: async (profile) => {
      probe.opened++;
      await probe.gate;
      if (probe.openFailure !== undefined) {
        throw probe.openFailure;
      }
      if (profile.kind === 'postgres' || profile.kind === 'quack') {
        throw new Error('These tests only use SQLite files.');
      }
      const driver = await openSqlite({ path: profile.path, wasmPath });
      return opened(
        createCatalogReader({
          query: (sql, params, options) =>
            probe.broken ? Promise.reject(probe.broken) : driver.query(sql, params, options),
          close: async () => {
            probe.closed++;
            await probe.closeGate;
            await driver.close();
            if (probe.closeFailure !== undefined) {
              throw probe.closeFailure;
            }
          },
        }),
      );
    },
    logger,
    ...extra,
  });
  trees.push(tree);
  return { tree, probe };
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { promise, release };
}

/** Makes the catalogs wait in `close()` until the returned function is called. */
function holdClose(probe: { closeGate: Promise<void> | undefined }): () => void {
  const held = gate();
  probe.closeGate = held.promise;
  return held.release;
}

/** Makes opening a catalog wait until the returned function is called. */
function holdOpen(probe: { gate: Promise<void> | undefined }): () => void {
  const held = gate();
  probe.gate = held.promise;
  return held.release;
}

/** Whether a promise is still pending after a short wait. */
async function stillPending(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol('pending');
  const outcome = await Promise.race([promise, new Promise((resolve) => setTimeout(resolve, 30, pending))]);
  return outcome === pending;
}

/** The bytes of a SQLite catalog: the fixture (or an empty database) with the statements applied. */
async function catalogBytes(base: 'fixture' | 'empty', ...statements: string[]): Promise<Uint8Array> {
  const wasm = readFileSync(wasmPath);
  const SQL = await initSqlJs({
    wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
  });
  const db = new SQL.Database(base === 'fixture' ? readFileSync(fixturePath('ducklake.sqlite')) : undefined);
  for (const statement of statements) {
    db.run(statement);
  }
  const bytes = db.export();
  db.close();
  return bytes;
}

async function catalogFile(name: string, bytes: Uint8Array | Promise<Uint8Array>): Promise<string> {
  const path = join(dir, name);
  writeFileSync(path, await bytes);
  return path;
}

/** A tree on the fixture with `statements` applied to the catalog. */
async function variant(name: string, ...statements: string[]) {
  const path = await catalogFile(name, catalogBytes('fixture', ...statements));
  return createHarness([{ ...fixtureProfile, path }]);
}

/** The row count that the tooltip of a table states: the tree shows no count as a description. */
const rowsOf = (node: TreeNode): string | undefined => /not included\): (\S+)/.exec(node.tooltip ?? '')?.[1];

const onlyRoot = (tree: CatalogTree): TreeNode => {
  const [root, ...others] = tree.roots();
  if (!root || others.length > 0) {
    throw new Error('Expected exactly one connection.');
  }
  return root;
};

/** The folders that tell more than the objects of the catalog; the outline of the objects leaves them out. */
const EXTRA_FOLDERS = new Set(['snapshots', 'statistics', 'history', 'partitioning', 'sortOrder', 'tags']);

/** Expands the whole tree, depth first. With `objects` only the objects of the catalog: no extra folder, no message. */
async function walk(tree: CatalogTree, objects = false): Promise<{ node: TreeNode; depth: number }[]> {
  const visited: { node: TreeNode; depth: number }[] = [];
  const visit = async (nodes: readonly TreeNode[], depth: number): Promise<void> => {
    for (const node of nodes) {
      if (
        objects &&
        (node.ref.kind === 'message' || (node.ref.kind === 'folder' && EXTRA_FOLDERS.has(node.ref.folder)))
      ) {
        continue;
      }
      visited.push({ node, depth });
      await visit(await tree.children(node), depth + 1);
    }
  };
  await visit(tree.roots(), 0);
  return visited;
}

/** The tree of the objects of the catalog: schemas, tables, views, columns. */
async function outline(tree: CatalogTree): Promise<string[]> {
  return (await walk(tree, true)).map(({ node, depth }) => `${'  '.repeat(depth)}${node.label}`);
}

/** The names of the schemas among the children of a connection. */
const schemaLabels = (nodes: readonly TreeNode[]): string[] =>
  nodes.filter((node) => node.ref.kind === 'schema').map((node) => node.label);

/** The labels of the children of the node at a path. */
async function labelsAt(tree: CatalogTree, ...path: string[]): Promise<string[]> {
  return (await tree.children(await find(tree, ...path))).map((node) => node.label);
}

/**
 * The node at a path of labels from the connection down, e.g. `find(tree, 'Fixture lake', 'sales')`. Expands
 * the nodes on the way, but not the node it returns.
 */
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

/** What the listeners are told, with the status of the connection at that moment. */
function recordEvents(tree: CatalogTree) {
  const events: { node: TreeNode | undefined; status: ConnectionState['status'] | undefined }[] = [];
  tree.onDidChange((node) => {
    events.push({ node, status: node && tree.state(node.ref.connectionId).status });
  });
  return events;
}

const indent = (lines: readonly string[], levels: number): string[] =>
  lines.map((line) => `${'  '.repeat(levels)}${line}`);

const ORDERS_COLUMNS = [
  'id',
  'customer',
  '  name',
  '  tags',
  '    element',
  'attrs',
  '  key',
  '  value',
  'amount',
  'created',
];
/** The table orders as the outline shows it: its name, the Columns folder, then the columns. */
const ORDERS = ['      orders', ...indent(['Columns', ...indent(ORDERS_COLUMNS, 1)], 4)];

const LAKE = 'Fixture lake';
const ORDERS_PATH = [LAKE, 'sales', 'Tables', 'orders'];
const BIG_ORDERS_PATH = [LAKE, 'sales', 'Views', 'big_orders'];

const advance = [
  "INSERT INTO ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (14, '2026-10-30 08:00:00.000000+00', 11, 8, 3)",
  `INSERT INTO ducklake_snapshot_changes (snapshot_id, changes_made) VALUES (14, 'created_schema:"late"')`,
  "INSERT INTO ducklake_schema (schema_id, schema_uuid, begin_snapshot, schema_name, path, path_is_relative) VALUES (6, 'late', 14, 'late', 'late/', 1)",
];
/** Snapshot 14 creates the table `sales.late` instead. */
const advanceTable = [
  "INSERT INTO ducklake_snapshot (snapshot_id, snapshot_time, schema_version, next_catalog_id, next_file_id) VALUES (14, '2026-10-30 08:00:00.000000+00', 11, 7, 3)",
  `INSERT INTO ducklake_snapshot_changes (snapshot_id, changes_made) VALUES (14, 'created_table:"sales"."late"')`,
  "INSERT INTO ducklake_table (table_id, table_uuid, begin_snapshot, schema_id, table_name, path, path_is_relative) VALUES (6, 'late', 14, 1, 'late', 'late/', 1)",
];

/** A catalog file that another process commits a snapshot to while the tree is connected. */
async function liveCatalog(name = 'live.sqlite', commits = advance) {
  const path = await catalogFile(name, readFileSync(fixturePath('ducklake.sqlite')));
  const harness = createHarness([{ ...fixtureProfile, path }]);
  await harness.tree.connect('fixture');
  expect(harness.tree.state('fixture').latestSnapshot).toBe(13);
  const commit = async () => {
    writeFileSync(path, await catalogBytes('fixture', ...commits));
  };
  return { ...harness, commit };
}

describe('the tree of the fixture catalog', () => {
  it('shows schemas, tables, views and nested columns, as they were at the selected snapshot', async () => {
    const { tree } = createHarness();
    expect(await outline(tree)).toEqual([
      LAKE,
      '  main',
      '    Tables',
      '      plain',
      '        Columns',
      '          x',
      '          y',
      '          z',
      '    Views',
      '    Macros',
      '  sales',
      '    Tables',
      ...ORDERS,
      '    Views',
      '      big_orders',
      '    Macros',
    ]);

    await tree.connect('fixture');
    tree.selectSnapshot('fixture', SNAPSHOT.createMainSchema);
    expect(await outline(tree)).toEqual([LAKE, '  main', '    Tables', '    Views', '    Macros']);

    tree.selectSnapshot('fixture', SNAPSHOT.insertTmp);
    expect(await outline(tree)).toEqual([
      LAKE,
      '  main',
      '    Tables',
      '    Views',
      '    Macros',
      '  sales',
      '    Tables',
      ...ORDERS,
      '      tmp',
      '        Columns',
      '          a',
      '    Views',
      '    Macros',
    ]);

    tree.selectSnapshot('fixture', SNAPSHOT.createPlain);
    expect((await outline(tree)).slice(0, 8)).toEqual([
      LAKE,
      '  main',
      '    Tables',
      '      plain',
      '        Columns',
      '          x',
      '          y',
      '    Views',
    ]);
  });

  it('shows tables before views and sorts each group by name with the English collation, whatever the machine', async () => {
    const rows = (table: string, columns: string, values: string[]) =>
      `INSERT INTO ${table} (${columns}) VALUES ${values.join(', ')}`;
    const { tree } = await variant(
      'unsorted.sqlite',
      rows('ducklake_schema', 'schema_id, schema_uuid, begin_snapshot, schema_name, path, path_is_relative', [
        "(6, 'u6', 0, 'Zulu', 'Zulu/', 1)",
      ]),
      rows(
        'ducklake_table',
        'table_id, table_uuid, begin_snapshot, schema_id, table_name, path, path_is_relative',
        [
          "(10, 't10', 0, 0, 'Zebra', 'Zebra/', 1)",
          "(11, 't11', 0, 0, 'apple', 'apple/', 1)",
          "(12, 't12', 0, 0, 'table10', 'table10/', 1)",
          "(13, 't13', 0, 0, 'table2', 'table2/', 1)",
        ],
      ),
      rows(
        'ducklake_view',
        'view_id, view_uuid, begin_snapshot, schema_id, view_name, dialect, sql, column_aliases',
        [
          "(14, 'v14', 0, 0, 'B_view', 'duckdb', 'SELECT 1', '')",
          "(15, 'v15', 0, 0, 'a_view', 'duckdb', 'SELECT 2', '')",
        ],
      ),
    );
    expect(schemaLabels(await tree.children(onlyRoot(tree)))).toEqual(['main', 'sales', 'Zulu']);
    expect(await labelsAt(tree, LAKE, 'main')).toEqual(['Tables', 'Views', 'Macros']);
    expect(await labelsAt(tree, LAKE, 'main', 'Tables')).toEqual([
      'apple',
      'plain',
      'table2',
      'table10',
      'Zebra',
    ]);
    expect(await labelsAt(tree, LAKE, 'main', 'Views')).toEqual(['a_view', 'B_view']);

    const table = (id: number, name: string) =>
      `INSERT INTO ducklake_table (table_id, table_uuid, begin_snapshot, schema_id, table_name, path, path_is_relative) VALUES (${id}, 't${id}', 0, 0, '${name}', 'x/', 1)`;
    const collated = await variant(
      'collation.sqlite',
      table(10, 'Zebra'),
      table(11, 'apple'),
      table(12, 'äpfel'),
      table(13, 'zulu'),
    );
    expect(await labelsAt(collated.tree, LAKE, 'main', 'Tables')).toEqual([
      'äpfel',
      'apple',
      'plain',
      'Zebra',
      'zulu',
    ]);
    // Names that differ only in case keep the binary order of the catalog.
    const tie = await variant('case-tie.sqlite', table(10, 'b'), table(11, 'B'), table(12, 'a'));
    expect(await labelsAt(tie.tree, LAKE, 'main', 'Tables')).toEqual(['a', 'B', 'b', 'plain']);
  });

  it('describes every kind of node for the menus, and gives the commands what they need in the payload', async () => {
    const { tree } = createHarness();
    const columns = [...ORDERS_PATH, 'Columns'];
    const kinds: [string[], string, string, boolean][] = [
      [[LAKE, 'sales'], 'schema', 'schema', true],
      [[LAKE, 'sales', 'Tables'], 'folder', 'folder.tables', true],
      [[LAKE, 'sales', 'Views'], 'folder', 'folder.views', true],
      [columns, 'folder', 'folder.columns', true],
      [[...ORDERS_PATH, 'Statistics'], 'folder', 'folder.statistics', false],
      [[...ORDERS_PATH, 'History'], 'folder', 'folder.history', false],
      [ORDERS_PATH, 'table', 'table', true],
      [BIG_ORDERS_PATH, 'view', 'view', false],
      [[...columns, 'id'], 'column', 'column', false],
      [[...columns, 'customer'], 'column', 'column', true],
    ];
    for (const [path, kind, contextValue, hasChildren] of kinds) {
      const node = await find(tree, ...path);
      expect([node.ref.kind, node.contextValue, node.hasChildren], path.join('/')).toEqual([
        kind,
        contextValue,
        hasChildren,
      ]);
    }

    const element = await find(tree, ...columns, 'customer', 'tags', 'element');
    expect(element.ref).toMatchObject({
      kind: 'column',
      connectionId: 'fixture',
      schema: { id: ID.salesSchema, name: 'sales' },
      table: { id: ID.orders, name: 'orders' },
      column: { id: 5, name: 'element', type: 'varchar' },
      path: ['customer', 'tags', 'element'],
      member: true,
    });
    // The element of a list has no name of its own, so the menu offers no CREATE and no DROP for it.
    expect(element.contextValue).toBe('column.member');
    const tags = await find(tree, ...columns, 'customer', 'tags');
    expect([tags.contextValue, 'member' in tags.ref]).toEqual(['column', false]);
    const view = await find(tree, ...BIG_ORDERS_PATH);
    expect(view.ref).toMatchObject({
      kind: 'view',
      schema: { name: 'sales' },
      view: { id: ID.bigOrdersView, sql: 'SELECT * FROM sales.orders WHERE (amount > 1)' },
    });
    expect(view.tooltip).toContain('SELECT * FROM sales.orders WHERE (amount > 1)');
    expect(await tree.children(view)).toEqual([]);

    const sales = await find(tree, LAKE, 'sales');
    const folders = await tree.children(sales);
    expect(folders.every((folder) => tree.parent(folder) === sales)).toBe(true);
    expect(folders[0]?.ref).toMatchObject({
      kind: 'folder',
      folder: 'tables',
      connectionId: 'fixture',
      schema: { id: ID.salesSchema, name: 'sales' },
      tables: [{ id: ID.orders, name: 'orders' }],
    });
    expect(folders[1]?.ref).toMatchObject({
      kind: 'folder',
      folder: 'views',
      views: [{ id: ID.bigOrdersView, name: 'big_orders' }],
    });
    expect(await tree.children(await find(tree, ...columns))).toHaveLength(5);

    // Statistics and History are leaves that run the commands of their report, in this order above the folders.
    const leaves = await tree.children(await find(tree, ...ORDERS_PATH));
    expect(leaves.map(({ ref }) => (ref.kind === 'folder' ? ref.folder : ref.kind))).toEqual([
      'statistics',
      'history',
      'columns',
    ]);
    expect(leaves[0]?.command?.id).toBe('aantje.showStatistics');
    expect(leaves[1]?.command?.id).toBe('aantje.showSchemaHistory');
    expect(leaves[0]?.ref).toMatchObject({ table: { id: ID.orders, name: 'orders' } });
    expect(leaves[1]?.ref).toMatchObject({ schema: { name: 'sales' }, table: { id: ID.orders } });
    const nodes = (await walk(tree)).map(({ node }) => node);
    expect(nodes.filter(({ command }) => command !== undefined).map(({ id }) => id)).toEqual([
      'fixture/s0/tables/t5/statistics',
      'fixture/s0/tables/t5/history',
      'fixture/s1/tables/t2/statistics',
      'fixture/s1/tables/t2/history',
    ]);
    expect(
      nodes
        .filter(({ ref }) => ['schema', 'folder', 'table', 'view'].includes(ref.kind))
        .every(({ description }) => description === undefined),
    ).toBe(true);
  });

  it('gives an empty schema message nodes, and shows a folder of 1200 tables in full', async () => {
    const { tree } = createHarness();
    await tree.connect('fixture');
    tree.selectSnapshot('fixture', SNAPSHOT.createSalesSchema);
    const folders = await tree.children(await find(tree, LAKE, 'main'));
    expect(folders.map((node) => [node.label, node.hasChildren])).toEqual([
      ['Tables', true],
      ['Views', true],
      ['Macros', true],
    ]);
    const [message] = await tree.children(folders[0] as TreeNode);
    expect(message).toMatchObject({
      id: 'fixture/s0/tables/message',
      contextValue: 'message',
      hasChildren: false,
      ref: { kind: 'message', connectionId: 'fixture' },
    });

    const tables = Array.from(
      { length: 1200 },
      (_, index) =>
        `INSERT INTO ducklake_table (table_id, table_uuid, begin_snapshot, schema_id, table_name, path, path_is_relative) VALUES (${100 + index}, 't${index}', 0, 6, 't${index}', 't/', 1)`,
    );
    const big = await variant(
      'many-tables.sqlite',
      "INSERT INTO ducklake_schema (schema_id, schema_uuid, begin_snapshot, schema_name, path, path_is_relative) VALUES (6, 'u6', 0, 'big', 'big/', 1)",
      ...tables,
    );
    const [bigTables] = await big.tree.children(await find(big.tree, LAKE, 'big'));
    expect(await big.tree.children(bigTables as TreeNode)).toHaveLength(1200);
  });

  it('reads the columns of a table once to expand it, and names partition keys and column tags by their path', async () => {
    // orders: partitioned by the struct field customer.name (column 3), the list element customer.tags (5) tagged.
    const { tree } = await variant(
      'partitioned-tagged.sqlite',
      'INSERT INTO ducklake_partition_info VALUES (90, 2, 2, NULL)',
      "INSERT INTO ducklake_partition_column VALUES (90, 2, 0, 3, 'identity')",
      "INSERT INTO ducklake_column_tag VALUES (2, 5, 2, NULL, 'pii', 'true')",
    );
    const table = await find(tree, ...ORDERS_PATH);
    const start = sqlite.statements.length;

    const refs = (await tree.children(table)).map(({ ref }) => ref);

    const columnReads = sqlite.statements
      .slice(start)
      .filter((sql) => sql === columnsQuery(ID.orders, LATEST_SNAPSHOT).sql);
    expect(columnReads).toHaveLength(1);
    const folder = <F extends string>(name: F) =>
      refs.find((ref) => ref.kind === 'folder' && ref.folder === name) as
        Extract<TreeNode['ref'], { kind: 'folder'; folder: F }> | undefined;
    expect(folder('columns')?.columns.map(({ name }) => name)).toEqual([
      'id',
      'customer',
      'attrs',
      'amount',
      'created',
    ]);
    expect(folder('partitioning')?.partitioning.columns.map(({ path }) => path)).toEqual([
      ['customer', 'name'],
    ]);
    expect(folder('tags')?.tags.columns.map(({ path }) => path)).toEqual([['customer', 'tags', 'element']]);
  });
});

describe('connecting', () => {
  it('opens nothing until a connection is expanded, then opens the catalog once, whoever asks', async () => {
    const { tree, probe } = createHarness();
    const lake = onlyRoot(tree);
    expect(lake).toMatchObject({
      contextValue: 'connection.disconnected',
      hasChildren: true,
      ref: { kind: 'connection', connectionId: 'fixture' },
    });
    expect(tree.state('fixture')).toEqual({ status: 'disconnected', snapshot: 'latest' });
    expect(tree.reader('fixture')).toBeUndefined();
    expect(probe.opened).toBe(0);

    const open = holdOpen(probe);
    const connecting = tree.connect('fixture');
    expect(tree.state('fixture').status).toBe('connecting');
    expect(lake.contextValue).toBe('connection.disconnected');
    const joined = tree.connect('fixture');
    const expanded = tree.children(lake);
    open();
    const [, , first] = await Promise.all([connecting, joined, expanded]);

    expect(probe.opened).toBe(1);
    expect(tree.state('fixture')).toEqual({
      status: 'connected',
      specVersion: SPEC_VERSION,
      latestSnapshot: LATEST_SNAPSHOT,
      snapshot: 'latest',
    });
    expect(lake.contextValue).toBe('connection.connected');
    expect(await tree.children(lake)).toBe(first);
    await tree.connect('fixture');
    expect(probe.opened).toBe(1);
    const snapshots = await tree.reader('fixture')?.snapshots();
    expect(snapshots?.map(({ id }) => id)).toEqual(
      Array.from({ length: LATEST_SNAPSHOT + 1 }, (_, index) => LATEST_SNAPSHOT - index),
    );
  });

  it('shows a failure as the only child, keeps the technical error and secrets out of it, and connects again once fixed', async () => {
    const path = join(dir, 'later.sqlite');
    const { tree, probe } = createHarness([{ ...fixtureProfile, path }]);
    const lake = onlyRoot(tree);
    const [message, ...others] = await tree.children(lake);
    expect(others).toEqual([]);
    expect(message).toMatchObject({
      contextValue: 'message',
      hasChildren: false,
      ref: { kind: 'message', connectionId: 'fixture' },
    });
    expect(message?.label).toContain('later.sqlite');
    expect(message && tree.parent(message)).toBe(lake);
    expect(tree.state('fixture')).toEqual({ status: 'error', snapshot: 'latest', error: message?.label });
    expect(lake.contextValue).toBe('connection.error');
    expect(probe.errors).toHaveLength(1);
    expect(probe.causes).toEqual([expect.objectContaining({ code: 'FILE_NOT_FOUND' })]);

    writeFileSync(path, readFileSync(fixturePath('ducklake.sqlite')));
    await tree.connect('fixture');
    expect(tree.state('fixture').status).toBe('connected');
    expect(lake.contextValue).toBe('connection.connected');
    expect(schemaLabels(await tree.children(lake))).toEqual(['main', 'sales']);
    expect(probe.opened).toBe(2);

    const unexpected = createHarness();
    unexpected.probe.openFailure = new Error('connect failed for postgres://etl:hunter2@db.example.org/lake');
    const unexpectedLake = onlyRoot(unexpected.tree);
    const [generic] = await unexpected.tree.children(unexpectedLake);
    expect(JSON.stringify([generic, unexpectedLake, unexpected.tree.state('fixture')])).not.toContain(
      'hunter2',
    );
    expect(unexpected.probe.errors).toHaveLength(1);
    expect(unexpected.probe.causes[0]).toBe(unexpected.probe.openFailure);
  });

  it('reports a database that is not a DuckLake catalog and does not leave it open', async () => {
    const path = await catalogFile(
      'other.sqlite',
      catalogBytes('empty', 'CREATE TABLE customers (id INTEGER, name TEXT)'),
    );
    // The real opener: its check refuses the database and closes it before the tree hears of the failure.
    const { tree } = createHarness([{ ...fixtureProfile, path }], {
      open: (profile) => openCatalog(profile, { wasmPath }),
    });
    const [message] = await tree.children(onlyRoot(tree));
    expect(message?.ref.kind).toBe('message');
    expect(tree.state('fixture').status).toBe('error');
    expect(tree.reader('fixture')).toBeUndefined();
    expect({ opened: sqlite.opened, closed: sqlite.closed }).toEqual({ opened: 1, closed: 1 });
  });

  it('names the command that finishes an Azure DuckLake without DuckLake tables, and only for that', async () => {
    const plain: PostgresProfile = {
      id: 'plain',
      name: 'plain',
      kind: 'postgres',
      host: 'srv.postgres.database.azure.com',
      port: 5432,
      database: 'postgres',
      user: 'ducklakeadmin',
      ssl: true,
    };
    const azure: PostgresProfile = { ...plain, id: 'azure', name: 'azure', azureAccount: 'acct' };
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      contributes: { commands: { command: string; title: string }[] };
    };
    const finish = manifest.contributes.commands.find(({ command }) => command === 'aantje.finishAzureLake');
    const { tree, probe } = createHarness([azure, plain]);
    const hints = () => probe.infos.filter((line) => finish !== undefined && line.includes(finish.title));

    probe.openFailure = new AantjeError('NOT_A_DUCKLAKE', 'The tables are missing.');
    await tree.connect('azure');
    await tree.connect('plain');
    expect(hints()).toHaveLength(1);
    expect(hints()[0]).toContain('"azure"');

    probe.openFailure = new AantjeError('CONNECTION_FAILED', 'The server is gone.');
    await tree.connect('azure');
    expect(probe.errors).toHaveLength(3);
    expect(hints()).toHaveLength(1);
  });

  it('opens again with the edited profile when a refresh arrives while the connection is still opening', async () => {
    const { tree, probe } = createHarness();
    const release = holdOpen(probe);
    const first = tree.connect('fixture');
    await vi.waitFor(() => expect(probe.opened).toBe(1));

    probe.profiles = [{ ...fixtureProfile, name: 'Renamed lake' }];
    tree.refresh();
    release();
    await first;

    await vi.waitFor(() => expect(probe.opened).toBe(2));
    await vi.waitFor(() => expect(tree.state('fixture').status).toBe('connected'));
    expect(onlyRoot(tree).label).toContain('Renamed lake');
    // The first catalog is closed once the second one is open; nothing is left behind.
    await vi.waitFor(() => expect(probe.closed).toBe(1));

    // Disconnect while such a second attempt runs waits for it, and the connection stays closed.
    const again = holdOpen(probe);
    tree.refresh();
    await vi.waitFor(() => expect(probe.opened).toBe(3));
    const disconnected = tree.disconnect('fixture');
    again();
    await disconnected;
    expect(tree.state('fixture').status).toBe('disconnected');
  });

  it('asks the catalog for its info once per connect and refresh: the check of the real opener', async () => {
    const { tree } = createHarness([fixtureProfile], {
      open: (profile) => openCatalog(profile, { wasmPath }),
    });
    const infoQueries = (): number => sqlite.statements.filter((sql) => sql === infoQuery().sql).length;

    await tree.connect('fixture');
    expect(infoQueries()).toBe(1);
    expect(tree.state('fixture')).toEqual({
      status: 'connected',
      specVersion: SPEC_VERSION,
      latestSnapshot: LATEST_SNAPSHOT,
      snapshot: 'latest',
    });

    tree.refresh();
    await tree.connect('fixture');
    expect(infoQueries()).toBe(2);
    expect({ opened: sqlite.opened, closed: sqlite.closed }).toEqual({ opened: 2, closed: 1 });

    // Listing the schemas and counting the snapshots asks neither again, nor for the metadata.
    expect(schemaLabels(await tree.children(onlyRoot(tree)))).toEqual(['main', 'sales']);
    expect([infoQueries(), sqlite.statements.filter((sql) => sql === metadataQuery().sql).length]).toEqual([
      2, 0,
    ]);
  });

  it('ignores a connection id that is not configured, and finds one whose id needs URI encoding in the node id', async () => {
    const { tree, probe } = createHarness();
    const events = recordEvents(tree);
    await expect(tree.connect('unknown')).resolves.toBeUndefined();
    expect(() => {
      tree.selectSnapshot('unknown', 5);
    }).not.toThrow();
    expect(events).toEqual([]);
    expect(probe.opened).toBe(0);

    const profile: ConnectionProfile = { ...fixtureProfile, id: 'my catalog/prod', name: 'Prod' };
    const encoded = createHarness([profile]);
    await encoded.tree.connect('my catalog/prod');
    encoded.tree.selectSnapshot('my catalog/prod', SNAPSHOT.insertTmp);
    expect(encoded.tree.state('my catalog/prod')).toMatchObject({ status: 'connected', snapshot: 5 });
    expect(encoded.tree.reader('my catalog/prod')).toBeDefined();
    expect(onlyRoot(encoded.tree).id).toBe('my%20catalog%2Fprod');
    await encoded.tree.disconnect('my catalog/prod');
    expect(encoded.tree.state('my catalog/prod').status).toBe('disconnected');
  });
});

describe('reading below a connection', () => {
  it('turns a failure of the catalog into a message and logs it, keeps what was read, and shows the data after a refresh', async () => {
    const { tree, probe } = createHarness();
    const plain = await find(tree, LAKE, 'main', 'Tables', 'plain');
    const plainColumns = await tree.children(plain);
    const orders = await find(tree, ...ORDERS_PATH);
    probe.broken = new AantjeError('CONNECTION_FAILED', 'The connection to the database was lost.');

    const first = await tree.children(orders);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ contextValue: 'message', hasChildren: false, ref: { kind: 'message' } });
    expect(probe.errors).toHaveLength(1);
    expect(probe.causes[0]).toBe(probe.broken);
    expect(tree.state('fixture').status).toBe('connected');
    // What was read before the connection broke stays available, and a failing catalog is not asked again.
    expect(await tree.children(plain)).toBe(plainColumns);
    expect(await tree.children(orders)).toBe(first);
    expect(probe.errors).toHaveLength(1);

    probe.broken = undefined;
    tree.refresh(plain);
    expect(await outline(tree)).toContain('          z');

    // An unexpected error keeps its technical message out of the node.
    const unexpected = createHarness();
    const ordersNode = await find(unexpected.tree, ...ORDERS_PATH);
    unexpected.probe.broken = new Error('select failed: postgres://etl:hunter2@db.example.org/lake');
    const [generic] = await unexpected.tree.children(ordersNode);
    expect(JSON.stringify(generic)).not.toContain('hunter2');
    expect(unexpected.probe.errors).toHaveLength(1);
    expect(unexpected.probe.causes).toEqual([unexpected.probe.broken]);
  });
});

describe('selecting a snapshot', () => {
  it('shows the rows of the selected snapshot, also when it was selected before the first expansion, and goes back to the latest', async () => {
    const { tree } = createHarness();
    tree.selectSnapshot('fixture', SNAPSHOT.insertTmp);
    expect(rowsOf(await find(tree, ...ORDERS_PATH))).toBe('3');
    expect(tree.state('fixture')).toMatchObject({ status: 'connected', snapshot: 5, latestSnapshot: 13 });

    tree.selectSnapshot('fixture', 'latest');
    expect(tree.state('fixture').snapshot).toBe('latest');
    expect(rowsOf(await find(tree, ...ORDERS_PATH))).toBe('2');
    expect((await outline(tree)).join('\n')).toContain('big_orders');

    // The first snapshot can be pinned too.
    tree.selectSnapshot('fixture', 0);
    expect(tree.state('fixture')).toMatchObject({ snapshot: 0, latestSnapshot: 13 });

    tree.selectSnapshot('fixture', SNAPSHOT.insertTmp);
    await tree.disconnect('fixture');
    expect(tree.state('fixture').snapshot).toBe('latest');
    await tree.connect('fixture');
    expect(rowsOf(await find(tree, ...ORDERS_PATH))).toBe('2');
  });
});

describe('refreshing', () => {
  it('shows a new commit only after a refresh, keeps a pinned snapshot, and refreshes the whole connection from any node', async () => {
    const live = await liveCatalog();
    const lake = onlyRoot(live.tree);
    await live.commit();
    const before = await live.tree.children(lake);
    expect(schemaLabels(before)).toEqual(['main', 'sales']);
    expect(await live.tree.children(lake)).toBe(before);

    live.tree.refresh();
    const after = await live.tree.children(lake);
    expect(after).not.toBe(before);
    expect(schemaLabels(after)).toEqual(['late', 'main', 'sales']);
    expect(live.tree.state('fixture')).toMatchObject({
      status: 'connected',
      latestSnapshot: 14,
      snapshot: 'latest',
    });
    // The old connection is closed once the new one is in place.
    expect({ opened: live.probe.opened, closed: live.probe.closed }).toEqual({ opened: 2, closed: 1 });

    const pinned = await liveCatalog('pinned.sqlite');
    pinned.tree.selectSnapshot('fixture', SNAPSHOT.insertTmp);
    await pinned.commit();
    pinned.tree.refresh();
    expect(schemaLabels(await pinned.tree.children(onlyRoot(pinned.tree)))).toEqual(['main', 'sales']);
    expect(pinned.tree.state('fixture')).toMatchObject({ snapshot: 5, latestSnapshot: 14 });

    const below = await liveCatalog('below.sqlite');
    const orders = await find(below.tree, ...ORDERS_PATH);
    await below.commit();
    below.tree.refresh(orders);
    expect(schemaLabels(await below.tree.children(onlyRoot(below.tree)))).toEqual(['late', 'main', 'sales']);
  });

  it('lists a table that another process committed once its folder Tables is refreshed, and the folder keeps its id', async () => {
    const live = await liveCatalog('folder.sqlite', advanceTable);
    const tables = await find(live.tree, LAKE, 'sales', 'Tables');
    expect(await labelsAt(live.tree, LAKE, 'sales', 'Tables')).toEqual(['orders']);

    await live.commit();
    live.tree.refresh(tables);
    expect(await labelsAt(live.tree, LAKE, 'sales', 'Tables')).toEqual(['late', 'orders']);
    // VS Code keeps a node expanded by its id.
    expect((await find(live.tree, LAKE, 'sales', 'Tables')).id).toBe(tables.id);
    expect(live.tree.state('fixture').latestSnapshot).toBe(14);
  });

  it('opens nothing for a connection that was never expanded, and answers nothing that a stale node asks while reopening', async () => {
    const idle = createHarness();
    const events = recordEvents(idle.tree);
    idle.tree.refresh();
    idle.tree.refresh(onlyRoot(idle.tree));
    expect(events[0]).toEqual({ node: undefined, status: undefined });
    expect(idle.probe.opened).toBe(0);
    expect(idle.tree.state('fixture').status).toBe('disconnected');

    const { tree, probe } = createHarness();
    const staleSales = await find(tree, LAKE, 'sales');
    const open = holdOpen(probe);
    tree.refresh();
    expect(tree.state('fixture').status).toBe('connecting');
    expect(await tree.children(staleSales)).toEqual([]);
    open();
    await tree.connect('fixture');
    expect(await labelsAt(tree, LAKE, 'sales')).toHaveLength(3);

    // A read that finishes after a snapshot was selected is not linked into the tree.
    const late = createHarness();
    await late.tree.connect('fixture');
    const reading = late.tree.children(onlyRoot(late.tree));
    late.tree.selectSnapshot('fixture', SNAPSHOT.insertTmp);
    const sales = (await reading)[1];
    expect(sales?.label).toBe('sales');
    expect(sales && late.tree.parent(sales)).toBeUndefined();
  });

  it('does not read a node of the earlier snapshot or cache into the new one when VS Code asks for it before it reads the parents again', async () => {
    const { tree } = createHarness();
    const plain = [LAKE, 'main', 'Tables', 'plain'];
    const staleColumns = await find(tree, ...plain, 'Columns');
    const staleCustomer = await find(tree, ...ORDERS_PATH, 'Columns', 'customer');
    expect(await labelsAt(tree, ...plain, 'Columns')).toEqual(['x', 'y', 'z']);

    tree.selectSnapshot('fixture', SNAPSHOT.createPlain);

    expect(await tree.children(staleColumns)).toEqual([]);
    expect(await tree.children(staleCustomer)).toEqual([]);
    expect(await labelsAt(tree, ...plain, 'Columns')).toEqual(['x', 'y']);
    expect(await labelsAt(tree, ...ORDERS_PATH, 'Columns', 'customer')).toEqual(['name', 'tags']);

    const live = await liveCatalog('stale.sqlite');
    const stale = await find(live.tree, LAKE, 'main', 'Tables', 'plain', 'Columns');
    await live.commit();
    live.tree.refresh();
    expect(await live.tree.children(stale)).toEqual([]);
    expect(await labelsAt(live.tree, LAKE, 'main', 'Tables', 'plain', 'Columns')).toEqual(['x', 'y', 'z']);
  });

  it('ends in the error status when the catalog cannot be reopened, closes the old one, and connects again once the server is back', async () => {
    const { tree, probe } = createHarness();
    await tree.connect('fixture');
    const lake = onlyRoot(tree);
    probe.openFailure = new AantjeError('CONNECTION_FAILED', 'The server is gone.');

    tree.refresh();
    await tree.connect('fixture');

    expect(tree.state('fixture')).toMatchObject({ status: 'error', snapshot: 'latest' });
    expect(lake.contextValue).toBe('connection.error');
    expect(await tree.children(lake)).toHaveLength(1);
    expect(tree.reader('fixture')).toBeUndefined();
    expect({ opened: probe.opened, closed: probe.closed }).toEqual({ opened: 2, closed: 1 });

    probe.openFailure = undefined;
    await tree.connect('fixture');
    expect(tree.state('fixture').status).toBe('connected');
    expect(schemaLabels(await tree.children(lake))).toEqual(['main', 'sales']);
  });
});

describe('disconnecting', () => {
  it('closes the catalog, forgets the tree, stays closed until connect() is called, and shows the current catalog after it', async () => {
    const { tree, probe, commit } = await liveCatalog('disconnect.sqlite');
    const lake = onlyRoot(tree);
    const staleSales = await find(tree, LAKE, 'sales');
    await commit();

    await tree.disconnect('fixture');

    expect(probe.closed).toBe(1);
    expect(tree.state('fixture')).toEqual({ status: 'disconnected', snapshot: 'latest' });
    expect(tree.reader('fixture')).toBeUndefined();
    expect(tree.roots()).toEqual([lake]);
    expect(lake.contextValue).toBe('connection.disconnected');
    // After the change event VS Code asks for the children of nodes that are still expanded.
    expect(lake.hasChildren).toBe(false);
    expect(await tree.children(lake)).toEqual([]);
    expect(await tree.children(staleSales)).toEqual([]);
    tree.refresh();
    expect(await tree.children(lake)).toEqual([]);
    expect(probe.opened).toBe(1);

    await tree.connect('fixture');
    expect(lake.hasChildren).toBe(true);
    expect(schemaLabels(await tree.children(lake))).toEqual(['late', 'main', 'sales']);
    expect(probe.opened).toBe(2);
    expect(await labelsAt(tree, LAKE, 'sales')).toHaveLength(3);
  });

  it('does not fail for a connection that was never connected, and waits for an attempt that is running so that no catalog stays open', async () => {
    const idle = createHarness();
    await idle.tree.disconnect('fixture');
    await idle.tree.disconnect('unknown');
    expect(idle.probe.closed).toBe(0);

    const { tree, probe } = createHarness();
    const open = holdOpen(probe);
    const connecting = tree.connect('fixture');
    const disconnecting = tree.disconnect('fixture');
    open();
    await Promise.all([connecting, disconnecting]);

    expect(tree.state('fixture').status).toBe('disconnected');
    expect({ opened: probe.opened, closed: probe.closed }).toEqual({ opened: 1, closed: 1 });
  });
});

describe('the list of connections', () => {
  const other: ConnectionProfile = { ...fixtureProfile, id: 'other', name: 'Other lake' };

  it('drops a connection whose profile is gone, closes its catalog and leaves the others alone', async () => {
    const { tree, probe } = createHarness([fixtureProfile, other]);
    const [removed, kept] = tree.roots();
    await Promise.all([tree.connect('fixture'), tree.connect('other')]);
    const sales = await find(tree, LAKE, 'sales');
    expect(tree.parent(sales)).toBeDefined();
    expect(probe.opened).toBe(2);

    probe.profiles = [other];
    expect(tree.roots()).toEqual([kept]);

    await expect.poll(() => probe.closed).toBe(1);
    expect(tree.state('fixture')).toEqual({ status: 'disconnected', snapshot: 'latest' });
    expect(tree.reader('fixture')).toBeUndefined();
    expect(removed && (await tree.children(removed))).toEqual([]);
    expect(tree.parent(sales)).toBeUndefined();
    expect(tree.state('other').status).toBe('connected');
    expect(probe.closed).toBe(1);
  });

  it('closes a removed profile when the view is told or a node of it is refreshed, and forgets what it had failed with', async () => {
    const told = createHarness([fixtureProfile, other]);
    await Promise.all([told.tree.connect('fixture'), told.tree.connect('other')]);
    told.probe.profiles = [other];
    told.tree.profilesChanged();
    await expect.poll(() => told.probe.closed).toBe(1);
    expect(told.tree.state('fixture')).toEqual({ status: 'disconnected', snapshot: 'latest' });
    expect(told.tree.state('other').status).toBe('connected');

    const refreshed = createHarness([fixtureProfile, other]);
    await Promise.all([refreshed.tree.connect('fixture'), refreshed.tree.connect('other')]);
    const [stale] = refreshed.tree.roots();
    const events = recordEvents(refreshed.tree);
    refreshed.probe.profiles = [other];
    refreshed.tree.refresh(stale);
    await expect.poll(() => refreshed.probe.closed).toBe(1);
    expect(refreshed.probe.opened).toBe(2);
    expect(events).toEqual([{ node: undefined, status: undefined }]);

    const missing: ConnectionProfile = { ...fixtureProfile, path: join(dir, 'missing.sqlite') };
    const failed = createHarness([missing]);
    failed.tree.selectSnapshot('fixture', 5);
    await failed.tree.connect('fixture');
    expect(failed.tree.state('fixture').status).toBe('error');
    failed.probe.profiles = [];
    expect(failed.tree.roots()).toEqual([]);
    expect(failed.tree.state('fixture')).toEqual({ status: 'disconnected', snapshot: 'latest' });
    failed.probe.profiles = [missing];
    expect(onlyRoot(failed.tree).contextValue).toBe('connection.disconnected');
  });

  it('keeps the connections apart, and adds profiles without reopening any', async () => {
    const apart = createHarness([fixtureProfile, other]);
    apart.tree.selectSnapshot('fixture', SNAPSHOT.insertTmp);
    const rows = async (connection: string) =>
      rowsOf(await find(apart.tree, connection, 'sales', 'Tables', 'orders'));
    expect(await rows(LAKE)).toBe('3');
    expect(await rows('Other lake')).toBe('2');
    expect(apart.tree.state('other').snapshot).toBe('latest');

    const { tree, probe } = createHarness([fixtureProfile, other]);
    await Promise.all([tree.connect('fixture'), tree.connect('other')]);
    const second = tree.roots().find((node) => node.label === 'Other lake');
    if (!second) {
      throw new Error('Expected the second connection.');
    }
    tree.refresh(second);
    await tree.children(second);
    expect({ opened: probe.opened, closed: probe.closed }).toEqual({ opened: 3, closed: 1 });
    await tree.disconnect('other');
    expect(tree.state('fixture').status).toBe('connected');
    expect(tree.state('other').status).toBe('disconnected');

    const all = createHarness([fixtureProfile, other]);
    await Promise.all([all.tree.connect('fixture'), all.tree.connect('other')]);
    all.tree.refresh();
    await Promise.all([all.tree.connect('fixture'), all.tree.connect('other')]);
    expect({ opened: all.probe.opened, closed: all.probe.closed }).toEqual({ opened: 4, closed: 2 });

    const added = createHarness();
    const [lake] = added.tree.roots();
    added.probe.profiles = [
      other,
      { ...fixtureProfile, name: 'Renamed' },
      { ...other, id: 'third', name: 'Third' },
    ];
    const roots = added.tree.roots();
    expect(roots.map((node) => node.label)).toEqual(['Other lake', 'Renamed', 'Third']);
    expect(roots[1]).toBe(lake);
    expect(added.probe.opened).toBe(0);
  });
});

describe('change events', () => {
  it('tells about the connection that changed, and about the whole tree after a refresh', async () => {
    const { tree } = createHarness();
    const lake = onlyRoot(tree);
    const events = recordEvents(tree);

    await tree.children(lake);
    expect(events.map(({ status }) => status)).toEqual(['connecting', 'connected']);
    expect(events.every(({ node }) => node === lake)).toBe(true);

    events.length = 0;
    tree.selectSnapshot('fixture', 5);
    await tree.disconnect('fixture');
    expect(events).toEqual([
      { node: lake, status: 'connected' },
      { node: lake, status: 'disconnected' },
    ]);

    await tree.connect('fixture');
    events.length = 0;
    tree.refresh();
    await tree.children(lake);
    expect(events).toEqual([
      { node: lake, status: 'connecting' },
      { node: undefined, status: undefined },
      { node: lake, status: 'connected' },
    ]);

    // The connection of a refreshed node is told about, and one that failed.
    const orders = await find(tree, ...ORDERS_PATH);
    events.length = 0;
    tree.refresh(orders);
    await tree.children(lake);
    expect(events.map(({ node }) => node)).toEqual([lake, lake, lake]);
    expect(events.map(({ status }) => status)).toEqual(['connecting', 'connecting', 'connected']);

    const failing = createHarness([{ ...fixtureProfile, path: join(dir, 'nothing.sqlite') }]);
    const failures = recordEvents(failing.tree);
    await failing.tree.connect('fixture');
    expect(failures.map(({ status }) => status)).toEqual(['connecting', 'error']);
  });

  it('lets a listener read the tree while it is told: it joins the attempt, reads the new snapshot, never the old cache', async () => {
    const first = createHarness();
    const lake = onlyRoot(first.tree);
    const inner: Promise<TreeNode[]>[] = [];
    first.tree.onDidChange(() => {
      inner.push(first.tree.children(lake));
    });
    const outer = await first.tree.children(lake);
    expect(first.probe.opened).toBe(1);
    expect((await inner[0])?.map((node) => node.label)).toEqual(outer.map((node) => node.label));

    const second = createHarness();
    const secondLake = onlyRoot(second.tree);
    await second.tree.children(secondLake);
    let seen: Promise<TreeNode[]> | undefined;
    second.tree.onDidChange(() => {
      seen = second.tree.children(secondLake);
    });
    second.tree.selectSnapshot('fixture', SNAPSHOT.createMainSchema);
    expect(schemaLabels((await seen) ?? [])).toEqual(['main']);

    const third = createHarness();
    const thirdLake = onlyRoot(third.tree);
    const before = await third.tree.children(thirdLake);
    let fresh: Promise<TreeNode[]> | undefined;
    third.tree.onDidChange(() => {
      fresh ??= third.tree.children(thirdLake);
    });
    third.tree.refresh();
    expect(await fresh).not.toBe(before);
    expect(schemaLabels((await fresh) ?? [])).toEqual(['main', 'sales']);
  });

  it('keeps working when a listener throws, and stops telling a listener that was disposed', async () => {
    const { tree, probe } = createHarness();
    const bug = new Error('listener bug');
    tree.onDidChange(() => {
      throw bug;
    });
    const told: (TreeNode | undefined)[] = [];
    const subscription = tree.onDidChange((node) => told.push(node));

    await tree.connect('fixture');
    expect(tree.state('fixture').status).toBe('connected');
    expect(told).toHaveLength(2);
    expect(probe.errors).toHaveLength(2);
    expect(probe.causes).toEqual([bug, bug]);

    subscription.dispose();
    tree.selectSnapshot('fixture', 5);
    expect(told).toHaveLength(2);
  });
});

describe('node ids and parents', () => {
  it('are unique in the whole tree, also with connections whose ids look like node ids, and follow the documented format', async () => {
    const single = createHarness();
    const perConnection = (await walk(single.tree, true)).length;
    const lookalike: ConnectionProfile = { ...fixtureProfile, id: 'fixture/s1', name: 'Lookalike' };
    const { tree } = createHarness([fixtureProfile, lookalike]);
    expect((await walk(tree, true)).length).toBe(2 * perConnection);
    const nodes = (await walk(tree)).map(({ node }) => node);
    expect(nodes.length).toBeGreaterThan(2 * perConnection);
    expect(new Set(nodes.map(({ id }) => id)).size).toBe(nodes.length);

    const idOf = async (...labels: string[]) => (await find(single.tree, ...labels)).id;
    expect(await idOf(LAKE)).toBe('fixture');
    expect(await idOf(LAKE, 'sales')).toBe('fixture/s1');
    expect(await idOf(LAKE, 'sales', 'Tables')).toBe('fixture/s1/tables');
    expect(await idOf(...ORDERS_PATH)).toBe('fixture/s1/tables/t2');
    expect(await idOf(...ORDERS_PATH, 'Columns', 'customer')).toBe('fixture/s1/tables/t2/columns/c2');
    expect(await idOf(...ORDERS_PATH, 'Columns', 'customer', 'tags', 'element')).toBe(
      'fixture/s1/tables/t2/columns/c2/c4/c5',
    );
    expect(await idOf(...BIG_ORDERS_PATH)).toBe('fixture/s1/views/v4');

    // The ids stay the same after a refresh and when another snapshot is shown, so that VS Code keeps the expansion.
    const ids = async () => (await walk(single.tree)).map(({ node }) => node.id);
    const before = await ids();
    single.tree.refresh();
    expect(await ids()).toEqual(before);
    single.tree.selectSnapshot('fixture', SNAPSHOT.insertTmp);
    const orders = await find(single.tree, ...ORDERS_PATH);
    expect(before).toContain(orders.id);
    expect(orders.id).toBe(`fixture/s${ID.salesSchema}/tables/t${ID.orders}`);
  });

  it('give every node the node it was read from as its parent, the message of a failure too, and the connection none', async () => {
    const { tree } = createHarness();
    const lake = onlyRoot(tree);
    const expected = new Map<string, TreeNode | undefined>([[lake.id, undefined]]);
    const record = async (node: TreeNode): Promise<void> => {
      for (const child of await tree.children(node)) {
        expected.set(child.id, node);
        await record(child);
      }
    };
    await record(lake);

    for (const { node } of await walk(tree)) {
      expect(tree.parent(node)).toBe(expected.get(node.id));
    }
    expect(
      tree.parent(await find(tree, ...ORDERS_PATH, 'Columns', 'customer', 'tags', 'element'))?.label,
    ).toBe('tags');

    const failing = createHarness([{ ...fixtureProfile, path: join(dir, 'gone.sqlite') }]);
    const failingLake = onlyRoot(failing.tree);
    const [message] = await failing.tree.children(failingLake);
    expect(message && failing.tree.parent(message)).toBe(failingLake);
  });
});

describe('disposing the tree', () => {
  it('closes every catalog, also one that is still being opened, and stops the events', async () => {
    const { tree, probe } = createHarness([
      fixtureProfile,
      { ...fixtureProfile, id: 'other', name: 'Other' },
    ]);
    await Promise.all([tree.connect('fixture'), tree.connect('other')]);
    const events = recordEvents(tree);

    await tree.dispose();

    expect(probe.closed).toBe(2);
    tree.selectSnapshot('fixture', 5);
    expect(events).toEqual([]);

    const opening = createHarness();
    const open = holdOpen(opening.probe);
    const connecting = opening.tree.connect('fixture');
    const disposing = opening.tree.dispose();
    open();
    await Promise.all([connecting, disposing]);
    expect({ opened: opening.probe.opened, closed: opening.probe.closed }).toEqual({ opened: 1, closed: 1 });
  });
});

describe('catalogs with an unusual shape', () => {
  const schemaRow = (id: number, name: string) =>
    `INSERT INTO ducklake_schema (schema_id, schema_uuid, begin_snapshot, schema_name, path, path_is_relative) VALUES (${id}, 'u${id}', 0, '${name}', '${name}/', 1)`;

  it('shows the comment of a schema in its tooltip, lists struct fields in table order, and lists the views of a schema without tables', async () => {
    const { tree } = await variant(
      'unusual.sqlite',
      `INSERT INTO ducklake_tag (object_id, begin_snapshot, end_snapshot, key, value) VALUES (1, 1, NULL, 'comment', 'Everything we sell')`,
      "UPDATE ducklake_column SET column_name = 'zname' WHERE table_id = 2 AND column_id = 3",
      "UPDATE ducklake_column SET column_name = 'zkey' WHERE table_id = 2 AND column_id = 7",
      schemaRow(6, 'reports'),
      "INSERT INTO ducklake_view (view_id, view_uuid, begin_snapshot, schema_id, view_name, dialect, sql, column_aliases) VALUES (14, 'v14', 0, 6, 'daily', 'duckdb', 'SELECT 1', '')",
    );
    const sales = await find(tree, LAKE, 'sales');
    expect(sales.tooltip).toContain('Everything we sell');
    expect(sales.description).toBeUndefined();
    expect((await find(tree, LAKE, 'main')).tooltip).toBeUndefined();

    expect(await labelsAt(tree, ...ORDERS_PATH, 'Columns', 'customer')).toEqual(['zname', 'tags']);
    expect(await labelsAt(tree, ...ORDERS_PATH, 'Columns', 'attrs')).toEqual(['zkey', 'value']);

    expect(await labelsAt(tree, LAKE, 'reports')).toHaveLength(3);
    expect(await labelsAt(tree, LAKE, 'reports', 'Tables')).toHaveLength(1);
    expect(await labelsAt(tree, LAKE, 'reports', 'Views')).toEqual(['daily']);
  });

  it('keeps the children and parents of two tables with the same name apart', async () => {
    const { tree } = await variant(
      'same-name.sqlite',
      schemaRow(6, 'archive'),
      "INSERT INTO ducklake_table (table_id, table_uuid, begin_snapshot, schema_id, table_name, path, path_is_relative) VALUES (10, 't10', 0, 6, 'orders', 'orders/', 1)",
      "INSERT INTO ducklake_column (column_id, begin_snapshot, table_id, column_order, column_name, column_type, default_value, nulls_allowed, default_value_type) VALUES (1, 0, 10, 1, 'id', 'int64', 'NULL', 1, 'literal'), (2, 0, 10, 2, 'legacy', 'varchar', 'NULL', 1, 'literal')",
    );
    const archived = await find(tree, LAKE, 'archive', 'Tables', 'orders');
    const current = await find(tree, ...ORDERS_PATH);
    const columnsOf = async (table: TreeNode) =>
      (await tree.children(table)).find((node) => node.label === 'Columns');
    const archivedFolder = await columnsOf(archived);
    const currentFolder = await columnsOf(current);
    const archivedColumns = archivedFolder ? await tree.children(archivedFolder) : [];
    const currentColumns = currentFolder ? await tree.children(currentFolder) : [];

    expect(archivedColumns.map((node) => node.label)).toEqual(['id', 'legacy']);
    expect(currentColumns.map((node) => node.label)).toEqual([
      'id',
      'customer',
      'attrs',
      'amount',
      'created',
    ]);
    expect(archivedFolder && tree.parent(archivedFolder)).toBe(archived);
    expect(currentFolder && tree.parent(currentFolder)).toBe(current);
    expect(archivedColumns.every((node) => tree.parent(node) === archivedFolder)).toBe(true);
    expect(currentColumns.every((node) => tree.parent(node) === currentFolder)).toBe(true);
  });
});

describe('a catalog that fails to close', () => {
  it('stops neither a disconnect, nor a refresh, nor the disposal, and logs the failure', async () => {
    const actions: [string, (tree: CatalogTree) => Promise<void>][] = [
      ['disconnect', (tree) => tree.disconnect('fixture')],
      [
        'refresh',
        async (tree) => {
          tree.refresh();
          await tree.connect('fixture');
          expect(tree.state('fixture').status).toBe('connected');
          expect(schemaLabels(await tree.children(onlyRoot(tree)))).toEqual(['main', 'sales']);
        },
      ],
      ['dispose', (tree) => tree.dispose()],
    ];
    for (const [name, act] of actions) {
      const { tree, probe } = createHarness();
      await tree.connect('fixture');
      probe.closeFailure = new Error('socket hang up');

      await expect(act(tree), name).resolves.toBeUndefined();

      expect(probe.errors, name).toHaveLength(1);
      expect(probe.causes, name).toEqual([probe.closeFailure]);
    }
  });
});

describe('closing waits for the catalog', () => {
  it('keeps disconnect(), dispose() and the connect() after a refresh pending until the catalog is closed', async () => {
    const scenarios: [string, (tree: CatalogTree) => Promise<void>][] = [
      ['disconnect', (tree) => tree.disconnect('fixture')],
      ['dispose', (tree) => tree.dispose()],
      [
        'refresh',
        (tree) => {
          tree.refresh();
          return tree.connect('fixture');
        },
      ],
    ];
    for (const [name, act] of scenarios) {
      const { tree, probe } = createHarness();
      await tree.connect('fixture');
      const release = holdClose(probe);

      const pending = act(tree);
      await expect.poll(() => probe.closed, { message: name }).toBe(1);
      expect(await stillPending(pending), name).toBe(true);

      release();
      await pending;
    }
  });

  it('tells about the new catalog of a refresh, and about a disconnect, before the old catalog is closed', async () => {
    const refreshed = createHarness();
    const lake = onlyRoot(refreshed.tree);
    await refreshed.tree.connect('fixture');
    const events = recordEvents(refreshed.tree);
    holdClose(refreshed.probe);

    refreshed.tree.refresh();
    const connecting = refreshed.tree.connect('fixture');
    await expect.poll(() => refreshed.probe.closed).toBe(1);
    expect(events.at(-1)).toEqual({ node: lake, status: 'connected' });
    expect(await stillPending(connecting)).toBe(true);

    const { tree, probe } = createHarness();
    const disconnected = onlyRoot(tree);
    await tree.connect('fixture');
    const told = recordEvents(tree);
    holdClose(probe);
    const disconnecting = tree.disconnect('fixture');
    await expect.poll(() => probe.closed).toBe(1);
    expect(told).toEqual([{ node: disconnected, status: 'disconnected' }]);
    expect(await stillPending(disconnecting)).toBe(true);
  });
});

describe('the columns of a view', () => {
  const VIEW_COLUMNS: readonly RelationColumn[] = [
    { name: 'id', type: 'INTEGER', nullable: false },
    { name: 'customer', type: 'STRUCT("name" VARCHAR, tags VARCHAR[])', nullable: true },
    { name: 'amount', type: 'DECIMAL(10,2)', nullable: true },
  ];
  const COLUMNS_PATH = [...BIG_ORDERS_PATH, 'Columns'];

  /** A tree whose `viewColumns` is a fake of the engine; `calls` records what the tree asked for. */
  function createViewHarness(
    answer: (call: number) => Promise<readonly RelationColumn[]> = () => Promise.resolve(VIEW_COLUMNS),
  ) {
    const calls: { connectionId: string; schema: string; view: string; snapshot: number }[] = [];
    const harness = createHarness([fixtureProfile], {
      viewColumns: (connectionId, schema, view, snapshot) => {
        calls.push({ connectionId, schema: schema.name, view: view.name, snapshot });
        return answer(calls.length);
      },
    });
    return { ...harness, calls };
  }

  it('shows nothing below a view without a way to read its columns, otherwise a Columns folder with the columns DuckDB resolved, in their order', async () => {
    const plain = createHarness();
    const bare = await find(plain.tree, ...BIG_ORDERS_PATH);
    expect(bare.hasChildren).toBe(false);
    expect(await plain.tree.children(bare)).toEqual([]);

    const { tree } = createViewHarness();
    const outlined = await outline(tree);
    expect(outlined.slice(outlined.indexOf('      big_orders'))).toEqual([
      '      big_orders',
      '        Columns',
      '          id',
      '          customer',
      '          amount',
      '    Macros',
    ]);
    const folder = await find(tree, ...COLUMNS_PATH);
    expect(folder).toMatchObject({
      id: 'fixture/s1/views/v4/columns',
      contextValue: 'folder.viewColumns',
      hasChildren: true,
      ref: { kind: 'folder', folder: 'viewColumns', schema: { name: 'sales' }, view: { name: 'big_orders' } },
    });
    const nodes = await tree.children(folder);
    expect(nodes.map(({ id, contextValue, hasChildren }) => [id, contextValue, hasChildren])).toEqual([
      ['fixture/s1/views/v4/columns/c0', 'viewColumn', false],
      ['fixture/s1/views/v4/columns/c1', 'viewColumn', false],
      ['fixture/s1/views/v4/columns/c2', 'viewColumn', false],
    ]);
    expect(nodes[0]?.ref).toMatchObject({
      kind: 'viewColumn',
      connectionId: 'fixture',
      schema: { id: ID.salesSchema, name: 'sales' },
      view: { id: ID.bigOrdersView, name: 'big_orders' },
      column: { name: 'id', type: 'INTEGER', nullable: false },
    });
    expect(tree.parent(nodes[2] as TreeNode)).toBe(folder);
  });

  it('reads nothing before the view is expanded, once per expansion and snapshot, and asks again after a refresh', async () => {
    const { tree, calls } = createViewHarness();
    const folder = await find(tree, ...COLUMNS_PATH);
    await tree.children(await find(tree, ...ORDERS_PATH));
    await tree.children(await find(tree, ...BIG_ORDERS_PATH));
    expect(calls).toEqual([]);

    const [first, second] = await Promise.all([tree.children(folder), tree.children(folder)]);
    const third = await tree.children(folder);
    expect(calls).toEqual([
      { connectionId: 'fixture', schema: 'sales', view: 'big_orders', snapshot: LATEST_SNAPSHOT },
    ]);
    expect(second).toBe(first);
    expect(third).toBe(first);

    tree.refresh();
    await tree.connect('fixture');
    const after = await tree.children(await find(tree, ...COLUMNS_PATH));
    expect(after.map((node) => node.id)).toEqual(first.map((node) => node.id));
    expect(calls).toHaveLength(2);

    // Another snapshot asks again, with that snapshot; where the view does not exist yet it asks nothing.
    tree.selectSnapshot('fixture', SNAPSHOT.commentOnView);
    expect(await labelsAt(tree, ...COLUMNS_PATH)).toEqual(['id', 'customer', 'amount']);
    expect(calls.map(({ snapshot }) => snapshot)).toEqual([
      LATEST_SNAPSHOT,
      LATEST_SNAPSHOT,
      SNAPSHOT.commentOnView,
    ]);
    tree.selectSnapshot('fixture', SNAPSHOT.deleteOrder2);
    expect((await outline(tree)).join('\n')).not.toContain('big_orders');
    expect(calls).toHaveLength(3);
  });

  it('shows one message instead of an exception when the user declined and asks again after a refresh, and logs only real failures', async () => {
    const declined = createViewHarness((call) =>
      call === 1
        ? Promise.reject(new AantjeError('ABORTED', 'Views run SQL from the catalog. You did not trust it.'))
        : Promise.resolve(VIEW_COLUMNS),
    );
    const folder = await find(declined.tree, ...COLUMNS_PATH);
    const message = await declined.tree.children(folder);

    expect(message).toHaveLength(1);
    expect(message[0]).toMatchObject({
      id: 'fixture/s1/views/v4/columns/message',
      contextValue: 'message',
      hasChildren: false,
      ref: { kind: 'message', connectionId: 'fixture' },
    });
    expect(await declined.tree.children(folder)).toBe(message);
    expect(declined.calls).toHaveLength(1);
    expect(declined.probe.errors).toEqual([]);
    expect(declined.tree.state('fixture').status).toBe('connected');

    declined.tree.refresh();
    await declined.tree.connect('fixture');
    expect(await labelsAt(declined.tree, ...COLUMNS_PATH)).toEqual(['id', 'customer', 'amount']);
    expect(declined.calls).toHaveLength(2);

    const failed = createViewHarness(() => Promise.reject(new AantjeError('QUERY_FAILED', 'DuckDB failed.')));
    const [failure] = await failed.tree.children(await find(failed.tree, ...COLUMNS_PATH));
    expect(failure?.ref.kind).toBe('message');
    expect(failed.probe.errors).toHaveLength(1);

    const unexpected = createViewHarness(() => Promise.reject(new Error('password=hunter2 at /srv/lake')));
    const [generic] = await unexpected.tree.children(await find(unexpected.tree, ...COLUMNS_PATH));
    expect(JSON.stringify(generic)).not.toContain('hunter2');
  });

  describe('that is still being read when the tree drops what it read', () => {
    /** Reads that never end by themselves; the signals show who is still waited for. */
    function hangingViews() {
      const signals: AbortSignal[] = [];
      const harness = createHarness([fixtureProfile], {
        viewColumns: (_connection, _schema, _view, _snapshot, signal) => {
          signals.push(signal);
          return new Promise<never>(() => undefined);
        },
      });
      return { ...harness, signals };
    }

    it('tells the engine that nobody waits for it any more after a refresh, another snapshot, a disconnect or disposing', async () => {
      const drops: [string, (tree: CatalogTree) => Promise<void> | void][] = [
        ['a refresh', (tree) => tree.refresh()],
        ['another snapshot', (tree) => tree.selectSnapshot('fixture', SNAPSHOT.commentOnView)],
        ['a disconnect', (tree) => tree.disconnect('fixture')],
        ['disposing the tree', (tree) => tree.dispose()],
      ];
      for (const [what, drop] of drops) {
        const { tree, signals } = hangingViews();
        void tree.children(await find(tree, ...COLUMNS_PATH));
        await vi.waitFor(() => expect(signals).toHaveLength(1));
        expect(signals[0]?.aborted, what).toBe(false);

        await drop(tree);

        expect(signals[0]?.aborted, what).toBe(true);
      }
    });

    it('answers a read that the engine cancelled because of the refresh with nothing, and keeps the signal of the current cache open', async () => {
      const cancelled = createHarness([fixtureProfile], {
        viewColumns: (_connection, _schema, _view, _snapshot, signal) =>
          new Promise<never>((_, reject) => {
            signal.addEventListener('abort', () =>
              reject(new AantjeError('ABORTED', 'Reading "sales.big_orders" was cancelled.')),
            );
          }),
      });
      const reading = cancelled.tree.children(await find(cancelled.tree, ...COLUMNS_PATH));
      cancelled.tree.refresh();
      expect(await reading).toEqual([]);
      expect(cancelled.probe.errors).toEqual([]);

      const { tree, signals } = hangingViews();
      void tree.children(await find(tree, ...COLUMNS_PATH));
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      tree.refresh();
      await tree.connect('fixture');
      void tree.children(await find(tree, ...COLUMNS_PATH));
      await vi.waitFor(() => expect(signals).toHaveLength(2));

      expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    });
  });

  describe('when many views are expanded at once', () => {
    const view = (id: number) =>
      `INSERT INTO ducklake_view (view_id, view_uuid, begin_snapshot, schema_id, view_name, dialect, sql, column_aliases) VALUES (${id}, 'v${id}', 0, 1, 'v${id}', 'duckdb', 'SELECT 1', '')`;

    async function manyViews(extra = [14, 15, 16, 17]) {
      const path = await catalogFile(
        `many-views-${extra.length}.sqlite`,
        catalogBytes('fixture', ...extra.map(view)),
      );
      const open = gate();
      /** A read that is listed here ends only when its gate is released, after `open`. */
      const holds = new Map<string, ReturnType<typeof gate>>();
      const started: string[] = [];
      let running = 0;
      let peak = 0;
      const harness = createHarness([{ ...fixtureProfile, path }], {
        viewColumns: async (_connection, _schema, { name }) => {
          started.push(name);
          peak = Math.max(peak, ++running);
          await open.promise;
          await holds.get(name)?.promise;
          running--;
          return VIEW_COLUMNS;
        },
      });
      const sales = await find(harness.tree, LAKE, 'sales');
      const [, viewsFolder] = await harness.tree.children(sales);
      const views = viewsFolder ? await harness.tree.children(viewsFolder) : [];
      // Resolving a view means expanding its Columns folder.
      const folders = await Promise.all(views.map(async (view) => (await harness.tree.children(view))[0]));
      return {
        ...harness,
        views: folders as TreeNode[],
        names: views.map((view) => view.label),
        open,
        holds,
        started,
        peak: () => peak,
      };
    }

    it('resolves only three at a time and hands a place that frees up to the next waiting read, in order', async () => {
      const { tree, views, names, open, holds, started, peak } = await manyViews([14, 15, 16, 17, 18]);
      expect(views).toHaveLength(6);
      for (const name of names) {
        holds.set(name, gate());
      }
      open.release();

      const reads = views.slice(0, 5).map((node) => tree.children(node));
      await vi.waitFor(() => expect(started).toHaveLength(3));
      holds.get(names[0] ?? '')?.release();
      await vi.waitFor(() => expect(started).toHaveLength(4));
      holds.get(names[1] ?? '')?.release();
      await vi.waitFor(() => expect(started).toHaveLength(5));
      // Three reads are running (the third, fourth and fifth): the sixth has to wait for one of them.
      const sixth = tree.children(views[5] as TreeNode);
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(started).toEqual(names.slice(0, 5));
      for (const name of names) {
        holds.get(name)?.release();
      }
      const columns = await Promise.all([...reads, sixth]);
      expect(started).toEqual(names);
      expect(peak()).toBe(3);
      expect(columns.map((list) => list.length)).toEqual([3, 3, 3, 3, 3, 3]);
    });

    it('does not start the waiting ones once the tree dropped what it read', async () => {
      const { tree, views, open, started } = await manyViews();
      const reads = views.map((node) => tree.children(node));
      await vi.waitFor(() => expect(started).toHaveLength(3));

      tree.refresh();
      open.release();
      await Promise.all(reads);
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(started).toHaveLength(3);
    });
  });

  it('forgets the columns of a connection that was closed, and does not show a late answer of an earlier refresh', async () => {
    const { tree, calls } = createViewHarness();
    const folder = await find(tree, ...COLUMNS_PATH);
    await tree.children(folder);

    await tree.disconnect('fixture');
    expect(await tree.children(folder)).toEqual([]);
    expect(calls).toHaveLength(1);

    await tree.connect('fixture');
    expect(await tree.children(await find(tree, ...COLUMNS_PATH))).toHaveLength(3);
    expect(calls).toHaveLength(2);

    const late = gate();
    const slowTree = createViewHarness((call) =>
      call === 1
        ? late.promise.then(() => [{ name: 'stale', type: 'INTEGER', nullable: true }])
        : Promise.resolve(VIEW_COLUMNS),
    );
    const slow = slowTree.tree.children(await find(slowTree.tree, ...COLUMNS_PATH));

    slowTree.tree.refresh();
    await slowTree.tree.connect('fixture');
    const refreshed = await find(slowTree.tree, ...COLUMNS_PATH);
    const fresh = await slowTree.tree.children(refreshed);
    late.release();
    await slow;

    expect(fresh.map((node) => node.label)).toEqual(['id', 'customer', 'amount']);
    expect(await slowTree.tree.children(refreshed)).toBe(fresh);
    expect(slowTree.calls).toHaveLength(2);
  });
});

describe('the context value of a connection', () => {
  it('marks an Azure DuckLake in every state, and no other connection', () => {
    const postgres: ConnectionProfile = {
      id: 'pg',
      name: 'pg',
      kind: 'postgres',
      host: 'db.example.org',
      port: 5432,
      database: 'lake',
      user: 'etl',
    };
    const azure: ConnectionProfile = { ...postgres, azureAccount: 'lakefiles' };
    const states: ConnectionState[] = [
      { status: 'disconnected', snapshot: 'latest' },
      { status: 'connecting', snapshot: 'latest' },
      { status: 'connected', specVersion: SPEC_VERSION, latestSnapshot: LATEST_SNAPSHOT, snapshot: 'latest' },
      { status: 'error', snapshot: 'latest', error: 'refused' },
    ];
    for (const state of states) {
      const plain = connectionPresentation(postgres, state, true).contextValue;
      expect(connectionPresentation(fixtureProfile, state, true).contextValue, state.status).toBe(plain);
      expect(connectionPresentation(azure, state, true).contextValue, state.status).toBe(`${plain}.azure`);
    }
  });
});

describe('the context value of a schema', () => {
  it('marks the schema main, and no other schema', () => {
    const lake: TreeNode = {
      id: 'lake',
      ref: { kind: 'connection', connectionId: 'lake' },
      label: 'lake',
      icon: 'database',
      contextValue: 'connection.connected',
      hasChildren: true,
    };
    const valueOf = (name: string): string => schemaNode(lake, { id: 1, name, comment: null }).contextValue;
    expect(['main', 'shop', 'main_backup'].map(valueOf)).toEqual(['schema.main', 'schema', 'schema']);
  });
});
