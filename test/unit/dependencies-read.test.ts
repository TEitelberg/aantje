import { afterAll, describe, expect, it } from 'vitest';
import type { CatalogReader } from '../../src/catalog/model';
import { lakeData, objectData, readGraph } from '../../src/dependencies/read';
import type { SqlParser } from '../../src/dependencies/parser';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID } from '../support/expected-history';
import { historyFixture } from '../support/sources/history';
import { SHOP, addMacro, addView, edgeList, nameOf, sharedParser } from './dependencies-support';

const catalogs = editedCatalogs();
const parser = sharedParser();
afterAll(async () => {
  await catalogs.dispose();
  await parser.dispose();
});

/** The real parser, with a count of the texts that were parsed and a hook that runs before each one. */
function counting(onParse?: () => void): { readonly parser: SqlParser; readonly parsed: () => number } {
  let calls = 0;
  return {
    parser: {
      serialize: (sql) => {
        calls++;
        onParse?.();
        return parser.serialize(sql);
      },
      functions: () => parser.functions(),
      dispose: () => Promise.resolve(),
    },
    parsed: () => calls,
  };
}

/** Lets a read that was not stopped run on, so that a count taken afterwards shows it. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200));

describe('the graph of a snapshot is read once', () => {
  it('parses each view and macro once per snapshot and connection, and keeps the last three snapshots', async () => {
    const reader = await catalogs.open(historyFixture.sqlite);
    const { parser: counted, parsed } = counting();
    const first = await readGraph(reader, counted, 56);
    expect(parsed()).toBe(3);
    const second = await readGraph(reader, counted, 56);
    expect([second, parsed()]).toEqual([first, 3]);
    await readGraph(reader, counted, 41);
    expect(parsed()).toBe(3 + 2);
    await readGraph(await catalogs.open(historyFixture.sqlite), counted, 56);
    expect(parsed()).toBe(3 + 2 + 3);

    const lru = await catalogs.open(historyFixture.sqlite, addView(100, SHOP, 'v_one', 'SELECT 1'));
    const { parser: lruCounted, parsed: lruParsed } = counting();
    /** Whether reading the snapshot parsed anything. */
    const parses = async (snapshot: number): Promise<boolean> => {
      const before = lruParsed();
      await readGraph(lru, lruCounted, snapshot);
      return lruParsed() > before;
    };
    expect([await parses(41), await parses(42), await parses(43)]).toEqual([true, true, true]);
    expect(await parses(41)).toBe(false);
    expect(await parses(44)).toBe(true);
    // 42 was used longest ago, so it went; 41, 43 and 44 are still there.
    expect([await parses(41), await parses(43), await parses(44)]).toEqual([false, false, false]);
    expect(await parses(42)).toBe(true);
  });

  it('does not keep a read that failed or was cancelled, so the next one starts again', async () => {
    const real = await catalogs.open(historyFixture.sqlite);
    let failures = 1;
    const failing: CatalogReader = {
      ...real,
      schemas: (snapshot) => {
        if (failures-- > 0) {
          return Promise.reject(new Error('The catalog is gone.'));
        }
        return real.schemas(snapshot);
      },
    };
    const { parser: counted } = counting();
    await expect(readGraph(failing, counted, 56)).rejects.toThrow('The catalog is gone.');
    expect(edgeList(await readGraph(failing, counted, 56))).toHaveLength(2);

    const reader = await catalogs.open(historyFixture.sqlite);
    const abort = new AbortController();
    abort.abort();
    await expect(readGraph(reader, parser, 56, abort.signal)).rejects.toThrow();
    expect(edgeList(await readGraph(reader, parser, 56))).toHaveLength(2);

    const next = await catalogs.open(historyFixture.sqlite);
    const once = new AbortController();
    const cancelled = readGraph(next, parser, 56, once.signal);
    once.abort();
    const following = readGraph(next, parser, 56);
    await expect(cancelled).rejects.toThrow();
    expect(edgeList(await following)).toHaveLength(2);
  });
});

describe('cancelling a read', () => {
  it('stops parsing and reading the catalog when the caller cancels', async () => {
    const reader = await catalogs.open(historyFixture.sqlite);
    const abort = new AbortController();
    const { parser: counted, parsed } = counting(() => abort.abort());
    await expect(readGraph(reader, counted, 56, abort.signal)).rejects.toThrow();
    await settle();
    expect(parsed()).toBe(1);

    const real = await catalogs.open(historyFixture.sqlite);
    const stop = new AbortController();
    let schemaReads = 0;
    const catalog: CatalogReader = {
      ...real,
      entries: (snapshot) => {
        stop.abort();
        return real.entries(snapshot);
      },
      macros: (schemaId, snapshot) => {
        schemaReads++;
        return real.macros(schemaId, snapshot);
      },
    };
    await expect(readGraph(catalog, parser, 56, stop.signal)).rejects.toThrow();
    await settle();
    expect(schemaReads).toBe(0);
  });

  it('keeps the read for the callers that still wait, and stops it when every caller has cancelled', async () => {
    const reader = await catalogs.open(historyFixture.sqlite);
    const { parser: counted, parsed } = counting();
    const first = new AbortController();
    const cancelled = readGraph(reader, counted, 56, first.signal);
    const kept = readGraph(reader, counted, 56);
    first.abort();
    await expect(cancelled).rejects.toThrow();
    expect(edgeList(await kept)).toHaveLength(2);
    expect(parsed()).toBe(3);

    const joined = await catalogs.open(historyFixture.sqlite);
    const second = new AbortController();
    const owner = readGraph(joined, parser, 56);
    const joiner = readGraph(joined, parser, 56, second.signal);
    second.abort();
    await expect(joiner).rejects.toThrow();
    expect(edgeList(await owner)).toHaveLength(2);

    const all = await catalogs.open(historyFixture.sqlite);
    const abort = new AbortController();
    const { parser: allCounted, parsed: allParsed } = counting();
    const one = readGraph(all, allCounted, 56, abort.signal);
    const two = readGraph(all, allCounted, 56, abort.signal);
    abort.abort();
    await expect(Promise.allSettled([one, two])).resolves.toMatchObject([
      { status: 'rejected' },
      { status: 'rejected' },
    ]);
    await settle();
    expect(allParsed()).toBe(0);
    expect(edgeList(await readGraph(all, allCounted, 56))).toHaveLength(2);
    expect(allParsed()).toBe(3);
  });
});

describe('the data of the report', () => {
  const edits = [
    addView(100, SHOP, 'v_over_big', 'SELECT * FROM big_events'),
    addView(101, SHOP, 'v_top', 'SELECT * FROM v_over_big'),
    addView(102, SHOP, 'v_gone', 'SELECT * FROM shop.old_stuff'),
    addView(103, SHOP, 'v_unrelated', 'SELECT 1'),
    addView(104, SHOP, 'v_spark', 'SELECT 1', 'spark'),
    ...addMacro(105, SHOP, 'over_gross', 'scalar', '(shop.gross(x) * 2)'),
  ];

  it('holds for one object every object with dependencies but only the problems it reaches, and for the lake what belongs to it', async () => {
    const graph = await readGraph(await catalogs.open(historyFixture.sqlite, ...edits), parser, 56);
    const data = objectData(graph, 'History', 56, { kind: 'view', id: 100 });
    if (!data) {
      throw new Error('The view is there.');
    }
    const lake = lakeData(graph, 'History', 56);
    // The graph shows them all on Show all.
    expect(data.nodes).toEqual(lake.nodes);
    expect(data.edges).toEqual(lake.edges);
    expect(nameOf(data, data.target ?? -1)).toBe('shop.v_over_big');
    // The issues of the objects it does not reach stay out of this report.
    expect([data.broken, data.unresolved]).toEqual([[], []]);
    expect([data.connection, data.snapshot, data.isolated]).toEqual(['History', 56, 0]);

    const gone = objectData(graph, 'History', 56, { kind: 'view', id: 102 });
    expect(gone?.broken.map(({ from, name }) => [nameOf(gone, from), name])).toEqual([
      ['shop.v_gone', 'old_stuff'],
    ]);
    const spark = objectData(graph, 'History', 56, { kind: 'view', id: 104 });
    expect(spark?.unresolved.map(({ reason, detail }) => [reason, detail])).toEqual([['dialect', 'spark']]);

    const macro = objectData(graph, 'History', 56, { kind: 'scalarMacro', id: HISTORY_ID.grossMacro });
    expect(macro && nameOf(macro, macro.target ?? -1)).toBe('shop.gross');

    const plain = await readGraph(await catalogs.open(historyFixture.sqlite), parser, 56);
    expect(objectData(plain, 'History', 56, { kind: 'view', id: HISTORY_ID.tmpView })).toBeUndefined();
    expect(objectData(plain, 'History', 56, { kind: 'table', id: HISTORY_ID.bigEventsView })).toBeUndefined();

    expect(lake.nodes.map((node) => `${node.schema}.${node.name}`)).toEqual([
      'shop.big_events',
      'shop.events',
      'shop.gross',
      'shop.over_gross',
      'shop.recent_events',
      'shop.v_gone',
      'shop.v_over_big',
      'shop.v_spark',
      'shop.v_top',
    ]);
    expect(lake.target).toBeNull();
    expect(lake.isolated).toBe(graph.nodes.length - lake.nodes.length);
    // v_unrelated reads nothing and nothing reads it: it is counted, not listed.
    expect(lake.nodes.some(({ name }) => name === 'v_unrelated')).toBe(false);
    expect(lake.edges).toHaveLength(graph.edges.length);
  });
});
