import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogReader } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { selectAtSnapshot } from '../../src/script';
import { CatalogTree } from '../../src/tree/model';
import type { TreeNode } from '../../src/tree/refs';
import { HISTORY_ID } from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { opened } from '../support/opened';
import { alterOf, createOf, createWithDrop, dropOf } from '../support/scripts';
import { historyFixture } from '../support/sources/history';

// The exact texts of the macro scripts on the history fixture, which has macros; macros-lake.test.ts runs them against
// real lakes.

const GROSS_STATEMENT = 'CREATE OR REPLACE MACRO "shop"."gross"("net", "rate" := 1.19) AS (net * rate);';
const RECENT_EVENTS_STATEMENT =
  'CREATE OR REPLACE MACRO "shop"."recent_events"("n") AS TABLE SELECT * FROM shop.events ORDER BY ts DESC LIMIT n;';

const TEMPLATE = `-- Two examples of a macro in this schema. They run as they are in a read/write SQL session; replace them with your own.
-- A macro is a named SQL expression or query. DuckLake stores no Python or compiled functions.
-- CREATE MACRO fails when the schema has a macro of that name; the script of an existing macro uses CREATE OR REPLACE.

-- A scalar macro: an expression with parameters
CREATE MACRO "shop"."add_one"(x) AS x + 1;
-- Call it
-- SELECT "shop"."add_one"(1);
-- Drop it
-- DROP MACRO "shop"."add_one";

-- A table macro: a query, used like a table. The parameter has a default.
CREATE MACRO "shop"."first_rows"(n := 10) AS TABLE SELECT 42 AS answer FROM range(n);
-- Call it
-- SELECT * FROM "shop"."first_rows"(3);
-- Drop it
-- DROP MACRO TABLE "shop"."first_rows";`;

let reader: CatalogReader;
let tree: CatalogTree;

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

beforeAll(async () => {
  reader = createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
  tree = new CatalogTree({
    profiles: () => [{ id: 'h', name: 'Lake', kind: 'sqlite', path: historyFixture.sqlite }],
    open: () => opened(reader),
  });
  await tree.connect('h');
});
afterAll(async () => {
  await tree.dispose();
});

describe('the scripts of a macro', () => {
  it('write CREATE OR REPLACE with the parameters quoted, the defaults kept and the stored body; ALTER is the same statement with its header; DROP MACRO TABLE reaches a table macro', async () => {
    const gross = (await nodeAt('shop', 'Macros', 'gross')).ref;
    const recentEvents = (await nodeAt('shop', 'Macros', 'recent_events')).ref;
    expect(await createOf(tree, gross)).toBe(createWithDrop('DROP MACRO "shop"."gross";', GROSS_STATEMENT));
    expect(await createOf(tree, recentEvents)).toBe(
      createWithDrop('DROP MACRO TABLE "shop"."recent_events";', RECENT_EVENTS_STATEMENT),
    );
    expect(await alterOf(tree, gross)).toBe(
      `-- Edit the macro, then run the statement in a read/write SQL session to replace it. The statement holds all its overloads.\n${GROSS_STATEMENT}\n-- Drop the macro\n-- DROP MACRO "shop"."gross";`,
    );
    expect(dropOf(tree, gross)).toBe(
      '-- Drops the scalar macro with all its overloads. Run it in a read/write SQL session.\nDROP MACRO "shop"."gross";',
    );
    expect(dropOf(tree, recentEvents)).toBe(
      '-- Drops the table macro with all its overloads. Run it in a read/write SQL session.\nDROP MACRO TABLE "shop"."recent_events";',
    );
  });

  it('say with a fixed line that the statement writes DuckDB overloads when any overload is stored in another dialect, and nothing for DuckDB', async () => {
    const macroRef = (...dialects: string[]) =>
      ({
        kind: 'macro',
        connectionId: 'h',
        schema: { id: 1, name: 'shop', comment: null },
        macro: {
          id: 1,
          schemaId: 1,
          name: 'm',
          kind: 'scalar',
          implementations: dialects.map((dialect) => ({
            dialect,
            sql: 'x + 1',
            parameters: [{ name: 'x', type: null, defaultValue: null }],
          })),
        },
      }) as never;
    const NOTE =
      '-- This macro is stored in another SQL dialect; running this replaces it with DuckDB overloads.';
    const statement = 'CREATE OR REPLACE MACRO "shop"."m"("x") AS x + 1;';

    expect(await createOf(tree, macroRef('spark'))).toBe(
      createWithDrop('DROP MACRO "shop"."m";', statement, NOTE),
    );
    expect(await alterOf(tree, macroRef('spark'))).toContain(`\n${NOTE}\nCREATE OR REPLACE MACRO`);
    expect(await createOf(tree, macroRef('duckdb'))).toBe(
      createWithDrop('DROP MACRO "shop"."m";', statement),
    );
    expect(await alterOf(tree, macroRef('duckdb'))).not.toContain(NOTE);
    for (const dialects of [
      ['duckdb', 'spark'],
      ['spark', 'duckdb'],
    ]) {
      expect(await createOf(tree, macroRef(...dialects)), dialects.join()).toContain(NOTE);
    }
    expect(await createOf(tree, macroRef('duckdb', 'duckdb'))).not.toContain(NOTE);
  });

  it('keep a hostile macro, parameter and schema name inside their quotes, in the statement and in the commented drops and calls', async () => {
    const hostile = 'x"; DROP TABLE victim; --\n';
    const quoted = `"x""; DROP TABLE victim; --\n"`;
    const ref = {
      kind: 'macro' as const,
      connectionId: 'h',
      schema: { id: 1, name: hostile, comment: null },
      macro: {
        id: 1,
        schemaId: 1,
        name: hostile,
        kind: 'table' as const,
        implementations: [
          {
            dialect: 'duckdb',
            parameters: [{ name: hostile, type: null, defaultValue: null }],
            sql: 'SELECT 1',
          },
        ],
      },
    };
    // Everything above the statement is a comment, the drop included, whatever line breaks the name has.
    const create = `CREATE OR REPLACE MACRO ${quoted}.${quoted}(${quoted}) AS TABLE SELECT 1;`;
    const text = (await createOf(tree, ref)) ?? '';
    expect(text.endsWith(`\n${create}`)).toBe(true);
    const above = text.slice(0, -create.length).split('\n');
    expect(above.filter((line) => line !== '' && !line.startsWith('--'))).toEqual([]);
    expect(above.join('\n').replaceAll(/^-- /gm, '')).toContain(`DROP MACRO TABLE ${quoted}.${quoted};`);
    expect(dropOf(tree, ref)).toContain(`\nDROP MACRO TABLE ${quoted}.${quoted};`);

    const folder = {
      kind: 'folder',
      connectionId: 'h',
      folder: 'macros',
      schema: { id: 1, name: 'a"b\n-- c', comment: null },
      macros: [],
    } as never;
    const lines = ((await createOf(tree, folder)) ?? '').split('\n');
    // The line break is inside the quotes, so the statement continues on the next line, which looks like a comment.
    expect(lines).toContain('CREATE MACRO "a""b');
    expect(lines).toContain('-- c"."add_one"(x) AS x + 1;');
    // In a commented statement every line starts with a comment mark, so that nothing of the name is run.
    expect(lines).toContain('-- SELECT "a""b');
    expect(lines).toContain('-- -- c"."add_one"(1);');
    expect(lines).toContain('-- DROP MACRO TABLE "a""b');
    expect(lines.filter((line) => !line.startsWith('-- ') && line !== '')).toEqual([
      'CREATE MACRO "a""b',
      'CREATE MACRO "a""b',
    ]);
  });
});

describe('the template of the Macros folder', () => {
  it('has two examples that run as they are, and the calls and the drops as comments', async () => {
    expect(await createOf(tree, (await nodeAt('shop', 'Macros')).ref)).toBe(TEMPLATE);
  });
});

describe('Open as SQL, the statement of Query at Snapshot', () => {
  const evolving = { kind: 'table' as const, id: HISTORY_ID.evolving, schemaName: 'main', name: 'evolved' };
  const at = (snapshot: number, table: string) =>
    selectAtSnapshot(reader, evolving, { schema: 'main', table }, snapshot);
  const columns = (text: string) => text.split('\n').filter((line) => line.startsWith('  "'));

  it('selects the columns that the table had at the very snapshot, from the name it had then, with the snapshot in a comment; * from a view', async () => {
    expect(await at(30, 'evolving')).toBe(`-- Time travel to snapshot 30
SELECT
  "id",
  "title",
  "info",
  "n",
  "extra"
FROM "main"."evolving" AT (VERSION => 30)
LIMIT 1000;`);
    // The snapshot that renamed a column already has the new name; the table was altered and renamed later.
    expect(columns(await at(29, 'evolving'))).toEqual(columns(await at(30, 'evolving')));
    expect(columns(await at(28, 'evolving'))).not.toEqual(columns(await at(29, 'evolving')));
    expect(await at(40, 'evolved')).toBe(`-- Time travel to snapshot 40
SELECT
  "id",
  "title",
  "info",
  "n",
  "flag"
FROM "main"."evolved" AT (VERSION => 40)
LIMIT 1000;`);

    const view = { kind: 'view' as const, id: HISTORY_ID.tmpView, schemaName: 'shop', name: 'tmp_view' };
    expect(await selectAtSnapshot(reader, view, { schema: 'shop', table: 'tmp_view' }, 41)).toBe(
      '-- Time travel to snapshot 41\nSELECT *\nFROM "shop"."tmp_view" AT (VERSION => 41)\nLIMIT 1000;',
    );
  });
});
