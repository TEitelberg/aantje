import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEPTHS,
  MAX_DEPTH,
  MAX_ISSUES,
  MAX_LAKE_ROWS,
  REASON_TEXT,
  brokenName,
  cards,
  dropImpact,
  edgeVerb,
  impactText,
  issuesOf,
  lakeRows,
  limitNote,
  nameAt,
  traverse,
} from '../../src/dependencies/model';
import type { DependenciesData } from '../../src/dependencies/model';
import { lakeData, objectData, readGraph } from '../../src/dependencies/read';
import { UNRESOLVED_REASONS } from '../../src/dependencies/graph';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID } from '../support/expected-history';
import { historyFixture } from '../support/sources/history';
import { MAIN, SHOP, addMacro, addView, sharedParser } from './dependencies-support';

const MAX_ROWS = 500;
const MAX_NAMES = 10;

const catalogs = editedCatalogs();
const parser = sharedParser();

/** A diamond above shop.events, a cycle of two views, a cycle of three macros, a view that reads itself and a broken one. */
const edits = [
  addView(100, SHOP, 'a', 'SELECT * FROM events'),
  addView(101, SHOP, 'b', 'SELECT * FROM a'),
  addView(102, SHOP, 'c', 'SELECT * FROM a'),
  addView(103, SHOP, 'd', 'SELECT * FROM b UNION ALL SELECT * FROM c'),
  addView(104, SHOP, 'e', 'SELECT * FROM d'),
  addView(105, SHOP, 'cyc1', 'SELECT * FROM cyc2'),
  addView(106, SHOP, 'cyc2', 'SELECT * FROM cyc1'),
  addView(107, SHOP, 'selfie', 'SELECT * FROM selfie'),
  addView(108, SHOP, 'gone', 'SELECT * FROM old_stuff, events'),
  addView(109, SHOP, 'spark', 'SELECT 1', 'spark'),
  ...addMacro(110, SHOP, 'm1', 'scalar', '(shop.m2(x))'),
  ...addMacro(111, SHOP, 'm2', 'scalar', '(shop.m3(x))'),
  ...addMacro(112, SHOP, 'm3', 'scalar', '(shop.m1(x))'),
  addView(113, MAIN, 'top', 'SELECT * FROM shop.e'),
];

let lake: DependenciesData;
let events: DependenciesData;
let top: DependenciesData;
let cyc1: DependenciesData;
let selfie: DependenciesData;
let m1: DependenciesData;
let gone: DependenciesData;

const rowsOf = (data: DependenciesData, direction: 'usedBy' | 'dependsOn', depth: number) =>
  traverse(data, data.target ?? 0, direction, depth).rows.map(
    (row) =>
      `${row.depth} ${nameAt(data, row.node)} ${edgeVerb(row.via, direction)} ${nameAt(data, row.parent)}`,
  );

beforeAll(async () => {
  const graph = await readGraph(await catalogs.open(historyFixture.sqlite, ...edits), parser, 56);
  lake = lakeData(graph, 'History', 56);
  const of = (kind: 'view' | 'table' | 'scalarMacro', id: number): DependenciesData => {
    const data = objectData(graph, 'History', 56, { kind, id });
    if (!data) {
      throw new Error(`No object ${kind} ${id}`);
    }
    return data;
  };
  events = of('table', HISTORY_ID.events);
  top = of('view', 113);
  cyc1 = of('view', 105);
  selfie = of('view', 107);
  m1 = of('scalarMacro', 110);
  gone = of('view', 108);
});
afterAll(async () => {
  await catalogs.dispose();
  await parser.dispose();
});

describe('the objects that use an object, level by level', () => {
  it('lists each object once where it is first reached, stops at the depth, and ends at cycles', () => {
    expect(rowsOf(events, 'usedBy', MAX_DEPTH)).toEqual([
      '1 shop.a reads shop.events',
      '2 shop.b reads shop.a',
      '3 shop.d reads shop.b',
      '4 shop.e reads shop.d',
      '5 main.top reads shop.e',
      '2 shop.c reads shop.a',
      '1 shop.big_events reads shop.events',
      '1 shop.gone reads shop.events',
      '1 shop.recent_events reads shop.events',
    ]);
    const shallow = traverse(events, events.target ?? 0, 'usedBy', 2);
    expect(shallow.rows.map((row) => nameAt(events, row.node))).toEqual([
      'shop.a',
      'shop.b',
      'shop.c',
      'shop.big_events',
      'shop.gone',
      'shop.recent_events',
    ]);
    expect(shallow.reached).toHaveLength(9);
    expect(rowsOf(top, 'dependsOn', MAX_DEPTH)).toEqual([
      '1 shop.e read by main.top',
      '2 shop.d read by shop.e',
      '3 shop.b read by shop.d',
      '4 shop.a read by shop.b',
      '5 shop.events read by shop.a',
      '3 shop.c read by shop.d',
    ]);

    expect(rowsOf(cyc1, 'usedBy', MAX_DEPTH)).toEqual(['1 shop.cyc2 reads shop.cyc1']);
    expect(traverse(cyc1, cyc1.target ?? 0, 'usedBy', MAX_DEPTH).cycle).toBe(true);
    expect(rowsOf(m1, 'usedBy', MAX_DEPTH)).toEqual(['1 shop.m3 calls shop.m1', '2 shop.m2 calls shop.m3']);
    expect(traverse(m1, m1.target ?? 0, 'dependsOn', MAX_DEPTH).cycle).toBe(true);
    expect(rowsOf(selfie, 'usedBy', MAX_DEPTH)).toEqual([]);
    expect(traverse(selfie, selfie.target ?? 0, 'usedBy', MAX_DEPTH).cycle).toBe(true);
    // A diamond is not a cycle.
    expect(traverse(events, events.target ?? 0, 'usedBy', MAX_DEPTH).cycle).toBe(false);
  });
});

describe('what a drop would break', () => {
  it('counts every view and macro that uses the table, directly or through others, by kind and by name', () => {
    const impact = dropImpact(events, events.target ?? 0);
    expect(impact.objects).toHaveLength(9);
    expect(impact.summary).toBe('8 views, 1 table macro');
    expect(impact.names).toEqual([
      'main.top',
      'shop.a',
      'shop.b',
      'shop.big_events',
      'shop.c',
      'shop.d',
      'shop.e',
      'shop.gone',
      'shop.recent_events',
    ]);
    expect(impact.more).toBe(0);
    expect(impactText('shop.events', impact)).toContain('9 objects');
    expect(dropImpact(top, top.target ?? 0).objects).toEqual([]);
  });

  it('names the first ten and counts the rest, and counts macros of each kind', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      addView(200 + i, SHOP, `w${String(i).padStart(2, '0')}`, 'SELECT * FROM events'),
    );
    const graph = await readGraph(await catalogs.open(historyFixture.sqlite, ...many), parser, 56);
    const data = objectData(graph, 'History', 56, { kind: 'table', id: HISTORY_ID.events });
    const impact = data && dropImpact(data, data.target ?? 0);
    expect(impact?.objects).toHaveLength(14);
    expect([impact?.names.length, impact?.more]).toEqual([10, 4]);

    const macros = await readGraph(
      await catalogs.open(
        historyFixture.sqlite,
        ...addMacro(400, SHOP, 'base_macro', 'scalar', '(1)'),
        ...addMacro(401, SHOP, 'one', 'scalar', '(shop.base_macro(x))'),
        ...addMacro(402, SHOP, 'two', 'scalar', '(shop.base_macro(x))'),
        ...addMacro(403, SHOP, 'rows', 'table', 'SELECT shop.base_macro(1)'),
      ),
      parser,
      56,
    );
    const base = objectData(macros, 'History', 56, { kind: 'scalarMacro', id: 400 });
    expect(base && dropImpact(base, base.target ?? 0).summary).toBe('2 scalar macros, 1 table macro');
    const single = objectData(macros, 'History', 56, { kind: 'scalarMacro', id: 401 });
    expect(single && dropImpact(single, single.target ?? 0).summary).toBe('');
  });
});

describe('the problems, the key figures and the list of the lake', () => {
  it('keeps the broken references and unresolved texts of the objects asked for, and writes broken names as they are looked for', () => {
    expect(issuesOf(lake).broken.map(({ name }) => name)).toEqual(['old_stuff']);
    expect(issuesOf(lake).unresolved.map(({ reason }) => reason)).toEqual(['dialect']);
    const spark = lake.nodes.findIndex(({ name }) => name === 'spark');
    expect(issuesOf(lake, new Set([spark])).broken).toEqual([]);
    expect(issuesOf(lake, new Set([spark])).unresolved).toHaveLength(1);
    expect(issuesOf(lake, new Set())).toEqual({ broken: [], unresolved: [] });

    expect(brokenName({ from: 0, kind: 'relation', schema: 'shop', name: 'old_stuff' })).toBe(
      'shop.old_stuff',
    );
    expect(brokenName({ from: 0, kind: 'scalarMacro', schema: '', name: 'legacy_fee' })).toBe('legacy_fee()');
    expect(brokenName({ from: 0, kind: 'tableMacro', schema: 'shop', name: 'rows' })).toBe('shop.rows()');
    expect(Object.keys(REASON_TEXT)).toEqual([...UNRESOLVED_REASONS]);
  });

  it('counts the objects next to an object and all behind it, the problems and the objects left unread', () => {
    const values = (data: DependenciesData) => cards(data).map(({ value, severity }) => [value, severity]);
    expect(values(events)).toEqual([
      ['4', 'ok'],
      ['0', 'ok'],
      ['1', 'warning'],
      ['0', 'ok'],
    ]);
    expect(cards(events)[0]?.detail).toContain('9');
    expect(cards(gone).map(({ value }) => value)).toEqual(['0', '1', '1', '0']);
    // main.top uses shop.e directly and five more through it.
    expect(cards(top)[1]?.value).toBe('1');
    expect(cards(top)[1]?.detail).toContain('6');
    expect(values(lake)).toEqual([
      [String(lake.nodes.length), 'ok'],
      [String(lake.edges.length), 'ok'],
      ['1', 'warning'],
      ['1', 'warning'],
    ]);
    expect(limitNote(lake)).toBeUndefined();
    expect(limitNote({ ...lake, objects: 2500, parsed: 2000 })).toContain('2,000');
  });

  it('puts the objects that most others use first, filters by name and kind regardless of case, and caps the lists', async () => {
    const { rows } = lakeRows(lake, '');
    expect(
      rows.slice(0, 3).map(({ node, usedBy, dependsOn }) => [nameAt(lake, node), usedBy, dependsOn]),
    ).toEqual([
      ['shop.events', 4, 0],
      ['shop.a', 2, 1],
      ['shop.b', 1, 1],
    ]);
    expect(lakeRows(lake, 'CYC').rows.map(({ node }) => nameAt(lake, node))).toEqual([
      'shop.cyc1',
      'shop.cyc2',
    ]);
    expect(lakeRows(lake, 'scalar macro').rows.map(({ node }) => nameAt(lake, node))).toEqual([
      'shop.m1',
      'shop.m2',
      'shop.m3',
    ]);
    expect(lakeRows(lake, '  cyc  ').rows).toHaveLength(2);
    expect(lakeRows(lake, 'no such thing')).toEqual({ rows: [], omitted: 0 });

    const views = Array.from({ length: 520 }, (_, i) =>
      addView(300 + i, SHOP, `w${i}`, 'SELECT * FROM events'),
    );
    const graph = await readGraph(await catalogs.open(historyFixture.sqlite, ...views), parser, 56);
    const wideLake = lakeData(graph, 'History', 56);
    const listedLake = lakeRows(wideLake, '');
    expect([listedLake.rows.length, listedLake.omitted]).toEqual([
      MAX_LAKE_ROWS,
      wideLake.nodes.length - MAX_LAKE_ROWS,
    ]);
    const target = objectData(graph, 'History', 56, { kind: 'table', id: HISTORY_ID.events });
    const listed = traverse(target ?? wideLake, target?.target ?? 0, 'usedBy', MAX_DEPTH);
    expect([listed.rows.length, listed.omitted, listed.reached.length]).toEqual([
      MAX_ROWS,
      522 - MAX_ROWS,
      522,
    ]);
  });
});

describe('the limits of the lists', () => {
  /** Objects that all use object 0, as the data of a report holds them. */
  const wide = (users: number): DependenciesData => ({
    connection: 'C',
    scope: { kind: 'lake' },
    snapshot: 1,
    target: 0,
    isolated: 0,
    objects: users,
    parsed: users,
    nodes: Array.from({ length: users + 1 }, (_, id) => ({
      kind: 'view' as const,
      id,
      schemaId: 1,
      schema: 's',
      name: `v${String(id).padStart(4, '0')}`,
    })),
    edges: Array.from({ length: users }, (_, index) => ({ from: index + 1, to: 0, kind: 'reads' as const })),
    broken: [],
    unresolved: [],
  });

  it('keeps the numbers that the documentation states and cuts at them, one over the limit included', () => {
    expect([MAX_ROWS, MAX_LAKE_ROWS, MAX_ISSUES, MAX_NAMES, MAX_DEPTH]).toEqual([500, 200, 100, 10, 5]);
    expect(DEPTHS).toEqual([1, 2, 3, 4, 5]);
    for (const [users, omitted] of [
      [500, 0],
      [501, 1],
    ] as const) {
      const listed = traverse(wide(users), 0, 'usedBy', 1);
      expect([listed.rows.length, listed.omitted], `${users} objects`).toEqual([
        Math.min(users, 500),
        omitted,
      ]);
    }
    for (const [users, omitted] of [
      [200, 0],
      [201, 1],
    ] as const) {
      const { rows, omitted: left } = lakeRows(wide(users - 1), '');
      expect([rows.length, left], `${users} lake objects`).toEqual([users - omitted, omitted]);
    }
    for (const [users, more] of [
      [10, 0],
      [11, 1],
    ] as const) {
      const impact = dropImpact(wide(users), 0);
      expect([impact.names.length, impact.more], `${users} names`).toEqual([Math.min(users, 10), more]);
    }
  });
});
