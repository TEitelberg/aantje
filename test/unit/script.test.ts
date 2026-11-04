import { DuckDBInstance } from '@duckdb/node-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { qualifiedName, quoteIdentifier } from '../../src/catalog/ddl';
import type { ColumnInfo } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { selectStatement } from '../../src/script';
import { alterTableTemplate } from '../../src/script-templates/table';
import { CatalogTree } from '../../src/tree/model';
import type { TreeNode } from '../../src/tree/refs';
import { SNAPSHOT } from '../support/expected';
import { opened } from '../support/opened';
import {
  alterOf,
  BIG_ORDERS_ALTER,
  BIG_ORDERS_ALTER_AT_10,
  BIG_ORDERS_DROP,
  COMMENTED_OUT_NOTE,
  createOf,
  createWithDrop,
  dropOf,
  ORDERS_ALTER,
  ORDERS_DROP,
  ORDERS_DROP_AT_5,
  PLAIN_ALTER_AT_CREATION,
  READ_ALL_NOTE,
  selectOf,
} from '../support/scripts';
import { sqliteSource } from '../support/sources/sqlite';

const ORDERS_SELECT = `SELECT
  "id",
  "customer",
  "attrs",
  "amount",
  "created"
FROM "sales"."orders"
LIMIT 1000;`;

const PLAIN_SELECT_AT_CREATION = `-- Time travel to snapshot 12
SELECT
  "x",
  "y"
FROM "main"."plain" AT (VERSION => 12)
LIMIT 1000;`;

const PLAIN_SELECT_AT_LATEST = `SELECT
  "x",
  "y",
  "z"
FROM "main"."plain"
LIMIT 1000;`;

const BIG_ORDERS_SELECT = `SELECT *
FROM "sales"."big_orders"
LIMIT 1000;`;

// Names that must stay one identifier each: quotes, spaces, a reserved word, line breaks, non-ASCII letters and a
// statement that tries to end the identifier.
const HOSTILE_NAMES = ['a"b', 'with space', 'select', 'line\nbreak', 'ünï-日本', 'x"; DROP TABLE victim; --'];

const live = (text: string | undefined): string[] =>
  (text ?? '').split(/\r\n|\r|\n/).filter((line) => line !== '' && !line.startsWith('--'));

describe('alterTableTemplate', () => {
  const column = (name: string, type = 'int32', children: ColumnInfo[] = []): ColumnInfo => ({
    id: 1,
    name,
    type,
    nullable: true,
    defaultValue: null,
    comment: null,
    children,
  });

  it('writes nothing but comments, keeps a hostile name inside its identifier and puts no catalog text into the prose', () => {
    const name = 'x"\n-- y\r\nDROP TABLE victim; /* z */\rDROP TABLE victim2;--';
    const text = alterTableTemplate(
      name,
      name,
      [column(name), column('s', 'struct', [column(name), column(name, 'struct', [column(name)])])],
      3,
    );

    expect(live(text)).toEqual([]);
    // Taking the comment marks away restores the statements, line breaks of the names included.
    const uncommented = text.replaceAll(/^-- /gm, '');
    const table = qualifiedName(name, name);
    expect(uncommented).toContain(`ALTER TABLE ${table} DROP COLUMN ${quoteIdentifier(name)};`);
    expect(uncommented).toContain(
      `ALTER TABLE ${table} DROP COLUMN "s".${quoteIdentifier(name)}.${quoteIdentifier(name)};`,
    );

    // The prose names the columns by number, never by name.
    const plain = alterTableTemplate('main', 't', [column('secret'), column('other')], undefined);
    const prose = plain
      .split('\n')
      .filter((line) => line.startsWith('--') && !/^-- (ALTER TABLE|COMMENT ON|DROP TABLE)/.test(line));
    expect(prose.join('\n')).not.toMatch(/secret|other|main|"t"/);
    expect(prose).toContain('-- Column 2 of 2');
  });
});

describe('selectStatement', () => {
  it('lists every column quoted, one per line, limits the rows like Select Top 1000 Rows, selects * without a list and travels to the pinned snapshot', () => {
    expect(selectStatement('sales', 'orders', ['id', 'amount'], undefined)).toBe(
      'SELECT\n  "id",\n  "amount"\nFROM "sales"."orders"\nLIMIT 1000;',
    );
    expect(selectStatement('sales', 'big_orders', undefined, undefined)).toBe(BIG_ORDERS_SELECT);
    expect(selectStatement('sales', 'big_orders', [], undefined)).toBe(BIG_ORDERS_SELECT);
    expect(selectStatement('sales', 'orders', ['id'], 5)).toBe(
      '-- Time travel to snapshot 5\nSELECT\n  "id"\nFROM "sales"."orders" AT (VERSION => 5)\nLIMIT 1000;',
    );
    expect(selectStatement('sales', 'big_orders', [], 0)).toBe(
      '-- Time travel to snapshot 0\nSELECT *\nFROM "sales"."big_orders" AT (VERSION => 0)\nLIMIT 1000;',
    );
  });

  it('puts nothing of the catalog into the comment: names with line breaks and comment marks stay quoted', () => {
    const name = 'x\n-- DROP TABLE victim;\n/* y */';
    const text = selectStatement(name, name, [name], 7);

    expect(text.split('\n').slice(0, 2)).toEqual(['-- Time travel to snapshot 7', 'SELECT']);
    expect(text).toBe(
      `-- Time travel to snapshot 7\nSELECT\n  ${quoteIdentifier(name)}\nFROM ${quoteIdentifier(name)}.${quoteIdentifier(name)} AT (VERSION => 7)\nLIMIT 1000;`,
    );
  });

  describe('run by DuckDB', () => {
    let instance: DuckDBInstance;

    beforeEach(async () => {
      instance = await DuckDBInstance.create(':memory:');
    });

    afterEach(() => {
      instance.closeSync();
    });

    it('returns the columns in order for every hostile schema, table and column name, drops nothing and limits the result to 1000 rows', async () => {
      const connection = await instance.connect();
      try {
        for (const name of HOSTILE_NAMES) {
          const q = quoteIdentifier(name);
          await connection.run(`CREATE SCHEMA ${q}`);
          await connection.run(`CREATE TABLE ${q}.${q} (${q} INTEGER, "second" VARCHAR)`);
          await connection.run(`INSERT INTO ${q}.${q} VALUES (1, 'a'), (2, 'b')`);

          const result = await connection.runAndReadAll(
            selectStatement(name, name, [name, 'second'], undefined),
          );

          expect(result.columnNames(), name).toEqual([name, 'second']);
          expect(result.getRowsJson(), name).toEqual([
            [1, 'a'],
            [2, 'b'],
          ]);
        }
        const victim = await connection.runAndReadAll(
          "SELECT count(*) AS n FROM duckdb_tables() WHERE table_name = 'victim'",
        );
        expect(victim.getRowObjectsJson()).toEqual([{ n: '0' }]);

        await connection.run('CREATE TABLE big AS SELECT range AS n FROM range(2500)');
        const limited = await connection.runAndReadAll(selectStatement('main', 'big', ['n'], undefined));
        expect(limited.getRowsJson()).toHaveLength(1000);
      } finally {
        connection.closeSync();
      }
    });
  });
});

// The scripts are made from what the reader returns, and the readers are proven per backend in the reader tests: one
// fixture catalog is enough here.
describe('selectOf, dropOf and alterOf for the fixture catalog', () => {
  const profile = { id: 'fixture', name: 'Fixture', kind: 'sqlite', path: 'unused' } as const;
  let tree: CatalogTree;

  beforeEach(() => {
    tree = new CatalogTree({
      profiles: () => [profile],
      open: async () => opened(createCatalogReader(await sqliteSource.open())),
    });
  });

  afterEach(() => tree.dispose());

  /** Walks the tree by labels, starting at the connection node. */
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

  const orders = () => nodeAt('sales', 'Tables', 'orders');
  const plain = () => nodeAt('main', 'Tables', 'plain');
  const bigOrders = () => nodeAt('sales', 'Views', 'big_orders');

  it('selects the top-level columns of a table and * from a view, and travels to the pinned snapshot with the columns the table had then, @0 included', async () => {
    const plainRef = (await plain()).ref;
    const viewRef = (await bigOrders()).ref;
    expect(await selectOf(tree, (await orders()).ref)).toBe(ORDERS_SELECT);
    expect(await selectOf(tree, viewRef)).toBe(BIG_ORDERS_SELECT);
    expect(await selectOf(tree, plainRef)).toBe(PLAIN_SELECT_AT_LATEST);

    tree.selectSnapshot(profile.id, SNAPSHOT.createPlain);
    expect(await selectOf(tree, plainRef)).toBe(PLAIN_SELECT_AT_CREATION);

    tree.selectSnapshot(profile.id, SNAPSHOT.commentOnView);
    expect(await selectOf(tree, viewRef)).toBe(
      '-- Time travel to snapshot 10\nSELECT *\nFROM "sales"."big_orders" AT (VERSION => 10)\nLIMIT 1000;',
    );

    tree.selectSnapshot(profile.id, 0);
    expect(await selectOf(tree, viewRef)).toBe(
      '-- Time travel to snapshot 0\nSELECT *\nFROM "sales"."big_orders" AT (VERSION => 0)\nLIMIT 1000;',
    );

    tree.selectSnapshot(profile.id, 'latest');
    expect(await selectOf(tree, plainRef)).toBe(PLAIN_SELECT_AT_LATEST);
  });

  it('drops a table with DROP TABLE and a view with DROP VIEW, and says that the statement acts on the newest state while the tree, or a report, shows an older snapshot', async () => {
    const table = (await orders()).ref;
    const view = (await bigOrders()).ref;
    expect(dropOf(tree, table)).toBe(ORDERS_DROP);
    expect(dropOf(tree, view)).toBe(BIG_ORDERS_DROP);

    tree.selectSnapshot(profile.id, SNAPSHOT.insertTmp);
    expect(dropOf(tree, table)).toBe(ORDERS_DROP_AT_5);
    const report = {
      state: (id: string) => tree.state(id),
      reader: (id: string) => tree.reader(id),
      fromReport: true,
    } as const;
    expect(dropOf(report, table)).toBe(
      ORDERS_DROP_AT_5.replace('The tree shows', 'This script was made for'),
    );

    tree.selectSnapshot(profile.id, 0);
    expect(dropOf(tree, view)).toContain(
      '-- The tree shows snapshot @0; this statement acts on the newest state.',
    );

    tree.selectSnapshot(profile.id, 'latest');
    expect(dropOf(tree, table)).toBe(ORDERS_DROP);
  });

  it('scripts the ALTER of a view as CREATE OR REPLACE VIEW and of a table as commented statements per column and struct field, with the columns of the pinned snapshot', async () => {
    const view = (await bigOrders()).ref;
    const plainRef = (await plain()).ref;
    expect(await alterOf(tree, view)).toBe(BIG_ORDERS_ALTER);
    expect(await alterOf(tree, (await orders()).ref)).toBe(ORDERS_ALTER);

    tree.selectSnapshot(profile.id, SNAPSHOT.commentOnView);
    expect(await alterOf(tree, view)).toBe(BIG_ORDERS_ALTER_AT_10);

    tree.selectSnapshot(profile.id, SNAPSHOT.createPlain);
    expect(await alterOf(tree, plainRef)).toBe(PLAIN_ALTER_AT_CREATION);

    tree.selectSnapshot(profile.id, 'latest');
    const latest = await alterOf(tree, plainRef);
    expect(latest).toContain('"z"');
    expect(latest).not.toContain('The tree shows');
  });

  it('asks to connect again for the scripts that read the catalog when the connection is closed, and still writes DROP and the ALTER of a view', async () => {
    const table = (await orders()).ref;
    const view = (await bigOrders()).ref;
    await tree.disconnect(profile.id);

    await expect(alterOf(tree, table)).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    await expect(selectOf(tree, table)).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    expect(dropOf(tree, table)).toBe(ORDERS_DROP);
    expect(await alterOf(tree, view)).toBe(BIG_ORDERS_ALTER);
  });
});

describe('the scripts of a view that is not plain DuckDB SQL', () => {
  const tree = {
    state: () => ({ status: 'connected', snapshot: 'latest' }),
    reader: () => undefined,
  } as never;
  const viewRef = (dialect: string, sql: string) =>
    ({
      kind: 'view',
      connectionId: 'c',
      schema: { id: 0, name: 'main' },
      view: { id: 4, schemaId: 0, name: 'v', comment: null, dialect, sql, columnAliases: [] },
    }) as never;
  const FOREIGN =
    '-- This view is stored in another SQL dialect; running this replaces it with a DuckDB view.';
  const EDIT = '-- Edit the query, then run the statement in a read/write SQL session to replace the view.';
  const VIEW_TAIL = `-- Rename the view
-- ALTER VIEW "main"."v" RENAME TO <new_name>;
-- Comment on the view
-- COMMENT ON VIEW "main"."v" IS '<comment>';
-- Drop the view
-- DROP VIEW "main"."v";`;

  it('warns, with fixed words, that a view of another dialect is replaced by a DuckDB view, and adds nothing for a plain DuckDB view', async () => {
    const foreign = viewRef('spark', 'SELECT 1');
    expect(await alterOf(tree, foreign)).toBe(
      `${EDIT}\n${FOREIGN}\n${READ_ALL_NOTE}\nCREATE OR REPLACE VIEW "main"."v" AS SELECT 1;\n${VIEW_TAIL}`,
    );
    expect(await createOf(tree, foreign)).toBe(
      createWithDrop('DROP VIEW "main"."v";', 'CREATE VIEW "main"."v" AS SELECT 1;', FOREIGN, READ_ALL_NOTE),
    );

    const duckdb = viewRef('duckdb', 'SELECT 1');
    expect(await createOf(tree, duckdb)).toBe(
      createWithDrop('DROP VIEW "main"."v";', 'CREATE VIEW "main"."v" AS SELECT 1;'),
    );
    expect(await alterOf(tree, duckdb)).toBe(
      `${EDIT}\nCREATE OR REPLACE VIEW "main"."v" AS SELECT 1;\n${VIEW_TAIL}`,
    );
  });

  it('writes the statement as a comment, every line of it, when the stored query has a semicolon, a comment mark or line breaks: nothing runs until the user has read it', async () => {
    const sql = 'SELECT 1; DROP TABLE victim';
    const ref = viewRef('duckdb', sql);
    expect(await createOf(tree, ref)).toBe(
      createWithDrop(
        'DROP VIEW "main"."v";',
        `-- CREATE VIEW "main"."v" AS ${sql};`,
        READ_ALL_NOTE,
        COMMENTED_OUT_NOTE,
      ),
    );
    expect(await alterOf(tree, ref)).toBe(
      `${EDIT}\n${READ_ALL_NOTE}\n${COMMENTED_OUT_NOTE}\n-- CREATE OR REPLACE VIEW "main"."v" AS ${sql};\n${VIEW_TAIL}`,
    );

    for (const hostile of [
      'SELECT 1 -- DROP TABLE victim',
      'SELECT /* x */ 1',
      'SELECT 1;\r\nDROP TABLE victim;\rDROP TABLE victim2',
    ]) {
      const create = (await createOf(tree, viewRef('duckdb', hostile))) ?? '';
      const alter = (await alterOf(tree, viewRef('duckdb', hostile))) ?? '';
      expect(live(create), hostile).toEqual([]);
      expect(live(alter), hostile).toEqual([]);
      expect(alter, hostile).not.toContain(FOREIGN);
      // Taking the comment marks away gives the statement back unchanged, line breaks included.
      expect(create.replaceAll(/^-- /gm, ''), hostile).toContain(`CREATE VIEW "main"."v" AS ${hostile};`);
    }
  });
});
