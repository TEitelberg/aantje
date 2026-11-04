import { afterAll, describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/dependencies/graph';
import type { SqlParser } from '../../src/dependencies/parser';
import { readObjects } from '../../src/dependencies/read';
import { editedCatalogs } from '../support/edited-catalog';
import { historyFixture } from '../support/sources/history';
import { HISTORY_SNAPSHOT } from '../support/expected-history';
import {
  MAIN,
  SHOP,
  addMacro,
  addView,
  brokenList,
  edgeList,
  graphOf,
  nameOf,
  sharedParser,
  unresolvedList,
} from './dependencies-support';

const MAX_SQL_LENGTH = 200_000;

const catalogs = editedCatalogs();
const parser = sharedParser();
afterAll(async () => {
  await catalogs.dispose();
  await parser.dispose();
});

const names = (graph: Awaited<ReturnType<typeof graphOf>>): string[] =>
  graph.nodes.map(({ kind, schema, name }) => `${kind} ${schema}.${name}`);

describe('the dependencies of the history fixture', () => {
  it('finds the view and the table macro that read shop.events, and reads a dropped view and macro at their snapshot', async () => {
    const reader = await catalogs.open(historyFixture.sqlite);
    const graph = await graphOf(reader, parser);
    expect(names(graph)).toEqual([
      'table main.evolved',
      'table shop.audit',
      'view shop.big_events',
      'table shop.customers',
      'table shop.events',
      'scalarMacro shop.gross',
      'table shop.log',
      'table shop.notes',
      'table shop.readings',
      'tableMacro shop.recent_events',
    ]);
    expect(edgeList(graph)).toEqual([
      'shop.big_events reads shop.events',
      'shop.recent_events reads shop.events',
    ]);
    expect([brokenList(graph), unresolvedList(graph)]).toEqual([[], []]);
    expect([graph.objects, graph.parsed]).toEqual([3, 3]);

    const objectsAt = async (snapshot: number) => {
      const then = await graphOf(reader, parser, undefined, snapshot);
      return [names(then).filter((name) => /^(view|scalarMacro|tableMacro) /.test(name)), edgeList(then)];
    };
    expect(await objectsAt(HISTORY_SNAPSHOT.createTmpView)).toEqual([
      ['view shop.big_events', 'view shop.tmp_view'],
      ['shop.big_events reads shop.events'],
    ]);
    expect(await objectsAt(HISTORY_SNAPSHOT.createLegacyFeeMacro)).toEqual([
      [
        'view shop.big_events',
        'scalarMacro shop.gross',
        'scalarMacro shop.legacy_fee',
        'tableMacro shop.recent_events',
      ],
      ['shop.big_events reads shop.events', 'shop.recent_events reads shop.events'],
    ]);
  });
});

describe('how the SQL of views and macros is followed in an edited copy of the history fixture', () => {
  const edits = [
    // Chains: a view of a view, in the same schema (unqualified), and a view of that.
    addView(100, SHOP, 'v_chain1', 'SELECT * FROM big_events'),
    addView(101, SHOP, 'v_chain2', 'SELECT * FROM v_chain1'),
    // Own schema first, then main: `evolved` is a table of main and, in shop, also a view.
    addView(102, SHOP, 'evolved', 'SELECT 1 AS x'),
    addView(103, SHOP, 'v_shop_evolved', 'SELECT * FROM evolved'),
    addView(104, MAIN, 'v_main_evolved', 'SELECT * FROM evolved'),
    addView(105, SHOP, 'v_falls_back_to_main', 'SELECT * FROM v_main_evolved'),
    // A table that was dropped, a macro that was dropped, a view that was dropped.
    addView(106, SHOP, 'v_dropped_table', 'SELECT * FROM shop.old_stuff'),
    addView(107, SHOP, 'v_dropped_macro', 'SELECT legacy_fee(amount) FROM events'),
    addView(108, SHOP, 'v_dropped_view', 'SELECT * FROM tmp_view'),
    // A CTE hides the table of the same name, unless it is the one the CTE itself reads.
    addView(109, SHOP, 'v_cte_hides', 'WITH events AS (SELECT 1 AS a) SELECT * FROM events'),
    addView(110, SHOP, 'v_cte_reads', 'WITH events AS (SELECT * FROM events) SELECT * FROM events'),
    // Joins, subqueries, set operations, lateral subqueries, table functions and macros in one statement.
    addView(
      111,
      SHOP,
      'v_wide',
      `WITH recent AS (SELECT * FROM recent_events(5))
       SELECT e.id, gross(e.amount) FROM events e
         JOIN customers c ON c.id = e.id
         LEFT JOIN (SELECT * FROM readings) r ON true,
         LATERAL (SELECT * FROM audit WHERE audit.id = e.id) a
       WHERE e.id IN (SELECT id FROM notes) AND EXISTS (SELECT 1 FROM range(3))
       UNION ALL SELECT id, 0 FROM recent
       INTERSECT SELECT id, 0 FROM generate_series(1, 2) s(id)`,
    ),
    // Names of the lake as the writer spelled them; a built-in and a function of another schema are not broken.
    addView(112, SHOP, 'V_Upper', 'SELECT * FROM SHOP.EVENTS'),
    addView(113, SHOP, 'v_calls_upper', 'SELECT SHOP.GROSS(1), Gross(2), main.abs(3), shop.nothere(4)'),
    // A view that reads itself, and macros that call each other.
    addView(114, SHOP, 'v_self', 'SELECT * FROM shop.v_self'),
    ...addMacro(115, SHOP, 'ma', 'scalar', '(shop.mb(x) + 1)'),
    ...addMacro(116, SHOP, 'mb', 'scalar', '(shop.ma(x) + 1)'),
    // Macros with the lake under a name, another catalog, a subquery, a table macro with a table function.
    ...addMacro(117, SHOP, 'm_lake', 'table', 'SELECT * FROM lake.shop.events'),
    ...addMacro(118, SHOP, 'm_alias', 'table', 'SELECT * FROM mylake.shop.customers'),
    ...addMacro(119, SHOP, 'm_other', 'table', 'SELECT * FROM memory.main.x, other.shop.nothere'),
    // `memory` is never the lake, also not when the lake has a table of that name.
    ...addMacro(132, SHOP, 'm_memory', 'table', 'SELECT * FROM memory.main.evolved'),
    ...addMacro(120, SHOP, 'm_sub', 'scalar', '((SELECT count(*) FROM shop.events) + x)'),
    // A macro looks a name up in main first: `evolved` is the table of main.
    ...addMacro(121, SHOP, 'm_unqualified', 'table', 'SELECT * FROM evolved'),
    // Text that cannot be followed.
    addView(122, SHOP, 'v_spark', 'SELECT * FROM `shop`.`events`', 'spark'),
    addView(123, SHOP, 'v_not_select', 'DROP TABLE shop.events'),
    addView(124, SHOP, 'v_syntax', 'SELEC * FROM shop.events'),
    addView(
      125,
      SHOP,
      'v_file',
      "SELECT * FROM 'data/events.parquet', duckdb_tables, information_schema.tables",
    ),
    addView(126, SHOP, 'v_dynamic', "SELECT * FROM query_table('events')"),
    ...addMacro(127, SHOP, 'm_injection', 'scalar', 'x); DROP TABLE shop.events; --'),
    ...addMacro(128, SHOP, 'm_dialect', 'scalar', 'x', 'postgres'),
    // Hostile names.
    addView(129, SHOP, `we"ird ü; DROP TABLE x; --`, 'SELECT * FROM "shop"."events"'),
    addView(130, SHOP, 'select', 'SELECT * FROM shop."we""ird ü; DROP TABLE x; --"'),
    addView(131, SHOP, 'v_reserved', 'SELECT * FROM shop."select" JOIN "SHOP"."V_UPPER" USING (x)'),
    // Every overload of a macro is read; a scalar and a table macro of one name are told apart.
    ...addMacro(140, SHOP, 'ov', 'scalar', '(x)'),
    `INSERT INTO ducklake_macro_impl VALUES (140, 1, 'duckdb', '((SELECT count(*) FROM shop.events) + x)', 'scalar')`,
    `INSERT INTO ducklake_macro_impl VALUES (140, 2, 'duckdb', '((SELECT count(*) FROM shop.notes) + x)', 'scalar')`,
    ...addMacro(141, SHOP, 'twin', 'scalar', '(shop.gross(x))'),
    ...addMacro(142, SHOP, 'twin', 'table', 'SELECT * FROM shop.events'),
    addView(143, SHOP, 'v_twin', 'SELECT shop.twin(1) FROM shop.twin(2)'),
    // The body of a macro stays inside its own expression.
    ...addMacro(144, SHOP, 'esc', 'scalar', '1 UNION SELECT 1 FROM shop.events'),
    // The system and temp catalogs are never the lake; DuckDB's schemas are not broken.
    addView(145, SHOP, 'v_system', 'SELECT * FROM system.shop.events'),
    addView(146, SHOP, 'v_temp', 'SELECT * FROM temp.shop.events'),
    addView(147, SHOP, 'v_pg', 'SELECT * FROM pg_catalog.pg_tables, INFORMATION_SCHEMA.TABLES'),
    // A path, a URL and a name with a file extension in any case are files.
    addView(148, SHOP, 'v_f1', "SELECT * FROM 's3://bucket/data'"),
    addView(149, SHOP, 'v_f2', "SELECT * FROM 'x.PARQUET'"),
    addView(150, SHOP, 'v_f3', "SELECT * FROM 'x.json.gz'"),
    addView(151, SHOP, 'v_f4', "SELECT * FROM 'x.jsonl'"),
    addView(152, SHOP, 'v_f5', "SELECT * FROM 'dir\\x'"),
    // Broken only when a table or macro of the lake is missing; a broken name once, whatever its case.
    addView(155, SHOP, 'v_m1', 'SELECT SHOP.nothere(1)'),
    addView(156, SHOP, 'v_m2', 'SELECT ABS(1), Sum(2) FROM events'),
    addView(157, SHOP, 'v_m3', 'SELECT zzz.f(1)'),
    addView(158, SHOP, 'v_m4', 'SELECT memory.main.gross(1)'),
    addView(159, SHOP, 'v_m5', 'SELECT * FROM abs'),
    addView(160, SHOP, 'v_m6', 'SELECT * FROM DUCKDB_TABLES'),
    addView(161, SHOP, 'v_m7', 'SELECT main.nothere(1)'),
    addView(162, SHOP, 'v_b', 'SELECT * FROM shop.GONE, shop.gone, SHOP.gone'),
    // Two statements are not one SELECT; the functions that look a table up at run time, however written.
    addView(163, SHOP, 'v_two', 'SELECT 1; SELECT * FROM shop.events'),
    addView(164, SHOP, 'v_q1', "SELECT * FROM query('select 1')"),
    addView(165, SHOP, 'v_q2', "SELECT * FROM QUERY_TABLE('events')"),
    // A CTE name is compared without regard to case.
    addView(166, SHOP, 'v_c1', 'WITH Events AS (SELECT 1) SELECT * FROM events'),
    addView(167, SHOP, 'v_c2', 'WITH events AS (SELECT 1) SELECT * FROM EVENTS'),
    addView(168, SHOP, 'v_c3', 'WITH ZEVENTS AS (SELECT 1) SELECT * FROM zevents'),
    // Nodes are ordered by name without regard to case.
    addView(153, SHOP, 'B_view', 'SELECT 1'),
    addView(154, SHOP, 'a_view', 'SELECT 1'),
  ];

  const open = async () => graphOf(await catalogs.open(historyFixture.sqlite, ...edits), parser);

  it('resolves every name to the exact set of edges: chains, own schema before main, CTEs, case, cycles, aliases of the lake, overloads and hostile names', async () => {
    const graph = await open();
    expect(edgeList(graph)).toEqual([
      'main.v_main_evolved reads main.evolved',
      'shop.V_Upper reads shop.events',
      'shop.big_events reads shop.events',
      'shop.m_alias reads shop.customers',
      'shop.m_lake reads shop.events',
      'shop.m_sub reads shop.events',
      'shop.m_unqualified reads main.evolved',
      'shop.ma calls shop.mb',
      'shop.mb calls shop.ma',
      'shop.ov reads shop.events',
      'shop.ov reads shop.notes',
      'shop.recent_events reads shop.events',
      'shop.select reads shop.we"ird ü; DROP TABLE x; --',
      'shop.twin calls shop.gross',
      'shop.twin reads shop.events',
      'shop.v_calls_upper calls shop.gross',
      'shop.v_chain1 reads shop.big_events',
      'shop.v_chain2 reads shop.v_chain1',
      'shop.v_cte_reads reads shop.events',
      'shop.v_dropped_macro reads shop.events',
      'shop.v_falls_back_to_main reads main.v_main_evolved',
      'shop.v_m2 reads shop.events',
      'shop.v_reserved reads shop.V_Upper',
      'shop.v_reserved reads shop.select',
      'shop.v_self reads shop.v_self',
      'shop.v_shop_evolved reads shop.evolved',
      'shop.v_twin calls shop.twin',
      'shop.v_twin calls shop.twin',
      'shop.v_wide calls shop.gross',
      'shop.v_wide calls shop.recent_events',
      'shop.v_wide reads shop.audit',
      'shop.v_wide reads shop.customers',
      'shop.v_wide reads shop.events',
      'shop.v_wide reads shop.notes',
      'shop.v_wide reads shop.readings',
      'shop.we"ird ü; DROP TABLE x; -- reads shop.events',
    ]);
    // A scalar and a table macro of one name are two nodes, and a view that calls both reaches both.
    expect(graph.nodes.filter(({ name }) => name === 'twin').map(({ kind }) => kind)).toEqual([
      'scalarMacro',
      'tableMacro',
    ]);
    expect(
      graph.edges
        .filter(({ from }) => nameOf(graph, from) === 'shop.v_twin')
        .map(({ to }) => graph.nodes[to]?.kind)
        .toSorted(),
    ).toEqual(['scalarMacro', 'tableMacro']);
    expect(graph.nodes.map(({ name }) => name).filter((name) => /^[aB]_view$/.test(name))).toEqual([
      'a_view',
      'B_view',
    ]);
  });

  it('lists the exact broken references and the texts it cannot follow with their reason, each numbered with its node', async () => {
    const graph = await open();
    expect(brokenList(graph)).toEqual([
      'shop.v_b: table SHOP.gone',
      'shop.v_calls_upper: macro shop.nothere',
      'shop.v_dropped_macro: macro legacy_fee',
      'shop.v_dropped_table: table shop.old_stuff',
      'shop.v_dropped_view: table shop.tmp_view',
      'shop.v_m1: macro SHOP.nothere',
      'shop.v_m5: table shop.abs',
      'shop.v_m7: macro main.nothere',
    ]);
    expect(unresolvedList(graph)).toEqual([
      'shop.esc: syntax syntax error at or near "UNION"',
      'shop.m_dialect: dialect postgres',
      'shop.m_injection: syntax syntax error at or near ")"',
      'shop.m_memory: catalog memory.main.evolved',
      'shop.m_other: catalog memory.main.x',
      'shop.m_other: catalog other.shop.nothere',
      'shop.v_dynamic: dynamic query_table',
      'shop.v_f1: file s3://bucket/data',
      'shop.v_f2: file x.PARQUET',
      'shop.v_f3: file x.json.gz',
      'shop.v_f4: file x.jsonl',
      'shop.v_f5: file dir\\x',
      'shop.v_file: file data/events.parquet',
      'shop.v_not_select: unsupported Only SELECT statements can be serialized to json!',
      'shop.v_q1: dynamic query',
      'shop.v_q2: dynamic query_table',
      'shop.v_spark: dialect spark',
      'shop.v_syntax: syntax syntax error at or near "SELEC"',
      'shop.v_system: catalog system.shop.events',
      'shop.v_temp: catalog temp.shop.events',
      'shop.v_two: unsupported the text is not exactly one SELECT statement',
    ]);
    for (const index of [
      ...graph.edges.flatMap(({ from, to }) => [from, to]),
      ...graph.broken.map(({ from }) => from),
      ...graph.unresolved.map(({ node }) => node),
    ]) {
      expect(graph.nodes[index]).toBeDefined();
    }
    expect(new Set(graph.edges.map(({ from, to, kind }) => `${from}|${to}|${kind}`)).size).toBe(
      graph.edges.length,
    );
  });
});

describe('where a macro looks a name up', () => {
  it('follows a name in main, where the SQL editor of aantje calls the macro from; a name only its own schema has is not followed, and one nowhere is broken', async () => {
    const graph = await graphOf(
      await catalogs.open(
        historyFixture.sqlite,
        // main and shop both have these, and shop has what main has not.
        addView(100, MAIN, 'evolved_view', 'SELECT 1 AS x'),
        addView(101, SHOP, 'evolved_view', 'SELECT 2 AS x'),
        ...addMacro(102, MAIN, 'dual', 'scalar', '(1)'),
        ...addMacro(103, SHOP, 'dual', 'scalar', '(2)'),
        ...addMacro(104, SHOP, 'only_shop', 'scalar', '(3)'),
        ...addMacro(105, SHOP, 'calls_both', 'scalar', '(dual(x))'),
        ...addMacro(106, SHOP, 'calls_only_shop', 'scalar', '(only_shop(x))'),
        ...addMacro(107, SHOP, 'reads_view', 'table', 'SELECT * FROM evolved_view'),
        ...addMacro(108, SHOP, 'reads_customers', 'table', 'SELECT * FROM customers'),
        ...addMacro(109, SHOP, 'reads_nothing', 'table', 'SELECT * FROM nowhere, customers_gone(1)'),
        ...addMacro(110, SHOP, 'qualified', 'scalar', '(shop.only_shop(x))'),
        addView(111, SHOP, 'v_both', 'SELECT dual(1)'),
      ),
      parser,
    );
    expect(edgeList(graph)).toEqual([
      'shop.big_events reads shop.events',
      'shop.calls_both calls main.dual',
      'shop.qualified calls shop.only_shop',
      'shop.reads_view reads main.evolved_view',
      'shop.recent_events reads shop.events',
      // A view looks in its own schema first.
      'shop.v_both calls shop.dual',
    ]);
    expect(unresolvedList(graph)).toEqual([
      'shop.calls_only_shop: callerSchema shop.only_shop',
      'shop.reads_customers: callerSchema shop.customers',
    ]);
    expect(brokenList(graph)).toEqual([
      'shop.reads_nothing: macro customers_gone',
      'shop.reads_nothing: table main.nowhere',
    ]);
  });
});

describe('the limits of the analysis', () => {
  it('parses at most `limit` views and macros, says how many there were, and parses a text only up to 200 000 characters', async () => {
    const limited = await graphOf(await catalogs.open(historyFixture.sqlite), parser, { limit: 1 });
    expect([limited.objects, limited.parsed]).toEqual([3, 1]);
    // The view comes first by name; the macro after it is in the graph without edges.
    expect(edgeList(limited)).toEqual(['shop.big_events reads shop.events']);

    const padded = (length: number) => `SELECT 1${' '.repeat(length - 'SELECT 1'.length)}`;
    const reader = await catalogs.open(
      historyFixture.sqlite,
      addView(100, SHOP, 'v_edge', padded(MAX_SQL_LENGTH)),
      addView(101, SHOP, 'v_long', padded(MAX_SQL_LENGTH + 1)),
    );
    const graph = await buildGraph(await readObjects(reader, 56), parser);
    expect(unresolvedList(graph)).toEqual([`shop.v_long: tooLong ${MAX_SQL_LENGTH + 1} characters`]);
  });

  it('stops when the signal is aborted, before and while a text is parsed', async () => {
    const reader = await catalogs.open(historyFixture.sqlite);
    const early = new AbortController();
    early.abort();
    await expect(graphOf(reader, parser, { signal: early.signal })).rejects.toThrow();

    const late = new AbortController();
    const aborting: SqlParser = {
      serialize: () => {
        late.abort();
        return Promise.reject(new Error('The parser stopped.'));
      },
      functions: () => parser.functions(),
      dispose: () => Promise.resolve(),
    };
    await expect(graphOf(reader, aborting, { signal: late.signal })).rejects.toThrow();
  });
});

describe('one text that cannot be handled does not take the others down', () => {
  it('follows a view that is nested as deep as the limit on the length of a text allows', async () => {
    const depth = 12_000;
    const sql = `SELECT * FROM ${'(SELECT * FROM '.repeat(depth)}shop.events${')'.repeat(depth)}`;
    expect(sql.length).toBeLessThan(MAX_SQL_LENGTH);
    const graph = await graphOf(
      await catalogs.open(historyFixture.sqlite, addView(100, SHOP, 'v_deep', sql)),
      parser,
    );
    expect(edgeList(graph)).toEqual([
      'shop.big_events reads shop.events',
      'shop.recent_events reads shop.events',
      'shop.v_deep reads shop.events',
    ]);
    expect(unresolvedList(graph)).toEqual([]);
  }, 60_000);

  it('lists a text that the parser fails on as not followed and goes on with the other objects', async () => {
    const reader = await catalogs.open(
      historyFixture.sqlite,
      addView(100, SHOP, 'v_bad', 'SELECT * FROM shop.customers'),
    );
    const failing: SqlParser = {
      serialize: (sql) =>
        sql.includes('shop.customers')
          ? Promise.reject(new Error('Maximum\nstack depth   exceeded'))
          : parser.serialize(sql),
      functions: () => parser.functions(),
      dispose: () => Promise.resolve(),
    };
    const graph = await graphOf(reader, failing);
    expect(edgeList(graph)).toEqual([
      'shop.big_events reads shop.events',
      'shop.recent_events reads shop.events',
    ]);
    expect(unresolvedList(graph)).toEqual(['shop.v_bad: unsupported Maximum stack depth exceeded']);
  });
});
