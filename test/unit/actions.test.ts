import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ddlOf, findEntryNode, qualifiedNameOf, shownSnapshot } from '../../src/actions';
import type { CatalogEntry } from '../../src/catalog/model';
import { openCatalog } from '../../src/catalog/open';
import type { ConnectionProfile } from '../../src/connections/profile';
import { CatalogTree } from '../../src/tree/model';
import type { NodeRef, TreeNode } from '../../src/tree/refs';
import { ID, LATEST_SNAPSHOT, SNAPSHOT } from '../support/expected';
import { fixturePath, wasmPath } from '../support/fixtures';

const profile: ConnectionProfile = {
  id: 'fixture',
  name: 'Fixture',
  kind: 'sqlite',
  path: fixturePath('ducklake.sqlite'),
};

const ORDERS_DDL = `CREATE TABLE "sales"."orders" (
  "id" INTEGER NOT NULL,
  "customer" STRUCT("name" VARCHAR, "tags" VARCHAR[]),
  "attrs" MAP(VARCHAR, INTEGER),
  "amount" DECIMAL(10,2) DEFAULT 0,
  "created" TIMESTAMP
);`;

const PLAIN_DDL_AT_CREATION = `CREATE TABLE "main"."plain" (
  "x" BIGINT,
  "y" VARCHAR
);`;

const PLAIN_DDL_AT_LATEST = `CREATE TABLE "main"."plain" (
  "x" BIGINT,
  "y" VARCHAR,
  "z" DOUBLE
);`;

const BIG_ORDERS_DDL = 'CREATE VIEW "sales"."big_orders" AS SELECT * FROM sales.orders WHERE (amount > 1);';

const second: ConnectionProfile = { ...profile, id: 'second', name: 'Second' };

let tree: CatalogTree;
let profiles: ConnectionProfile[];

beforeEach(() => {
  profiles = [profile];
  tree = new CatalogTree({
    profiles: () => profiles,
    open: () => openCatalog(profile, { wasmPath }),
  });
});

afterEach(() => tree.dispose());

/** Walks the tree by labels, starting at the connection node, e.g. `['sales', 'orders', 'customer']`. */
async function nodeAt(...labels: string[]): Promise<TreeNode> {
  let node = tree.roots()[0];
  for (const label of labels) {
    const child = node && (await tree.children(node)).find((candidate) => candidate.label === label);
    if (!child) {
      throw new Error(`No node "${label}" under "${node?.label}"`);
    }
    node = child;
  }
  if (!node) {
    throw new Error('The tree has no connection');
  }
  return node;
}

describe('shownSnapshot', () => {
  it('is the newest snapshot while the tree follows "latest", the pinned one otherwise, and unknown while closed', () => {
    expect(shownSnapshot({ status: 'connected', snapshot: 'latest', latestSnapshot: 13 })).toBe(13);
    expect(shownSnapshot({ status: 'connected', snapshot: 6, latestSnapshot: 13 })).toBe(6);
    expect(shownSnapshot({ status: 'disconnected', snapshot: 'latest' })).toBeUndefined();
  });
});

describe('qualifiedNameOf', () => {
  it('quotes schema, table, view and nested column names for SQL, and has no name for a connection, folder or message', async () => {
    expect(qualifiedNameOf((await nodeAt('sales')).ref)).toBe('"sales"');
    expect(qualifiedNameOf((await nodeAt('sales', 'Tables', 'orders')).ref)).toBe('"sales"."orders"');
    expect(qualifiedNameOf((await nodeAt('sales', 'Views', 'big_orders')).ref)).toBe('"sales"."big_orders"');
    expect(qualifiedNameOf((await nodeAt('sales', 'Tables', 'orders', 'Columns', 'amount')).ref)).toBe(
      '"sales"."orders"."amount"',
    );
    expect(
      qualifiedNameOf((await nodeAt('sales', 'Tables', 'orders', 'Columns', 'customer', 'name')).ref),
    ).toBe('"sales"."orders"."customer"."name"');

    const ref: NodeRef = {
      kind: 'table',
      connectionId: 'c',
      schema: { id: 1, name: 'we"ird', comment: null },
      table: { id: 2, schemaId: 1, name: 'a b', comment: null, stats: { rows: 0, files: 0, sizeBytes: 0 } },
    };
    expect(qualifiedNameOf(ref)).toBe('"we""ird"."a b"');

    expect(qualifiedNameOf((await nodeAt()).ref)).toBeUndefined();
    expect(qualifiedNameOf((await nodeAt('sales', 'Tables')).ref)).toBeUndefined();
    expect(qualifiedNameOf((await nodeAt('sales', 'Tables', 'orders', 'Columns')).ref)).toBeUndefined();
    expect(qualifiedNameOf({ kind: 'message', connectionId: 'c', text: 'x' })).toBeUndefined();
  });
});

describe('ddlOf', () => {
  it('creates the statement of a table with its nested columns and of a view, at the snapshot the tree shows, and none for the rest', async () => {
    expect(await ddlOf(tree, (await nodeAt('sales', 'Tables', 'orders')).ref)).toBe(ORDERS_DDL);
    expect(await ddlOf(tree, (await nodeAt('sales', 'Views', 'big_orders')).ref)).toBe(BIG_ORDERS_DDL);

    const { ref } = await nodeAt('main', 'Tables', 'plain');
    expect(await ddlOf(tree, ref)).toBe(PLAIN_DDL_AT_LATEST);
    tree.selectSnapshot(profile.id, SNAPSHOT.createPlain);
    expect(await ddlOf(tree, ref)).toBe(PLAIN_DDL_AT_CREATION);
    tree.selectSnapshot(profile.id, 'latest');
    expect(await ddlOf(tree, ref)).toBe(PLAIN_DDL_AT_LATEST);

    for (const labels of [
      ['sales'],
      ['sales', 'Tables'],
      ['sales', 'Tables', 'orders', 'Columns'],
      ['sales', 'Tables', 'orders', 'Columns', 'amount'],
      [],
    ]) {
      expect(await ddlOf(tree, (await nodeAt(...labels)).ref), labels.join('/')).toBeUndefined();
    }
  });

  it('asks to connect again when the connection was closed or a refresh is reopening the catalog, also with a pinned snapshot', async () => {
    const { ref } = await nodeAt('sales', 'Tables', 'orders');
    await tree.disconnect(profile.id);
    await expect(ddlOf(tree, ref)).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });

    await tree.connect(profile.id);
    tree.selectSnapshot(profile.id, SNAPSHOT.deleteOrder2);
    tree.refresh();
    await expect(ddlOf(tree, ref)).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  });
});

describe('findEntryNode', () => {
  async function entries(): Promise<CatalogEntry[]> {
    await nodeAt(); // opens the connection
    await tree.connect(profile.id);
    const reader = tree.reader(profile.id);
    if (!reader) {
      throw new Error('not connected');
    }
    return reader.entries(LATEST_SNAPSHOT);
  }

  it('finds the node of every table and view as the very object the tree caches, and nothing for what is not shown', async () => {
    const found = await Promise.all(
      (await entries()).map(async (entry) => ({ entry, node: await findEntryNode(tree, profile.id, entry) })),
    );

    expect(found.map(({ entry }) => `${entry.schemaName}.${entry.name}`).toSorted()).toEqual([
      'main.plain',
      'sales.big_orders',
      'sales.orders',
    ]);
    for (const { entry, node } of found) {
      expect(node?.ref).toMatchObject({ kind: entry.kind, connectionId: profile.id });
      const folder = await nodeAt(entry.schemaName, entry.kind === 'table' ? 'Tables' : 'Views');
      expect(await tree.children(folder)).toContain(node);
    }

    // A table that does not exist at the shown snapshot, a view of a schema that has no folder for views, an unknown connection.
    const dropped: CatalogEntry = {
      kind: 'table',
      id: ID.tmp,
      name: 'tmp',
      schemaId: ID.salesSchema,
      schemaName: 'sales',
    };
    expect(await findEntryNode(tree, profile.id, dropped)).toBeUndefined();
    tree.selectSnapshot(profile.id, SNAPSHOT.insertTmp);
    expect(await findEntryNode(tree, profile.id, dropped)).toMatchObject({ label: 'tmp' });

    const view: CatalogEntry = {
      kind: 'view',
      id: ID.bigOrdersView,
      name: 'big_orders',
      schemaId: 0,
      schemaName: 'main',
    };
    expect(await findEntryNode(tree, profile.id, view)).toBeUndefined();
    expect(await findEntryNode(tree, 'other', found[0]?.entry as CatalogEntry)).toBeUndefined();
  });

  it('finds the node in the connection that is asked for when several are configured', async () => {
    profiles = [profile, second];
    tree.profilesChanged();
    const [entry] = await entries();
    expect(entry).toBeDefined();
    await tree.connect(second.id);

    const node = await findEntryNode(tree, second.id, entry as CatalogEntry);

    expect(node?.ref.connectionId).toBe(second.id);
    expect(node?.label).toBe(entry?.name);
  });
});

describe('actions on the columns of a view', () => {
  let viewTree: CatalogTree;

  beforeEach(() => {
    viewTree = new CatalogTree({
      profiles: () => [profile],
      open: () => openCatalog(profile, { wasmPath }),
      viewColumns: () =>
        Promise.resolve([
          { name: 'id', type: 'INTEGER', nullable: false },
          { name: 'we"ird', type: 'VARCHAR', nullable: true },
        ]),
    });
  });

  afterEach(() => viewTree.dispose());

  async function columnRef(label: string): Promise<NodeRef> {
    const [connection] = viewTree.roots();
    let node = connection as TreeNode;
    for (const step of ['sales', 'Views', 'big_orders', 'Columns']) {
      node = (await viewTree.children(node)).find((child) => child.label === step) as TreeNode;
    }
    const column = (await viewTree.children(node)).find((child) => child.label === label);
    if (!column) {
      throw new Error(`No column "${label}"`);
    }
    return column.ref;
  }

  it('names a column of a view by schema, view and column, quoted, and has no DDL for it', async () => {
    expect(qualifiedNameOf(await columnRef('id'))).toBe('"sales"."big_orders"."id"');
    expect(qualifiedNameOf(await columnRef('we"ird'))).toBe('"sales"."big_orders"."we""ird"');
    expect(await ddlOf(viewTree, await columnRef('id'))).toBeUndefined();
  });
});
