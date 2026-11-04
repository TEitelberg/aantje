import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCatalog } from '../../src/catalog/open';
import type { ConnectionProfile } from '../../src/connections/profile';
import { changesKey, changesTitle, gridKey, gridTitle, relationOf } from '../../src/data/relation';
import { resolveTarget } from '../../src/data/resolve';
import { AantjeError } from '../../src/errors';
import { CatalogTree } from '../../src/tree/model';
import type { TreeNode } from '../../src/tree/refs';
import type { RelationColumn } from '../../src/data/types';
import { LATEST_SNAPSHOT } from '../support/expected';
import { fixturePath, wasmPath } from '../support/fixtures';

const profile: ConnectionProfile = {
  id: 'fixture',
  name: 'Fixture',
  kind: 'sqlite',
  path: fixturePath('ducklake.sqlite'),
};

let tree: CatalogTree;
/** What the tree is told about the columns of a view; undefined makes it fail like a declined confirmation. */
let viewColumns: RelationColumn[] | undefined;

beforeEach(() => {
  viewColumns = [{ name: 'id', type: 'INTEGER', nullable: false }];
  tree = new CatalogTree({
    profiles: () => [profile],
    open: () => openCatalog(profile, { wasmPath }),
    viewColumns: () =>
      viewColumns ? Promise.resolve(viewColumns) : Promise.reject(new AantjeError('ABORTED', 'Declined.')),
  });
});

afterEach(() => tree.dispose());

async function nodeAt(...labels: string[]): Promise<TreeNode> {
  let node = tree.roots()[0];
  for (const label of labels) {
    const child = node && (await tree.children(node)).find((candidate) => candidate.label === label);
    if (!child) {
      throw new Error(`No node "${label}"`);
    }
    node = child;
  }
  if (!node) {
    throw new Error('No connection');
  }
  return node;
}

describe('relationOf', () => {
  it('names the table of a table node and the view of a view node, marked by kind', async () => {
    expect(relationOf((await nodeAt('sales', 'Tables', 'orders')).ref)).toEqual({
      connectionId: 'fixture',
      kind: 'table',
      table: { schema: 'sales', table: 'orders' },
    });
    expect(relationOf((await nodeAt('sales', 'Views', 'big_orders')).ref)).toEqual({
      connectionId: 'fixture',
      kind: 'view',
      table: { schema: 'sales', table: 'big_orders' },
    });
  });

  it('has no relation for connections, schemas, folders, columns (also of a view, whose names DuckDB made up) and message nodes', async () => {
    for (const path of [
      [],
      ['sales'],
      ['sales', 'Tables'],
      ['sales', 'Views'],
      ['sales', 'Tables', 'orders', 'Columns'],
      ['sales', 'Views', 'big_orders', 'Columns'],
      ['sales', 'Tables', 'orders', 'Columns', 'amount'],
      ['sales', 'Views', 'big_orders', 'Columns', 'id'],
    ]) {
      expect(relationOf((await nodeAt(...path)).ref), path.join('/')).toBeUndefined();
    }

    viewColumns = undefined;
    tree.refresh();
    const [message] = await tree.children(await nodeAt('sales', 'Views', 'big_orders', 'Columns'));
    expect(message?.ref.kind).toBe('message');
    expect(message && relationOf(message.ref)).toBeUndefined();
  });
});

describe('gridKey', () => {
  const orders = { connectionId: 'a', kind: 'table', table: { schema: 's', table: 't' } } as const;

  it('cannot be imitated by moving a separator from one name into the next', () => {
    const one = gridKey({ connectionId: 'a:b', kind: 'table', table: { schema: 'c', table: 'd' } }, 1);
    const other = gridKey({ connectionId: 'a', kind: 'table', table: { schema: 'b:c', table: 'd' } }, 1);
    const dotted = gridKey({ connectionId: 'a', kind: 'table', table: { schema: 'x.y', table: 'z' } }, 1);
    const shifted = gridKey({ connectionId: 'a', kind: 'table', table: { schema: 'x', table: 'y.z' } }, 1);
    const slashed = gridKey({ connectionId: 'a', kind: 'table', table: { schema: 'x/y', table: 'z' } }, 1);
    const moved = gridKey({ connectionId: 'a', kind: 'table', table: { schema: 'x', table: 'y/z' } }, 1);
    const quoted = gridKey({ connectionId: 'a', kind: 'table', table: { schema: 'x"', table: 'y' } }, 1);
    const quotedOther = gridKey({ connectionId: 'a', kind: 'table', table: { schema: 'x', table: '"y' } }, 1);

    expect(one).not.toBe(other);
    expect(dotted).not.toBe(shifted);
    expect(slashed).not.toBe(moved);
    expect(quoted).not.toBe(quotedOther);
  });

  it('differs for the same table of two connections, for another snapshot and for the latest one, and is stable otherwise', () => {
    expect(gridKey(orders, 5)).toBe(gridKey({ ...orders }, 5));
    expect(gridKey(orders, undefined)).toBe(gridKey(orders, undefined));
    expect(gridKey(orders, 5)).not.toBe(gridKey(orders, 6));
    expect(gridKey(orders, 0)).not.toBe(gridKey(orders, undefined));
    expect(gridKey({ ...orders, connectionId: 'a' }, 5)).not.toBe(
      gridKey({ ...orders, connectionId: 'b' }, 5),
    );
  });
});

describe('the titles and keys of the panels', () => {
  const orders = { connectionId: 'a', kind: 'table', table: { schema: 'sales', table: 'orders' } } as const;
  const customers = {
    connectionId: 'a',
    kind: 'table',
    table: { schema: 'shop', table: 'customers' },
  } as const;

  it('name the table, the connection and the snapshot(s), so that one table at two snapshots or on two connections gets two panels', () => {
    const grid = [
      gridTitle(orders, 'Fixture', 5, 1000),
      gridTitle(orders, 'Fixture', 13, 1000),
      gridTitle(orders, 'Other', 13, 1000),
      gridTitle(orders, 'Fixture', undefined, 1000),
    ];
    expect(new Set(grid).size).toBe(4);
    expect(grid[0]).toContain('sales.orders');
    expect(grid[0]).toContain('Fixture');
    expect(grid[0]).toContain('@5');
    expect(grid[3]).toContain('latest');

    const changes = [
      changesTitle(customers, 'Lake', { from: 16, to: 18 }),
      changesTitle(customers, 'Lake', { from: 0, to: 1 }),
      changesTitle(customers, 'Data lake', { from: 16, to: 18 }),
    ];
    expect(new Set(changes).size).toBe(3);
    expect(changes[0]).toContain('shop.customers');
    expect(changes[0]).toContain('@16');
    expect(changes[0]).toContain('@18');
    expect(changes[0]).toContain('Lake');
  });

  it('give the changes a key per table, connection and range that never equals the key of the rows of the table', () => {
    const range = { from: 16, to: 18 };
    expect(changesKey(customers, range)).toBe(changesKey({ ...customers }, { ...range }));

    const keys = [
      changesKey(customers, range),
      changesKey(customers, { from: 17, to: 18 }),
      changesKey(customers, { from: 16, to: 19 }),
      changesKey(customers, { from: 1, to: 23 }),
      changesKey(customers, { from: 12, to: 3 }),
      changesKey({ ...customers, connectionId: 'b' }, range),
      changesKey({ ...customers, table: { schema: 'shop', table: 'events' } }, range),
      gridKey(customers, 18),
      gridKey(customers, undefined),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('resolveTarget', () => {
  const confirmed: string[] = [];
  const target = () =>
    resolveTarget({
      store: { get: (id) => (id === profile.id ? profile : undefined) },
      confirm: (asked) => {
        confirmed.push(asked.name);
        return Promise.resolve();
      },
      state: (id) => tree.state(id),
    });

  beforeEach(() => {
    confirmed.length = 0;
  });

  it('asks nothing for a table and returns its relation, connection and state; returns nothing for no node, a node that is no table or view, and a connection that is gone', async () => {
    await tree.connect('fixture');
    const resolve = target();

    const found = await resolve(await nodeAt('sales', 'Tables', 'orders'));

    expect(found?.relation).toEqual({
      connectionId: 'fixture',
      kind: 'table',
      table: { schema: 'sales', table: 'orders' },
    });
    expect(found?.profile).toBe(profile);
    expect(found?.state).toEqual(tree.state('fixture'));
    expect(found?.state.status).toBe('connected');
    expect(confirmed).toEqual([]);

    const gone = resolveTarget({
      store: { get: () => undefined },
      confirm: () => Promise.resolve(),
      state: (id) => tree.state(id),
    });
    expect(await resolve(undefined)).toBeUndefined();
    expect(await resolve(await nodeAt('sales'))).toBeUndefined();
    expect(await gone(await nodeAt('sales', 'Tables', 'orders'))).toBeUndefined();
    expect(confirmed).toEqual([]);
  });

  it('asks the user before a view is returned; a decline rejects with ABORTED and still resolves a table, which asks nothing', async () => {
    const found = await target()(await nodeAt('sales', 'Views', 'big_orders'));
    expect(found?.relation.kind).toBe('view');
    expect(confirmed).toEqual(['Fixture']);

    const declining = resolveTarget({
      store: { get: () => profile },
      confirm: () => Promise.reject(new AantjeError('ABORTED', 'Declined.')),
      state: (id) => tree.state(id),
    });
    await expect(declining(await nodeAt('sales', 'Views', 'big_orders'))).rejects.toMatchObject({
      code: 'ABORTED',
    });
    await expect(declining(await nodeAt('sales', 'Tables', 'orders'))).resolves.toMatchObject({
      relation: { kind: 'table' },
    });
  });

  it('keeps the state of the connection as it was when the user asked, although trusting reloads the tree', async () => {
    await tree.connect('fixture');
    const view = await nodeAt('sales', 'Views', 'big_orders');
    const reloading = resolveTarget({
      store: { get: () => profile },
      confirm: () => {
        tree.refresh();
        return Promise.resolve();
      },
      state: (id) => tree.state(id),
    });

    const found = await reloading(view);

    expect(tree.state('fixture').status).toBe('connecting');
    expect(found?.state).toMatchObject({ status: 'connected', latestSnapshot: LATEST_SNAPSHOT });
  });
});
