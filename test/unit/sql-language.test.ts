import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDuckdb } from '../../src/catalog/drivers/duckdb';
import { createCatalogReader } from '../../src/catalog/reader';
import { catalogOfReader, EMPTY_CATALOG } from '../../src/sql/catalog';
import type { SqlCatalog } from '../../src/sql/catalog';
import { openLanguageService } from '../../src/sql/language';
import { quickFixes } from '../../src/sql/problems';
import { GLOBAL_LAKE_FUNCTIONS, LAKE_FUNCTIONS } from '../../src/sql/ducklake';
import { openSqlSession } from '../../src/sql/session';
import type { SqlSession } from '../../src/sql/session';
import { createLake, engineSkipReason, extensionDirectory } from './data-support';
import type { Lake } from './data-support';

const accessFor = (lake: Lake) => ({ profile: lake.profile, s3: {}, extensionDirectory });
import { marked } from './sql-language-support';
import { events, only } from './sql-support';

const MAX_DIAGNOSE_LENGTH = 200_000;
const MAX_COMPLETE_LENGTH = 500_000;

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`The lake tests of the language service are skipped: ${skipReason}`);
}

/** The instances that the services in this file created, to look into them. */
const created = vi.spyOn(DuckDBInstance, 'create');
afterEach(() => created.mockClear());

async function instanceOf(index = 0): Promise<DuckDBInstance> {
  const result = created.mock.results[index];
  if (result?.type !== 'return') throw new Error('No instance was created.');
  return await result.value;
}

describe('opening and closing', () => {
  it('creates nothing until the first call, then one DuckDB with nothing attached, loaded or reachable', async () => {
    const service = openLanguageService();
    expect(created).not.toHaveBeenCalled();
    await service.tokenize('select 1');
    await service.tokenize('select 2');
    await service.vocabulary();
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0]?.[0]).toBe(':memory:');
    expect(created.mock.calls[0]?.[1]).toMatchObject({
      enable_external_access: 'false',
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
      allow_persistent_secrets: 'false',
    });

    const probe: DuckDBConnection = await (await instanceOf()).connect();
    try {
      const scalar = async (sql: string): Promise<unknown> =>
        (await probe.runAndReadAll(sql)).getRowsJson()[0]?.[0];
      expect(
        await scalar(
          "SELECT count(*) FROM duckdb_databases() WHERE database_name NOT IN ('memory', 'system', 'temp')",
        ),
      ).toBe('0');
      // No function of DuckLake exists: the extension is not loaded.
      expect(
        await scalar("SELECT count(*) FROM duckdb_functions() WHERE function_name LIKE 'ducklake%'"),
      ).toBe('0');
      await expect(probe.run("COPY (SELECT 1) TO 'aantje-language-service.csv'")).rejects.toThrow(
        /disabled by configuration/,
      );
      await expect(probe.run('INSTALL ducklake')).rejects.toThrow(/disabled/);
    } finally {
      probe.closeSync();
      await service.dispose();
    }
    expect(existsSync('aantje-language-service.csv')).toBe(false);
  });

  it('closes the DuckDB once on dispose, creates none when disposed first, and tries again after a failed creation', async () => {
    const service = openLanguageService();
    await service.tokenize('select 1');
    const instance = await instanceOf();
    const close = vi.spyOn(instance, 'closeSync');
    await service.dispose();
    await service.dispose();
    expect(close).toHaveBeenCalledTimes(1);
    await expect(service.tokenize('select 1')).rejects.toThrow('closed');
    expect(await service.diagnose('selec 1')).toEqual([]);

    created.mockClear();
    const unused = openLanguageService();
    await unused.dispose();
    expect(created).not.toHaveBeenCalled();

    created.mockImplementationOnce(() => Promise.reject(new Error('no binding')));
    const retry = openLanguageService({ extensionDirectory: 'somewhere' });
    await expect(retry.tokenize('select 1')).rejects.toThrow('no binding');
    await expect(retry.tokenize('select 1')).resolves.toHaveLength(2);
    expect(created).toHaveBeenCalledTimes(2);
    expect(created.mock.calls[1]?.[1]).toMatchObject({ extension_directory: 'somewhere' });
    await retry.dispose();
  });
});

describe('the vocabulary', () => {
  const service = openLanguageService();
  afterAll(() => service.dispose());

  it('has the keywords, functions, types and settings of DuckDB, with their overloads and where each function can stand', async () => {
    const vocabulary = await service.vocabulary();
    const { functions } = vocabulary;
    expect(vocabulary.keywords.length).toBeGreaterThan(400);
    expect(functions.size).toBeGreaterThan(1000);
    expect(vocabulary.types.length).toBeGreaterThan(50);
    expect(vocabulary.settings.length).toBeGreaterThan(100);
    expect(vocabulary.keywords).toContainEqual({ name: 'SELECT', category: 'reserved' });
    expect(vocabulary.types).toContainEqual({ name: 'varchar', category: 'STRING' });
    expect(vocabulary.settings).toContainEqual(expect.objectContaining({ name: 'threads', type: 'BIGINT' }));

    const substring = functions.get('substring');
    expect(substring).toMatchObject({
      name: 'substring',
      kind: 'scalar',
      expression: true,
      relation: false,
      qualified: false,
    });
    expect(substring?.overloads.map(({ parameters }) => parameters.map(({ name }) => name))).toEqual([
      ['string', 'start'],
      ['string', 'start', 'length'],
    ]);
    expect(substring?.overloads[0]).toEqual({
      parameters: [
        { name: 'string', type: 'VARCHAR' },
        { name: 'start', type: 'BIGINT' },
      ],
      returns: 'VARCHAR',
      varargs: undefined,
    });
    expect(substring?.examples).toEqual(["substring('Hello', 2)", "substring('Hello', 2, 2)"]);
    expect(functions.get('sum')?.kind).toBe('aggregate');
    expect(functions.get('row_number')?.kind).toBe('window');
    expect(functions.get('concat')?.overloads[0]?.varargs).toBe('ANY');

    expect(functions.get('read_csv')).toMatchObject({ kind: 'table', relation: true, expression: false });
    expect(functions.get('generate_series')).toMatchObject({
      relation: true,
      expression: true,
      kind: 'scalar',
    });
    expect(functions.get('lower')).toMatchObject({ relation: false, expression: true });
  });

  it('keeps one entry per name without operators, stays small, lists the words that need quotes and leaves out the lake functions', async () => {
    const { functions, reserved, lakeFunctions } = await service.vocabulary();
    const names = [...functions.values()].map(({ name }) => name);
    expect(new Set(names.map((name) => name.toLowerCase())).size).toBe(names.length);
    expect(names.filter((name) => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name))).toEqual([]);
    expect(functions.has('+')).toBe(false);
    expect(functions.has('pragma_version')).toBe(true);
    expect(JSON.stringify([...functions.values()]).length).toBeLessThan(2_000_000);
    expect([...functions.values()].every(({ examples }) => examples.length <= 3)).toBe(true);

    for (const word of ['select', 'order', 'from', 'left', 'values', 'int']) {
      expect(reserved.has(word), word).toBe(true);
    }
    for (const word of ['year', 'name', 'data', 'status']) expect(reserved.has(word), word).toBe(false);

    // DuckDB only has the functions of the lake once DuckLake is loaded.
    for (const name of lakeFunctions.keys()) expect(functions.has(name), name).toBe(false);
    expect([...lakeFunctions.keys()]).toEqual(LAKE_FUNCTIONS.map(({ name }) => name));
  });
});

describe('tokens', () => {
  const service = openLanguageService();
  afterAll(() => service.dispose());

  it('puts every token exactly at its offsets, counts UTF-16 units and ends a line comment at the carriage return', async () => {
    const texts = [
      'select \'ü😀\' as x, "名前" from t',
      'select a,\r\n  b -- comment ö\r\nfrom /* block\r\n😀 */ t\r\n;',
      "select 'é', 'a👨‍👩‍👧b', \"ß\" from größe where x = 'it''s'",
      'select\t1,\r2\n;select $$ ü; $$',
      'select 日本語, "a""b" from "名前"."テーブル"',
      '﻿select 1, 2 from t',
    ];
    for (const text of texts) {
      const tokens = await service.tokenize(text);
      expect(tokens.length, text).toBeGreaterThan(3);
      for (const [index, token] of tokens.entries()) {
        expect(text.slice(token.start, token.end), JSON.stringify(token)).toBe(token.word);
        expect(token.start).toBeGreaterThanOrEqual(tokens[index - 1]?.end ?? 0);
      }
    }

    const wide = await service.tokenize('select \'ü😀\', "名前" from t');
    expect(wide.map(({ word, start, end }) => [word, start, end])).toEqual([
      ['select', 0, 6],
      ["'ü😀'", 7, 12],
      [',', 12, 13],
      ['"名前"', 14, 18],
      ['from', 19, 23],
      ['t', 24, 25],
    ]);

    const crlf = await service.tokenize('select 1 -- a\r\n; select 2');
    expect(crlf.map(({ type, word }) => [type, word])).toEqual([
      ['KEYWORD', 'select'],
      ['NUMBER_LITERAL', '1'],
      ['COMMENT', '-- a\r'],
      ['TERMINATOR', ';'],
      ['KEYWORD', 'select'],
      ['NUMBER_LITERAL', '2'],
    ]);
    expect(crlf[3]).toMatchObject({ start: 15, end: 16 });
    expect(await service.tokenize('')).toEqual([]);
    expect(await service.tokenize(' \r\n\t ')).toEqual([]);
  });
});

describe('syntax errors', () => {
  const service = openLanguageService();
  afterAll(() => service.dispose());

  it('finds none in valid text and the position of a typo, also behind a byte order mark and non-ASCII text', async () => {
    for (const text of [
      'select 1',
      'select a, b from sales.orders o join sales.tmp t on o.id = t.a where x in (1, 2) order by 1',
      'with x as (select 1) select * from x; select 2',
      'create table x (a int, b struct(c int))',
      'insert into t values (1, 2)',
      'update t set a = 1 where b = 2',
      "copy (select 1) to 'x.csv'",
      'alter table sales.orders add column z double',
      '',
      '   \r\n  ',
      '-- only a comment',
    ]) {
      expect(await service.diagnose(text), text).toEqual([]);
    }

    const found: [string, number, number][] = [
      ['SELEC 1', 0, 5],
      ['select * from sales.orders wher x = 1', 32, 1],
      // `form` still reads as an alias of the star: DuckDB only complains about what follows.
      ['select * form sales.orders', 14, 5],
      ['﻿SELEC 1', 1, 5],
      ["select 'abc", 7, 1],
      ['select 1;\nselect 2;\nselec 3', 20, 5],
      ['insert into t valuez (1)', 14, 6],
      ['insert into t values (1,', 23, 1],
      ['create tabel x (a int)', 7, 5],
      ['update t sett a = 1', 14, 1],
      ['delete form t', 7, 4],
      ['alter table t add colum z int', 26, 3],
    ];
    for (const [text, offset, length] of found) {
      expect(await service.diagnose(text), text).toEqual([expect.objectContaining({ offset, length })]);
    }

    for (const prefix of [
      "select 'ü😀' as x, ",
      "select '名前' as x, ",
      'select 1 as "größe", ',
      "select 'a👨‍👩‍👧b', ",
      'select 1;\r\n-- ö😀\r\nselect 2 as x, ',
    ]) {
      const text = `${prefix}y z q`;
      const [error] = (await service.diagnose(text)) ?? [];
      expect(error, text).toMatchObject({ offset: text.indexOf(' q') + 1, length: 1 });
    }
  });

  it('parses one text at a time, lets the newest text of a source replace the waiting ones and survives a failing engine', async () => {
    let running = 0;
    let most = 0;
    // The original is called with the connection as `this` below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const real = DuckDBConnection.prototype.runAndReadAll;
    let failures = 0;
    const spy = vi.spyOn(DuckDBConnection.prototype, 'runAndReadAll').mockImplementation(async function (
      this: DuckDBConnection,
      ...args
    ) {
      if (!String(args[0]).includes('json_serialize_sql')) return real.apply(this, args);
      if (failures-- > 0) throw new Error('engine failed');
      running += 1;
      most = Math.max(most, running);
      try {
        return await real.apply(this, args);
      } finally {
        running -= 1;
      }
    });
    try {
      await service.vocabulary();
      const first = service.diagnose('selec 1', 'a');
      const second = service.diagnose('selec 22', 'a');
      const third = service.diagnose('selec 333', 'a');
      const other = service.diagnose('selec 4444', 'b');
      const results = await Promise.all([first, second, third, other]);
      expect(results[0]).toEqual([expect.objectContaining({ offset: 0 })]);
      expect(results[1]).toBeUndefined();
      expect(results[2]).toEqual([expect.objectContaining({ offset: 0 })]);
      expect(results[3]).toEqual([expect.objectContaining({ offset: 0 })]);
      const many = await Promise.all(
        Array.from({ length: 8 }, (_, index) => service.diagnose(`selec ${index}`, `source ${index}`)),
      );
      expect(many.every((found) => found?.length === 1)).toBe(true);
      expect(most).toBe(1);

      // A failed check answers with no errors, and the next one is still checked.
      failures = 1;
      expect(await service.diagnose('selec 1', 'a')).toEqual([]);
      expect(await service.diagnose('selec 1', 'a')).toEqual([expect.objectContaining({ offset: 0 })]);
    } finally {
      spy.mockRestore();
    }

    const local = openLanguageService();
    await local.vocabulary();
    const active = local.diagnose('selec 1', 'a');
    const waiting = local.diagnose('selec 2', 'b');
    await local.dispose();
    expect(await active).toBeDefined();
    expect(await waiting).toBeUndefined();
  });
});

describe('the text that is checked is never run', () => {
  const service = openLanguageService();
  afterAll(() => service.dispose());

  const catalog: SqlCatalog = EMPTY_CATALOG;

  /** What exists in the instance of the service after the texts were handed to it. */
  async function leftBehind(): Promise<{ tables: number; schemas: string[] }> {
    const probe = await (await instanceOf()).connect();
    try {
      const rows = async (sql: string): Promise<unknown[][]> =>
        (await probe.runAndReadAll(sql)).getRowsJson();
      return {
        tables: Number((await rows('SELECT count(*) FROM duckdb_tables()'))[0]?.[0]),
        schemas: (
          await rows("SELECT schema_name FROM duckdb_schemas() WHERE NOT internal AND schema_name <> 'main'")
        ).map(([name]) => String(name)),
      };
    } finally {
      probe.closeSync();
    }
  }

  const scripts = [
    'CREATE TABLE x AS SELECT 1; SELEC',
    'CREATE TABLE y AS SELECT 1',
    'CREATE SCHEMA z; CREATE TABLE z.t (a INT); INSERT INTO z.t VALUES (1)',
    'CREATE TEMP TABLE q AS SELECT 1; SELECT * FROM q',
    'CREATE VIEW v AS SELECT 1',
    'DROP TABLE IF EXISTS main.x',
  ];

  it('creates nothing when it checks, tokenizes, completes or hovers, and still finds the error behind a CREATE', async () => {
    for (const script of scripts) {
      // With a catalog the queries of a script with other statements are parsed one by one as well.
      await service.diagnose(script, 'never run', catalog);
      await service.tokenize(script);
      await service.complete(script, script.length, catalog);
      await service.complete(script, 8, catalog);
      await service.hover(script, 8, catalog);
      await service.signature(`${script} f(`, script.length + 3, catalog);
    }
    expect(await leftBehind()).toEqual({ tables: 0, schemas: [] });
    expect(await service.diagnose('CREATE TABLE x AS SELECT 1; SELEC')).toEqual([
      expect.objectContaining({ offset: 28, length: 5 }),
    ]);
  });
});

describe('the limits of the text', () => {
  const service = openLanguageService();
  afterAll(() => service.dispose());

  /** A text of exactly `length` characters that ends in `tail`; the cursor mark `|` in the tail does not count. */
  function textOf(length: number, tail: string): { text: string; offset: number } {
    const cursor = marked(tail);
    const lines = Math.floor((length - cursor.text.length) / 10);
    const padding = ' '.repeat(length - cursor.text.length - lines * 10);
    const prefix = `${'select 1;\n'.repeat(lines)}${padding}`;
    return { text: `${prefix}${cursor.text}`, offset: prefix.length + cursor.offset };
  }

  it('completes, hovers and helps in a text of exactly the limit, and in none that is one character longer', async () => {
    const empty = EMPTY_CATALOG;
    const at = (length: number, tail: string): { text: string; offset: number } => {
      const found = textOf(length, tail);
      expect(found.text.length).toBe(length);
      return found;
    };

    for (const [length, answers] of [
      [MAX_COMPLETE_LENGTH, true],
      [MAX_COMPLETE_LENGTH + 1, false],
    ] as const) {
      const complete = at(length, 'select | from t');
      const hover = at(length, 'select lo|wer(x) from t');
      const signature = at(length, 'select lower(|');
      const found = [
        await service.complete(complete.text, complete.offset, empty),
        await service.hover(hover.text, hover.offset, empty),
        await service.signature(signature.text, signature.offset, empty),
      ];
      expect(
        found.map((answer) => answer !== undefined),
        `length ${length}`,
      ).toEqual([answers, answers, answers]);
    }
  }, 60_000);

  it('checks the syntax of a text of exactly the limit, and of none that is one character longer', async () => {
    const at = textOf(MAX_DIAGNOSE_LENGTH, 'selec|');
    const above = textOf(MAX_DIAGNOSE_LENGTH + 1, 'selec|');

    expect(at.text.length).toBe(MAX_DIAGNOSE_LENGTH);
    expect(await service.diagnose(at.text)).toEqual([
      expect.objectContaining({ offset: at.offset - 5, length: 5 }),
    ]);
    expect(await service.diagnose(above.text)).toEqual([]);
  });
});

describe.skipIf(skipReason !== undefined)('against a real lake', () => {
  const service = openLanguageService();
  let lake: Lake;
  let session: SqlSession;
  let reader: ReturnType<typeof createCatalogReader>;
  let catalog: SqlCatalog;

  const HOSTILE = [
    'CREATE SCHEMA "my schema"',
    'CREATE SCHEMA "sch""ema"',
    `CREATE TABLE "my schema"."order" ("from" INTEGER, "my col" INTEGER, "ünï" INTEGER, """quoted""" INTEGER, normal INTEGER, "1abc" INTEGER, "ORDER" INTEGER, "Select" INTEGER)`,
    'CREATE TABLE "sch""ema"."select" (x INTEGER)',
    'CREATE TABLE "Odd Name" (a INTEGER)',
    'CREATE TABLE "größe" (a INTEGER)',
    'CREATE TABLE "日本語" (a INTEGER)',
    'CREATE TABLE ok_name (a INTEGER)',
    'CREATE TABLE "Mixed" (a INTEGER)',
    'CREATE VIEW "my schema"."all rows" AS SELECT 1 AS x',
    'CREATE TABLE orders (id INTEGER)',
    ...[1, 2, 3, 4].map((id) => `INSERT INTO orders VALUES (${id})`),
  ];

  beforeAll(async () => {
    lake = await createLake(HOSTILE);
    reader = createCatalogReader(await openDuckdb({ path: lake.profile.path }));
    catalog = catalogOfReader(reader, (await reader.info()).latestSnapshot);
    session = await openSqlSession({ access: accessFor(lake), mode: 'read-only' });
  });
  afterAll(async () => {
    await session.close();
    await reader.close();
    await lake.remove();
    await service.dispose();
  });

  async function complete(text: string) {
    const cursor = marked(text);
    const result = await service.complete(cursor.text, cursor.offset, catalog);
    if (!result) throw new Error('No completion.');
    return result;
  }

  /** Every statement runs without an error event. */
  async function runs(statements: readonly string[]): Promise<void> {
    const list = await events(session, statements.join(';\n'));
    expect(only(list, 'error')).toEqual([]);
    expect(only(list, 'resultSet')).toHaveLength(statements.length);
  }

  async function runsOn(writer: SqlSession, statements: readonly string[], what?: string): Promise<void> {
    expect(only(await events(writer, statements.join(';\n')), 'error'), what).toEqual([]);
  }

  it('quotes a name exactly when it needs it, in every position, and every inserted text runs', async () => {
    const columnsResult = await complete('select | from "my schema"."order"');
    const columns = columnsResult.items.filter(({ kind }) => kind === 'column');
    expect(columns.map(({ label, insertText }) => [label, insertText])).toEqual([
      ['from', '"from"'],
      ['my col', '"my col"'],
      ['ünï', '"ünï"'],
      ['"quoted"', '"""quoted"""'],
      ['normal', 'normal'],
      ['1abc', '"1abc"'],
      ['ORDER', '"ORDER"'],
      ['Select', '"Select"'],
    ]);
    await runs(columns.map(({ insertText }) => `SELECT ${insertText} FROM "my schema"."order"`));

    const result = await complete('select * from |');
    const relations = result.items.filter(({ kind }) => kind === 'table' || kind === 'view');
    expect(relations.map(({ label, insertText }) => [label, insertText])).toEqual([
      ['größe', '"größe"'],
      ['Mixed', 'Mixed'],
      ['Odd Name', '"Odd Name"'],
      ['ok_name', 'ok_name'],
      ['orders', 'orders'],
      ['日本語', '"日本語"'],
      ['my schema.all rows', '"my schema"."all rows"'],
      ['my schema.order', '"my schema"."order"'],
      ['sch"ema.select', '"sch""ema"."select"'],
    ]);
    expect(result.items.filter(({ kind }) => kind === 'schema').map(({ insertText }) => insertText)).toEqual([
      'lake',
      'main',
      '"my schema"',
      '"sch""ema"',
    ]);
    await runs(relations.map(({ insertText }) => `SELECT count(*) FROM ${insertText}`));

    // After a schema, also when the word before the cursor is not quoted.
    for (const text of [
      'select * from "my schema".|',
      'select * from "my schema".or|',
      'select * from lake."my schema".|',
    ]) {
      expect(
        (await complete(text)).items.map(({ insertText }) => insertText),
        text,
      ).toEqual(['"all rows"', '"order"']);
    }
    expect((await complete('select * from "sch""ema".|')).items.map(({ insertText }) => insertText)).toEqual([
      '"select"',
    ]);

    // Inside a quoted word the range includes the quote and the names are written with quotes, never without.
    const open = await complete('select * from "my schema"."or|');
    expect(open.insert).toEqual({ offset: 26, length: 3 });
    expect(open.items.map(({ insertText }) => insertText)).toEqual(['"all rows"', '"order"']);
    expect((await complete('select * from "my schema"."or|" where 1 = 1')).insert).toEqual({
      offset: 26,
      length: 4,
    });
    const quoted = await complete('select * from "sc|');
    expect(quoted.items.filter(({ kind }) => kind === 'schema').map(({ insertText }) => insertText)).toEqual([
      '"lake"',
      '"main"',
      '"my schema"',
      '"sch""ema"',
    ]);
    // Tables of the other schemas come with both names quoted.
    const inQuotes = quoted.items
      .filter(({ kind }) => kind === 'table' || kind === 'view')
      .map(({ insertText }) => insertText);
    expect(inQuotes).toEqual([
      '"größe"',
      '"Mixed"',
      '"Odd Name"',
      '"ok_name"',
      '"orders"',
      '"日本語"',
      '"my schema"."all rows"',
      '"my schema"."order"',
      '"sch""ema"."select"',
    ]);
    await runs(inQuotes.map((text) => `SELECT count(*) FROM ${text}`));
  });

  it('warns of a misspelt name and its quick fix puts in the nearest, quoted where it needs it, so that the statement runs', async () => {
    // Per warning, the names that its quick fix offers.
    const misspelt: Record<string, (readonly string[])[]> = {
      'SELECT "my coll" FROM "my schema"."order"': [['"my col"']],
      'SELECT fron, normel FROM "my schema"."order"': [['"from"'], ['normal']],
      'SELECT * FROM "my schema"."ordr"': [['"order"']],
      'SELECT * FROM "sch""ema".selct': [['"select"']],
      'SELECT * FROM odd_name': [['"Odd Name"', 'ok_name']],
    };
    const actual: Record<string, (readonly string[])[]> = {};
    for (const text of Object.keys(misspelt)) {
      const problems = (await service.diagnose(text, 'quick fix', catalog)) ?? [];
      actual[text] = problems.map(({ replacements }) => replacements);
      const repaired = problems.toReversed().reduce((result, problem) => {
        const [fix] = quickFixes(problem);
        return fix ? result.slice(0, fix.offset) + fix.text + result.slice(fix.offset + fix.length) : result;
      }, text);
      await runs([repaired]);
    }
    expect(actual).toEqual(misspelt);
  });

  it('offers the functions of the lake, and every one of them, with its example, and every DuckLake statement snippet runs on a lake', async () => {
    const other = await createLake([
      'CREATE TABLE orders (id INTEGER)',
      ...[1, 2, 3, 4].map((id) => `INSERT INTO orders VALUES (${id})`),
    ]);
    const writer = await openSqlSession({ access: accessFor(other), mode: 'read-write' });
    // The example of ducklake_add_data_files names a file that the test writes first.
    const file = join(dirname(other.profile.path), 'new_orders.parquet').replaceAll('\\', '/');
    const runnable = (example: string): string =>
      example.replaceAll('{lake}', 'lake').replace("'new_orders.parquet'", `'${file}'`);
    try {
      await runsOn(writer, [`COPY (SELECT 5 AS id) TO '${file}'`]);
      for (const fn of [...LAKE_FUNCTIONS, ...GLOBAL_LAKE_FUNCTIONS]) {
        await runsOn(writer, fn.examples.map(runnable), fn.name);
      }
      // The statements with nothing left to fill in, their placeholders at the defaults.
      const snippets = (await service.complete('', 0, EMPTY_CATALOG))?.items
        .filter(({ kind, insertText }) => kind === 'snippet' && /^(CALL|CHECKPOINT)\b/.test(insertText))
        .map(({ insertText }) => insertText.replace(/\$\{\d+:([^}]*)\}/g, '$1'));
      expect(snippets?.length).toBeGreaterThan(5);
      await runsOn(writer, snippets ?? []);
      const installed = (
        await events(
          writer,
          "SELECT function_name FROM duckdb_functions() WHERE function_name LIKE 'ducklake\\_%' ESCAPE '\\'",
        )
      ).flatMap((event) => (event.kind === 'resultSet' ? event.rows.map(([name]) => String(name)) : []));
      for (const fn of LAKE_FUNCTIONS) expect(installed, fn.name).toContain(`ducklake_${fn.name}`);
    } finally {
      await writer.close();
      await other.remove();
    }
  });

  it('inserts a timestamp literal and a version that select exactly the snapshot they are offered for', async () => {
    const result = await complete('select * from orders at (timestamp => |');
    const snapshots = await catalog.snapshots();
    expect(result.items).toHaveLength(snapshots.length);
    // The inserts are the snapshots after the creation of `orders`: the table has one more row with each of them.
    const created = snapshots.findLast(({ changes }) => changes?.includes('created_table:"main"."orders"'));
    expect(created).toBeDefined();
    for (const [index, snapshot] of snapshots.entries()) {
      if (snapshot.id <= (created?.id ?? 0)) continue;
      const literal = result.items[index]?.insertText ?? '';
      const [counted] = only(
        await events(session, `SELECT count(*) FROM orders AT (TIMESTAMP => ${literal})`),
        'resultSet',
      );
      expect(counted?.rows, `snapshot ${snapshot.id}`).toEqual([[String(snapshot.id - (created?.id ?? 0))]]);
    }

    const versions = await complete('select * from orders at (version => |');
    expect(versions.items.length).toBeGreaterThan(5);
    const [first] = versions.items;
    const [counted] = only(
      await events(session, `SELECT count(*) FROM orders AT (VERSION => ${first?.insertText})`),
      'resultSet',
    );
    expect(counted?.rows).toEqual([['4']]);
  });
});
