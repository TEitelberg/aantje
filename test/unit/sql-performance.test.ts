import { afterAll, describe, expect, it } from 'vitest';
import type { CatalogReader, ColumnInfo, SchemaInfo, TableInfo } from '../../src/catalog/model';
import { catalogOfReader, EMPTY_CATALOG } from '../../src/sql/catalog';
import type { SqlCatalog, SqlEntry } from '../../src/sql/catalog';
import { openLanguageService } from '../../src/sql/language';
import { marked } from './sql-language-support';

/**
 * The bound that docs/en/sql-intellisense.md states for every answer. They take a few hundred milliseconds here; the
 * bound is generous so that a slow machine passes, but a quadratic loop over the text or the catalog would not.
 */
const BOUND_MS = 3000;

const service = openLanguageService();
afterAll(() => service.dispose());

const SCHEMAS = 20;
const TABLES = 2000;

/** A lake of 2 000 tables in 20 schemas with ten columns each: a port that is made up, to size the answer. */
function bigCatalog(): SqlCatalog {
  const schemas: SchemaInfo[] = Array.from({ length: SCHEMAS }, (_, id) => ({
    id,
    name: `schema_${id}`,
    comment: null,
  }));
  const entries: SqlEntry[] = Array.from({ length: TABLES }, (_, id) => {
    const schema = schemas[id % SCHEMAS] as SchemaInfo;
    const table: TableInfo = {
      id,
      schemaId: schema.id,
      name: `table_${id}`,
      comment: null,
      stats: { rows: id, files: 1, sizeBytes: 1000 },
    };
    return { kind: 'table', schema, table };
  });
  const columns: ColumnInfo[] = Array.from({ length: 10 }, (_, id) => ({
    id,
    name: `column_${id}`,
    type: 'int32',
    nullable: true,
    defaultValue: null,
    comment: null,
    children: [],
  }));
  return {
    ...EMPTY_CATALOG,
    schemas: () => Promise.resolve(schemas),
    entries: () => Promise.resolve(entries),
    columns: () => Promise.resolve(columns),
  };
}

async function timed<T>(work: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = performance.now();
  const result = await work();
  return { result, ms: performance.now() - started };
}

describe('large texts and large catalogs', () => {
  const catalog = bigCatalog();
  const statement =
    'SELECT o.id, o.amount, lower(o.name) AS n FROM schema_3.table_3 AS o WHERE o.id > 10 ORDER BY 1;\n';
  const script = statement.repeat(Math.ceil(50_000 / statement.length));

  it(`completes, hovers, helps and checks a script of ${script.length} characters and ${TABLES} tables within ${BOUND_MS} ms each`, async () => {
    await service.vocabulary();
    const columnsAt = marked(`${script}SELECT o.| FROM schema_3.table_3 AS o`);
    const tablesAt = marked('SELECT * FROM |');
    const hoverAt = marked(`${script}SELECT o.column_|1 FROM schema_3.table_3 AS o`);
    const callAt = marked(`${script}SELECT substring(o.name, |`);

    const columns = await timed(() => service.complete(columnsAt.text, columnsAt.offset, catalog));
    const tables = await timed(() => service.complete(tablesAt.text, tablesAt.offset, catalog));
    const hover = await timed(() => service.hover(hoverAt.text, hoverAt.offset, catalog));
    const signature = await timed(() => service.signature(callAt.text, callAt.offset, catalog));
    const diagnosed = await timed(() => service.diagnose(`${script}SELEC`));

    expect(columns.result?.items.map(({ label }) => label)).toEqual(
      Array.from({ length: 10 }, (_, id) => `column_${id}`),
    );
    expect(tables.result?.items.filter(({ kind }) => kind === 'table')).toHaveLength(TABLES);
    expect(hover.result?.markdown).toContain('`schema_3.table_3.column_1`');
    expect(signature.result?.activeParameter).toBe(1);
    expect(diagnosed.result).toEqual([expect.objectContaining({ offset: script.length, length: 5 })]);
    for (const [name, { ms }] of Object.entries({ columns, tables, hover, signature, diagnosed })) {
      expect(ms, name).toBeLessThan(BOUND_MS);
    }
  });
});

/** The target that docs/en/sql-intellisense.md states for completion while typing. */
const TYPING_MS = 50;

/** The reader of a made-up lake of 1 000 tables in `main` and nine other schemas, with 20 columns each. */
function lakeReader(): CatalogReader {
  const schemas: SchemaInfo[] = Array.from({ length: 10 }, (_, id) => ({
    id,
    name: id === 0 ? 'main' : `schema_${id}`,
    comment: null,
  }));
  const tables: TableInfo[] = Array.from({ length: 1000 }, (_, id) => ({
    id,
    schemaId: id % 10,
    name: `table_${id}`,
    comment: null,
    stats: { rows: id, files: 1, sizeBytes: 1000 },
  }));
  const columns: ColumnInfo[] = Array.from({ length: 20 }, (_, id) => ({
    id,
    name: `column_${id}`,
    type: 'int32',
    nullable: true,
    defaultValue: null,
    comment: null,
    children: [],
  }));
  const reader: Partial<CatalogReader> = {
    schemas: () => Promise.resolve(schemas),
    tables: (schemaId) => Promise.resolve(tables.filter((table) => table.schemaId === schemaId)),
    views: () => Promise.resolve([]),
    columns: () => Promise.resolve(columns),
    macros: () => Promise.resolve([]),
  };
  return reader as CatalogReader;
}

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Infinity;

describe('completion on a lake of 1 000 tables and 20 000 columns', () => {
  // The catalog is read during the warm-up; each run is the next keystroke, so the text is never the same.
  const WARM_UP = 5;
  const RUNS = 15;
  const statement =
    'SELECT o.column_1, lower(o.column_2) AS n FROM schema_3.table_3 AS o WHERE o.column_4 > 10;\n';
  const script = statement.repeat(Math.ceil(50_000 / statement.length));

  it(`completes within ${TYPING_MS} ms while typing at the end of a script of 50 000 characters, as the median of ${RUNS} keystrokes`, async () => {
    const catalog = catalogOfReader(lakeReader(), 1);
    const cases: [string, (typed: string) => string, (kinds: string[]) => void][] = [
      [
        'the columns of an alias',
        (typed) => `${script}SELECT o.${typed}| FROM schema_3.table_3 o`,
        (kinds) => expect(kinds.filter((kind) => kind === 'column')).toHaveLength(20),
      ],
      [
        'the columns of a join',
        (typed) =>
          `${script}SELECT ${typed}| FROM schema_3.table_3 a JOIN schema_4.table_4 b ON a.column_1 = b.column_1`,
        (kinds) => expect(kinds.filter((kind) => kind === 'column')).toHaveLength(40),
      ],
      [
        'the tables',
        (typed) => `${script}SELECT * FROM ${typed}|`,
        (kinds) => expect(kinds.filter((kind) => kind === 'table')).toHaveLength(1000),
      ],
    ];
    for (const [name, textOf, check] of cases) {
      const times: number[] = [];
      for (let run = 0; run < WARM_UP + RUNS; run += 1) {
        const cursor = marked(textOf(`c${run}`));
        const started = performance.now();
        const result = await service.complete(cursor.text, cursor.offset, catalog);
        if (run >= WARM_UP) times.push(performance.now() - started);
        check(result?.items.map(({ kind }) => kind) ?? []);
      }
      expect(median(times), name).toBeLessThan(TYPING_MS);
    }
  });
});
