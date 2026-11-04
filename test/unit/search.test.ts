import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogEntry, CatalogReader } from '../../src/catalog/model';
import { openCatalog } from '../../src/catalog/open';
import { createCatalogReader } from '../../src/catalog/reader';
import type { FileProfile } from '../../src/connections/profile';
import { folderNodeId, searchPickItems, treeNodeId } from '../../src/search';
import { CatalogTree } from '../../src/tree/model';
import { ID, LATEST_SNAPSHOT, SNAPSHOT } from '../support/expected';
import { fixturePath, wasmPath } from '../support/fixtures';

// The tables and views of the fixture catalog at its latest snapshot, plus sales.tmp which only exists
// in snapshots 3..10.
const orders: CatalogEntry = {
  kind: 'table',
  id: ID.orders,
  name: 'orders',
  schemaId: ID.salesSchema,
  schemaName: 'sales',
};
const bigOrders: CatalogEntry = {
  kind: 'view',
  id: ID.bigOrdersView,
  name: 'big_orders',
  schemaId: ID.salesSchema,
  schemaName: 'sales',
};
const plain: CatalogEntry = {
  kind: 'table',
  id: ID.plain,
  name: 'plain',
  schemaId: ID.mainSchema,
  schemaName: 'main',
};
const tmp: CatalogEntry = {
  kind: 'table',
  id: ID.tmp,
  name: 'tmp',
  schemaId: ID.salesSchema,
  schemaName: 'sales',
};

const entry = (schemaName: string, name: string, id: number): CatalogEntry => ({
  kind: 'table',
  id,
  name,
  schemaId: 1,
  schemaName,
});

describe('searchPickItems', () => {
  it('offers every table and view as schema.name with its kind and the entry itself, sorted by schema and name, without reordering its input', () => {
    const entries = [orders, bigOrders, plain];
    expect(searchPickItems(entries)).toEqual([
      { label: 'main.plain', description: 'table', value: plain },
      { label: 'sales.big_orders', description: 'view', value: bigOrders },
      { label: 'sales.orders', description: 'table', value: orders },
    ]);
    expect(searchPickItems(entries)[0]?.value).toBe(plain);
    expect(entries).toEqual([orders, bigOrders, plain]);
    expect(searchPickItems([tmp, orders]).map((item) => item.label)).toEqual(['sales.orders', 'sales.tmp']);
    expect(searchPickItems([])).toEqual([]);
    // A picker draws `$(name)` as an icon: a name of the catalog shows as typed.
    expect(searchPickItems([entry('s', '$(alert) urgent', 9)])[0]?.label).toBe(
      String.raw`s.\$(alert) urgent`,
    );
  });

  it('orders like the tree: by the English rules whatever the language of the machine is, ignoring case and accents, numbers by value, ties in the given order', () => {
    const ids = (entries: CatalogEntry[]) => searchPickItems(entries).map((item) => item.value.id);
    const names = (list: string[]) =>
      searchPickItems(list.map((name, id) => entry('s', name, id))).map((item) => item.value.name);

    expect(
      searchPickItems([
        entry('Sales', 'Zeta', 1),
        entry('analytics', 'orders', 2),
        entry('Sales', 'alpha', 3),
        entry('main', 'Plain', 4),
        entry('Sales', 'Beta', 5),
      ]).map((item) => item.label),
    ).toEqual(['analytics.orders', 'main.Plain', 'Sales.alpha', 'Sales.Beta', 'Sales.Zeta']);
    expect(names(['part_10', 'part_9', 'part_100', 'part_1'])).toEqual([
      'part_1',
      'part_9',
      'part_10',
      'part_100',
    ]);
    // Swedish sorts ä after z, Czech sorts ch after h; English sorts both like the plain letters.
    expect(names(['zebra', 'ärger', 'hat', 'chair', 'apple'])).toEqual([
      'apple',
      'ärger',
      'chair',
      'hat',
      'zebra',
    ]);
    expect(ids([entry('s', 'item', 1), entry('s', 'Item', 2)])).toEqual([1, 2]);
    expect(ids([entry('s', 'Item', 2), entry('s', 'item', 1)])).toEqual([2, 1]);
    expect(ids([entry('s', 'café', 1), entry('s', 'cafe', 2)])).toEqual([1, 2]);
    expect(ids([entry('s', 'cafe', 2), entry('s', 'café', 1)])).toEqual([2, 1]);
  });
});

describe('treeNodeId and folderNodeId', () => {
  it('name a table or view by the encoded connection id, the schema id and its own id, below the id of its folder', () => {
    expect(treeNodeId('example', orders)).toBe('example/s1/tables/t2');
    expect(treeNodeId('example', plain)).toBe('example/s0/tables/t5');
    expect(treeNodeId('example', bigOrders)).toBe('example/s1/views/v4');
    expect(treeNodeId('my catalog/prod', orders)).toBe('my%20catalog%2Fprod/s1/tables/t2');
    expect(folderNodeId('example', orders)).toBe('example/s1/tables');
    expect(folderNodeId('example', bigOrders)).toBe('example/s1/views');
    expect(treeNodeId('example', orders).startsWith(`${folderNodeId('example', orders)}/`)).toBe(true);
  });
});

describe('searchPickItems and treeNodeId on the fixture catalog', () => {
  const profile: FileProfile = {
    id: 'my catalog/prod',
    name: 'example',
    kind: 'sqlite',
    path: fixturePath('ducklake.sqlite'),
  };

  let reader: CatalogReader;
  beforeAll(async () => {
    reader = createCatalogReader(await openSqlite({ path: profile.path, wasmPath }));
  });
  afterAll(() => reader.close());

  it('lists what the reader finds in a snapshot, and gives every entry the id of the node that the tree shows for it', async () => {
    const latest = searchPickItems(await reader.entries(LATEST_SNAPSHOT));
    expect(latest.map((item) => [item.label, item.description])).toEqual([
      ['main.plain', 'table'],
      ['sales.big_orders', 'view'],
      ['sales.orders', 'table'],
    ]);
    const older = searchPickItems(await reader.entries(SNAPSHOT.insertTmp));
    expect(older.map((item) => item.label)).toEqual(['sales.orders', 'sales.tmp']);

    const tree = new CatalogTree({
      profiles: () => [profile],
      open: () => openCatalog(profile, { wasmPath }),
    });
    try {
      const [connection] = tree.roots();
      const schemas = connection ? await tree.children(connection) : [];
      const folders = (await Promise.all(schemas.map((schema) => tree.children(schema)))).flat();
      const children = (await Promise.all(folders.map((folder) => tree.children(folder)))).flat();
      const nodeIds = children
        .filter((node) => node.ref.kind === 'table' || node.ref.kind === 'view')
        .map((node) => node.id);

      expect(latest.map((hit) => treeNodeId(profile.id, hit.value)).sort()).toEqual(nodeIds.sort());
      expect(nodeIds).toHaveLength(3);
    } finally {
      await tree.dispose();
    }
  });
});
