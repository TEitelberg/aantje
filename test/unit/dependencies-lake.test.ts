import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DependencyGraph } from '../../src/dependencies/graph';
import { brokenList, edgeList, graphOf, sharedParser, unresolvedList } from './dependencies-support';
import { lakeBackends } from './lake-backends';
import type { BackendLake } from './lake-backends';

/**
 * The dependencies of a DuckLake that the real DuckDB wrote, checked against what DuckDB itself does: every table holds
 * a different number, so the number a view returns says which table DuckDB looked its unqualified name up in.
 */

const parser = sharedParser();
afterAll(() => parser.dispose());

const SETUP = [
  'CREATE SCHEMA s',
  'CREATE SCHEMA o',
  'CREATE TABLE main.base AS SELECT 1 AS a',
  'CREATE TABLE s.base AS SELECT 2 AS a',
  'CREATE TABLE s.t AS SELECT 3 AS a',
  'CREATE TABLE o.u AS SELECT 4 AS a',
  'CREATE TABLE main.mt AS SELECT 5 AS a',
  // Unqualified names in a schema that is not main: the schema of the view first, then main.
  'CREATE VIEW s.v_own AS SELECT * FROM base',
  'CREATE VIEW main.v_main AS SELECT * FROM base',
  'CREATE VIEW s.v_fallback AS SELECT * FROM mt',
  'CREATE VIEW s.v_lake AS SELECT * FROM lake.o.u',
  'CREATE VIEW main.v_chain AS SELECT * FROM s.v_own',
  'CREATE VIEW main.v_chain2 AS SELECT * FROM v_chain',
  'CREATE VIEW s.v_cte AS WITH t AS (SELECT 30 AS a) SELECT * FROM t',
  'CREATE VIEW s.v_cte_inner AS WITH t AS (SELECT * FROM t) SELECT * FROM t',
  'CREATE VIEW s.v_joins AS SELECT t.a FROM t JOIN o.u ON true WHERE t.a IN (SELECT a FROM mt)',
  'CREATE VIEW s.v_union AS SELECT a FROM t UNION ALL SELECT a FROM o.u',
  'CREATE VIEW s.v_lateral AS SELECT * FROM t, LATERAL (SELECT * FROM o.u WHERE u.a > t.a) l',
  'CREATE VIEW s."Weird ""Name"" ü; --" AS SELECT * FROM o.u',
  'CREATE VIEW s."select" AS SELECT * FROM "Weird ""Name"" ü; --"',
  // Macros: scalar, calling a macro, a table macro with a table, a table macro of another schema calling it.
  'CREATE MACRO main.double(x) AS x * 2',
  'CREATE MACRO main.double_plus(x) AS double(x) + 1',
  'CREATE MACRO main.below(n) AS TABLE SELECT * FROM base WHERE a < n',
  'CREATE MACRO s.below_all(n) AS TABLE SELECT * FROM main.below(n)',
  'CREATE MACRO main.count_t() AS (SELECT count(*) FROM lake.s.t)',
  'CREATE VIEW s.v_macros AS SELECT double_plus(base.a) AS d FROM base, below(10)',
  // Macros that call each other.
  'CREATE MACRO main.ma(x) AS x',
  'CREATE MACRO main.mb(x) AS ma(x)',
  'CREATE OR REPLACE MACRO main.ma(x) AS mb(x)',
  // A macro is bound when it is called, in the default schema of the caller; nothing is bound to its own schema.
  'CREATE MACRO main.dup() AS 1',
  'CREATE MACRO s.dup() AS 2',
  'CREATE MACRO s.callit() AS dup()',
  'CREATE MACRO s.reads_base() AS TABLE SELECT a FROM base',
  'CREATE MACRO s.only_s() AS 7',
  'USE lake.s',
  'CREATE MACRO s.cm() AS only_s()',
  'USE lake',
  // Things that are dropped afterwards.
  'CREATE VIEW main.v_gone_table AS SELECT * FROM s.t',
  'CREATE MACRO main.gone(x) AS x',
  'CREATE VIEW main.v_gone_macro AS SELECT gone(a) FROM base',
  'CREATE VIEW main.v_gone_view AS SELECT * FROM s.v_lake',
];

const DROPS = ['DROP TABLE s.t', 'DROP MACRO main.gone', 'DROP VIEW s.v_lake'];

const backends = await lakeBackends();

for (const backend of backends) {
  describe.skipIf(backend.skipReason !== undefined)(
    `the dependencies of a DuckLake with ${backend.name} metadata`,
    () => {
      let lake: BackendLake;
      let before: DependencyGraph;
      let after: DependencyGraph;
      /** What DuckDB returns from the views before anything is dropped: the number of the table each one read. */
      const read: Record<string, unknown[][]> = {};

      const rows = async (sql: string): Promise<unknown[][]> =>
        (await lake.connection.runAndReadAll(sql)).getRowsJson();

      beforeAll(async () => {
        lake = await backend.create();
        for (const statement of SETUP) {
          await lake.connection.run(statement);
        }
        before = await graphOf(await lake.reader(), parser);
        for (const schema of ['lake', 'lake.s']) {
          await lake.connection.run(`USE ${schema}`);
          read[`callit in ${schema}`] = await rows('SELECT s.callit()');
          read[`reads_base in ${schema}`] = await rows('SELECT a FROM s.reads_base()');
          read[`cm in ${schema}`] = await rows('SELECT s.cm()').catch((error: Error) => [[error.message]]);
        }
        // The views look names up in their own schema and in main, not in the schema the session happens to use.
        await lake.connection.run('USE lake.o');
        for (const view of ['s.v_own', 'main.v_main', 's.v_fallback', 's.v_cte', 's.v_cte_inner']) {
          read[view] = await rows(`SELECT a FROM ${view}`);
        }
        for (const statement of DROPS) {
          await lake.connection.run(statement);
        }
        after = await graphOf(await lake.reader(), parser);
      });
      afterAll(() => lake.remove());

      it('resolves view names as DuckDB does: schema of the view, then main, CTEs, joins, lateral, odd names', () => {
        const edges = edgeList(before);
        // DuckDB: the view of s reads s.base (2), the view of main reads main.base (1), a view of s falls back to main.mt (5).
        expect([read['s.v_own'], read['main.v_main'], read['s.v_fallback']]).toEqual([[[2]], [[1]], [[5]]]);
        expect(edges).toEqual(
          expect.arrayContaining([
            'main.v_main reads main.base',
            'main.v_chain reads s.v_own',
            'main.v_chain2 reads main.v_chain',
            's.v_fallback reads main.mt',
            's.v_own reads s.base',
            // The lake alias shows nowhere in a view, and a macro that names it still finds the table.
            's.v_lake reads o.u',
            'main.count_t reads s.t',
            's.Weird "Name" ü; -- reads o.u',
            's.select reads s.Weird "Name" ü; --',
          ]),
        );
        expect(edges).not.toContain('s.v_own reads main.base');
        // A CTE hides the table of the same name, except in its own query.
        expect([read['s.v_cte'], read['s.v_cte_inner']]).toEqual([[[30]], [[3]]]);
        expect(edges.filter((edge) => edge.startsWith('s.v_cte'))).toEqual(['s.v_cte_inner reads s.t']);
        expect(edges.filter((edge) => /^s\.v_(joins|union|lateral) /.test(edge))).toEqual([
          's.v_joins reads main.mt',
          's.v_joins reads o.u',
          's.v_joins reads s.t',
          's.v_lateral reads o.u',
          's.v_lateral reads s.t',
          's.v_union reads o.u',
          's.v_union reads s.t',
        ]);
      });

      it('resolves macro names as DuckDB does: in main, where the SQL editor calls them, never in the own schema', () => {
        const edges = edgeList(before);
        // The macros of s return what main has under `USE lake` and what s has only for a caller in s.
        expect([read['callit in lake'], read['callit in lake.s']]).toEqual([[[1]], [[2]]]);
        expect([read['reads_base in lake'], read['reads_base in lake.s']]).toEqual([[[1]], [[2]]]);
        expect(edges).toEqual(
          expect.arrayContaining([
            's.callit calls main.dup',
            's.reads_base reads main.base',
            'main.ma calls main.mb',
            'main.mb calls main.ma',
          ]),
        );
        expect(edges).not.toContain('s.callit calls s.dup');
        expect(edges).not.toContain('s.reads_base reads s.base');
        // A name that only the schema of the macro has works for a caller in that schema only.
        expect(read['cm in lake']?.[0]?.[0]).toMatch(/only_s does not exist/);
        expect(read['cm in lake.s']).toEqual([[7]]);
        expect(unresolvedList(before)).toEqual(['s.cm: callerSchema s.only_s']);
        expect(edges.filter((edge) => edge.startsWith('s.cm '))).toEqual([]);
        expect(edges.filter((edge) => /macros|double|below/.test(edge))).toEqual(
          [
            'main.double_plus calls main.double',
            'main.below reads main.base',
            's.below_all calls main.below',
            's.v_macros calls main.below',
            's.v_macros calls main.double_plus',
            's.v_macros reads s.base',
          ].toSorted(),
        );
      });

      it('finds nothing broken until a table, a macro and a view are dropped, then what DuckDB fails on', async () => {
        expect(brokenList(before)).toEqual([]);
        await expect(rows('SELECT * FROM main.v_gone_table')).rejects.toThrow(/does not exist/);
        await expect(rows('SELECT * FROM main.v_gone_macro')).rejects.toThrow(/does not exist/);
        await expect(rows('SELECT * FROM main.v_gone_view')).rejects.toThrow(/does not exist/);
        expect(brokenList(after)).toEqual(
          [
            'main.count_t: table s.t',
            'main.v_gone_macro: macro gone',
            'main.v_gone_table: table s.t',
            'main.v_gone_view: table s.v_lake',
            's.v_cte_inner: table s.t',
            's.v_joins: table s.t',
            's.v_lateral: table s.t',
            's.v_union: table s.t',
          ].toSorted(),
        );
      });
    },
  );
}
