import { afterEach, describe, expect, it, vi } from 'vitest';
import { LATEST_SNAPSHOT } from '../support/expected';
import { openDuckdb } from '../../src/catalog/drivers/duckdb';
import { createCatalogReader } from '../../src/catalog/reader';
import { catalogOfReader, nameOf } from '../../src/sql/catalog';
import { createLake, engineSkipReason } from './data-support';
import { openHistory, openSales } from './sql-language-support';
import type { OpenCatalog } from './sql-language-support';

const skipReason = await engineSkipReason();

const opened: OpenCatalog[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((catalog) => catalog.close()));
});

async function sales(snapshot = LATEST_SNAPSHOT): Promise<OpenCatalog> {
  const catalog = await openSales(snapshot);
  opened.push(catalog);
  return catalog;
}

describe('the catalog of a reader', () => {
  it('lists the schemas, and the tables and views of all schemas, at the snapshot', async () => {
    const { catalog } = await sales();
    expect((await catalog.schemas()).map(({ name }) => name)).toEqual(['main', 'sales']);
    expect((await catalog.entries()).map((entry) => [entry.kind, entry.schema.name, nameOf(entry)])).toEqual([
      ['table', 'main', 'plain'],
      ['table', 'sales', 'orders'],
      ['view', 'sales', 'big_orders'],
    ]);
    const earlier = (await sales(5)).catalog;
    expect((await earlier.entries()).map((entry) => [entry.kind, entry.schema.name, nameOf(entry)])).toEqual([
      ['table', 'sales', 'orders'],
      ['table', 'sales', 'tmp'],
    ]);
  });

  it('gives the columns of a table by names, ignoring the case, and none for a view or an unknown name', async () => {
    const { catalog } = await sales();
    expect((await catalog.columns('sales', 'orders')).map(({ name }) => name)).toEqual([
      'id',
      'customer',
      'attrs',
      'amount',
      'created',
    ]);
    expect((await catalog.columns('SALES', 'Orders')).map(({ name }) => name)).toHaveLength(5);
    expect(await catalog.columns('sales', 'big_orders')).toEqual([]);
    expect(await catalog.columns('sales', 'nowhere')).toEqual([]);
    expect(await catalog.columns('nowhere', 'orders')).toEqual([]);
  });

  it.skipIf(skipReason)(
    'keeps the columns of table "c" in schema "a.b" apart from those of table "b.c" in schema "a"',
    async () => {
      const lake = await createLake([
        'CREATE SCHEMA "a.b"',
        'CREATE TABLE "a.b".c (inner_column INTEGER)',
        'CREATE SCHEMA a',
        'CREATE TABLE a."b.c" (outer_column VARCHAR, second_column INTEGER)',
      ]);
      const reader = createCatalogReader(await openDuckdb({ path: lake.profile.path }));
      try {
        const { latestSnapshot } = await reader.info();
        const catalog = catalogOfReader(reader, latestSnapshot);

        const outer = await catalog.columns('a', 'b.c');
        const inner = await catalog.columns('a.b', 'c');

        expect(outer.map(({ name }) => name)).toEqual(['outer_column', 'second_column']);
        expect(inner.map(({ name }) => name)).toEqual(['inner_column']);
      } finally {
        await reader.close();
        await lake.remove();
      }
    },
  );

  it('gives the macros of a schema, the snapshots newest first, and the name of the lake', async () => {
    const history = await openHistory();
    opened.push(history);
    expect(history.catalog.lake).toBe('lake');
    expect((await history.catalog.macros('shop')).map(({ name, kind }) => [name, kind])).toEqual([
      ['gross', 'scalar'],
      ['recent_events', 'table'],
    ]);
    expect(await history.catalog.macros('main')).toEqual([]);
    expect(await history.catalog.macros('nowhere')).toEqual([]);
    const ids = (await history.catalog.snapshots()).map(({ id }) => id);
    expect(ids[0]).toBe(56);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it('gives the lake at another snapshot, keeping a few of them, and the partitioning and sort order of a table', async () => {
    const { catalog } = await sales();
    const early = catalog.at(5);
    expect(catalog.at(5)).toBe(early);
    expect(catalog.at(LATEST_SNAPSHOT)).toBe(catalog);
    expect(early.at(LATEST_SNAPSHOT)).toBe(catalog);
    expect((await early.entries()).map(nameOf)).toEqual(['orders', 'tmp']);
    for (const snapshot of [1, 2, 3, 4]) catalog.at(snapshot);
    expect(catalog.at(5)).not.toBe(early);

    const history = await openHistory();
    opened.push(history);
    const events = await history.catalog.layout('shop', 'events');
    expect(events.partitioning?.columns.map(({ path, transform }) => [path.join('.'), transform])).toEqual([
      ['kind', 'identity'],
      ['ts', 'month'],
    ]);
    expect((await history.catalog.layout('shop', 'readings')).sortOrder?.expressions).toHaveLength(1);
    expect(await history.catalog.layout('shop', 'big_events')).toEqual({
      partitioning: undefined,
      sortOrder: undefined,
    });
  });

  it('reads every thing once at the snapshot it was made for, and tries again after a failed read', async () => {
    const { catalog, reader } = await sales(7);
    const tables = vi.spyOn(reader, 'tables').mockRejectedValueOnce(new Error('the database is busy'));
    const views = vi.spyOn(reader, 'views');
    const columns = vi.spyOn(reader, 'columns');
    const snapshots = vi.spyOn(reader, 'snapshots');

    await expect(catalog.entries()).rejects.toThrow('busy');
    expect(tables).toHaveBeenCalled();
    tables.mockClear();
    views.mockClear();
    for (let round = 0; round < 3; round += 1) {
      await catalog.entries();
      await catalog.columns('sales', 'orders');
      await catalog.snapshots();
    }

    expect(tables).toHaveBeenCalledTimes(2);
    expect(views).toHaveBeenCalledTimes(2);
    expect(columns).toHaveBeenCalledTimes(1);
    expect(columns).toHaveBeenCalledWith(expect.any(Number), 7);
    expect(snapshots).toHaveBeenCalledTimes(1);
  });
});
