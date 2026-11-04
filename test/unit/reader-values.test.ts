import { describe, expect, it } from 'vitest';
import type { Driver, Row } from '../../src/catalog/drivers/driver';
import type { CatalogReader, ColumnInfo } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { toIsoUtc } from '../../src/catalog/timestamp';

/** A reader whose database answers every statement with `rows`. */
function readerOver(rows: readonly Row[]): CatalogReader {
  return createCatalogReader({ query: () => Promise.resolve([...rows]), close: () => Promise.resolve() });
}

/** What a driver returns for a column that the catalog got wrong: a value outside the types of `Row`. */
const unchecked = (row: Record<string, unknown>): Row => row as Row;

describe('toIsoUtc', () => {
  it('converts the timestamps the drivers return to ISO UTC with milliseconds, whatever the time zone of the process is', () => {
    const conversions: readonly [input: string, expected: string][] = [
      // The text SQLite keeps from DuckDB, an ISO string from a driver, short and long fractions (truncated, never rounded).
      ['2026-10-29 21:22:46.430739+00', '2026-10-29T21:22:46.430Z'],
      ['2026-10-29T21:22:46.430Z', '2026-10-29T21:22:46.430Z'],
      ['2026-10-29 21:22:46.5+00', '2026-10-29T21:22:46.500Z'],
      ['2026-10-29 21:22:46+00', '2026-10-29T21:22:46.000Z'],
      ['2026-10-29T21:22:46.999999999Z', '2026-10-29T21:22:46.999Z'],
      // Offsets in hours, with minutes crossing midnight, without a colon, of the writer's time zone; padding.
      ['2026-10-29 23:22:46.25+02', '2026-10-29T21:22:46.250Z'],
      ['2026-10-29 21:22:46-03:30', '2026-10-30T00:52:46.000Z'],
      ['2026-10-29 21:22:46+0530', '2026-10-29T15:52:46.000Z'],
      ['2026-10-30 04:24:28.031742+05:30', '2026-10-29T22:54:28.031Z'],
      [' 2026-10-29 21:22:46+00 ', '2026-10-29T21:22:46.000Z'],
    ];
    const before = process.env.TZ;
    try {
      for (const zone of ['America/New_York', 'Asia/Kolkata', 'UTC']) {
        process.env.TZ = zone;
        for (const [input, expected] of conversions) {
          expect(toIsoUtc(input), `${input} in ${zone}`).toBe(expected);
        }
      }
    } finally {
      if (before === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = before;
      }
    }
  });

  it('rejects a text that is no timestamp with an offset instead of inventing a time', () => {
    for (const value of [
      'yesterday',
      '2026-10-29 21:22:46',
      '2026-10-29 21:22:46.430739',
      'x2026-10-29 21:22:46+00',
      '2026-10-29 21:22:46+00 garbage',
      '2026-10-29 21:22:46+00:00:00',
    ]) {
      expect(() => toIsoUtc(value), value).toThrow();
    }
  });
});

describe('the scalar values of the catalog', () => {
  it('reads a boolean flag from 0 and 1 (SQLite) and from booleans (PostgreSQL, DuckDB), and rejects anything else', async () => {
    const nullable = (value: unknown) =>
      readerOver([unchecked({ ...columnRow(1, null, 'c', 'int32', 1), nulls_allowed: value })]).columns(1, 1);
    for (const [value, expected] of [
      [1, true],
      [0, false],
      [true, true],
      [false, false],
    ] as const) {
      expect((await nullable(value))[0]?.nullable, String(value)).toBe(expected);
    }
    for (const value of [null, undefined, 2, 'maybe', '', 't', 'f', 'true', '1', 'TRUE']) {
      await expect(nullable(value), String(value)).rejects.toThrow();
    }
  });

  it('reads a number as it is and rejects text, NULL and what is not finite', async () => {
    const schemaId = (value: unknown) =>
      readerOver([unchecked({ schema_id: value, schema_name: 's', comment_text: null })]).schemas(1);
    for (const value of [13, 0, 1160, 2.5]) {
      expect((await schemaId(value))[0]?.id).toBe(value);
    }
    for (const value of [
      null,
      undefined,
      '',
      '   ',
      '13',
      'abc',
      true,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      await expect(schemaId(value), String(value)).rejects.toThrow();
    }
  });

  it('reads the column aliases of a view as DuckLake writes them: quoted, with commas and quotes inside a name', async () => {
    const aliases = async (stored: string | null) =>
      (
        await readerOver([
          {
            view_id: 1,
            schema_id: 1,
            view_name: 'v',
            comment_text: null,
            sql: 'SELECT 1',
            dialect: 'duckdb',
            column_aliases: stored,
          },
        ]).views(1, 1)
      )[0]?.columnAliases;
    expect(await aliases('')).toEqual([]);
    expect(await aliases(null)).toEqual([]);
    expect(await aliases('"x","y"')).toEqual(['x', 'y']);
    expect(await aliases('"p,q","r""s","z"')).toEqual(['p,q', 'r"s', 'z']);
  });
});

/** One `ducklake_column` row joined with its comment, as the queries return it. */
function columnRow(
  id: number,
  parent: number | null,
  name: string,
  type: string,
  nullsAllowed: number | boolean,
  rest: { value?: string | null; valueType?: string | null; comment?: string | null } = {},
): Row {
  return {
    column_id: id,
    parent_column: parent,
    column_name: name,
    column_type: type,
    nulls_allowed: nullsAllowed,
    default_value: rest.value === undefined ? 'NULL' : rest.value,
    default_value_type: rest.valueType === undefined ? 'literal' : rest.valueType,
    comment_text: rest.comment ?? null,
  };
}

const leaf = (id: number, name: string, type: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  id,
  name,
  type,
  nullable: true,
  defaultValue: null,
  comment: null,
  children: [],
  ...extra,
});

describe('the column tree of a table', () => {
  const columnTree = (rows: readonly Row[]): Promise<ColumnInfo[]> => readerOver(rows).columns(1, 1);

  /** sales.orders as SQLite returns it: nullability as 0/1, nested parents with an empty default type. */
  const ordersRows = (flag: (nullable: boolean) => number | boolean): Row[] => [
    columnRow(1, null, 'id', 'int32', flag(false)),
    columnRow(2, null, 'customer', 'struct', flag(true), { valueType: '' }),
    columnRow(3, 2, 'name', 'varchar', flag(true)),
    columnRow(4, 2, 'tags', 'list', flag(true), { valueType: '' }),
    columnRow(5, 4, 'element', 'varchar', flag(true)),
    columnRow(6, null, 'attrs', 'map', flag(true), { valueType: '' }),
    columnRow(7, 6, 'key', 'varchar', flag(true)),
    columnRow(8, 6, 'value', 'int32', flag(true)),
    columnRow(9, null, 'amount', 'decimal(10,2)', flag(true), { value: '0', comment: 'Net amount in EUR' }),
    columnRow(10, null, 'created', 'timestamp', flag(true)),
  ];

  const ordersTree: ColumnInfo[] = [
    leaf(1, 'id', 'int32', { nullable: false }),
    leaf(2, 'customer', 'struct', {
      children: [
        leaf(3, 'name', 'varchar'),
        leaf(4, 'tags', 'list', { children: [leaf(5, 'element', 'varchar')] }),
      ],
    }),
    leaf(6, 'attrs', 'map', { children: [leaf(7, 'key', 'varchar'), leaf(8, 'value', 'int32')] }),
    leaf(9, 'amount', 'decimal(10,2)', { defaultValue: '0', comment: 'Net amount in EUR' }),
    leaf(10, 'created', 'timestamp'),
  ];

  it('nests struct fields, list elements and map keys and values below their parent, from 0/1 flags as from booleans', async () => {
    expect(await columnTree(ordersRows((nullable) => Number(nullable)))).toEqual(ordersTree);
    expect(await columnTree(ordersRows((nullable) => nullable))).toEqual(ordersTree);
    expect(await columnTree([])).toEqual([]);
  });

  it('nests as deep as the types do and keeps the order of the rows among siblings', async () => {
    // events list<struct<tags list<varchar>, at timestamp>>
    const rows = [
      columnRow(1, null, 'events', 'list', 1, { valueType: '' }),
      columnRow(2, 1, 'element', 'struct', 1, { valueType: '' }),
      columnRow(3, 2, 'tags', 'list', 1, { valueType: '' }),
      columnRow(4, 3, 'element', 'varchar', 1),
      columnRow(5, 2, 'at', 'timestamp', 1),
    ];
    expect(await columnTree(rows)).toEqual([
      leaf(1, 'events', 'list', {
        children: [
          leaf(2, 'element', 'struct', {
            children: [
              leaf(3, 'tags', 'list', { children: [leaf(4, 'element', 'varchar')] }),
              leaf(5, 'at', 'timestamp'),
            ],
          }),
        ],
      }),
    ]);
  });

  it('turns the stored default of a column into a SQL expression: literals quoted by type, expressions as they are', async () => {
    // The stored values are the ones DuckLake 1.1 writes for the defaults named in the comments.
    const defaults: readonly [
      type: string,
      value: string | null,
      valueType: string | null,
      expected: string | null,
    ][] = [
      ['int32', 'NULL', 'literal', null], // no default
      ['struct', 'NULL', '', null], // no default on a struct (nested parents have an empty type)
      ['int32', null, null, null], // an SQL NULL default
      ['varchar', null, null, null],
      ['int32', '-7', 'literal', '-7'],
      ['decimal(10,2)', '1.25', 'literal', '1.25'],
      ['boolean', 'true', 'literal', 'true'],
      ['uint8', '200', 'literal', '200'],
      ['float64', '1.5', 'literal', '1.5'],
      ['float32', '-0.25', 'literal', '-0.25'],
      ['varchar', 'abc', 'literal', "'abc'"], // a string needs quotes as an expression
      ['varchar', '', 'literal', "''"],
      ['varchar', "it's", 'literal', "'it''s'"],
      ['varchar', "it's a 'quoted' word", 'literal', "'it''s a ''quoted'' word'"],
      ['float64', 'nan', 'literal', "'nan'"], // NaN and infinities are no numbers in SQL
      ['float64', 'inf', 'literal', "'inf'"],
      ['float64', '-inf', 'literal', "'-inf'"],
      ['date', '2020-01-01', 'literal', "'2020-01-01'"],
      ['timestamp', '2020-01-01 10:00:00', 'literal', "'2020-01-01 10:00:00'"],
      ['timestamp', 'now()', 'expression', 'now()'],
      ['int32', '(1 + 2)', 'expression', '(1 + 2)'],
      ['varchar', "'NULL'", 'expression', "'NULL'"], // the string 'NULL', which DuckLake keeps apart from NULL
    ];
    for (const [type, value, valueType, expected] of defaults) {
      const [only] = await columnTree([columnRow(1, null, 'c', type, 1, { value, valueType })]);
      expect(only?.defaultValue, `${type} ${String(value)} (${String(valueType)})`).toBe(expected);
    }
  });
});

describe('tags that the database returns in any order', () => {
  it('lists the tags of the table by key and those of the columns by column, then by key', async () => {
    // The statement has no ORDER BY, and PostgreSQL and DuckDB give no order for a UNION.
    const tag = (columnId: number | null, key: string): Row => ({
      column_id: columnId,
      key,
      value: `${key}!`,
    });
    const driver: Driver = {
      query: (sql) =>
        Promise.resolve(
          sql.includes("g.key <> 'comment'")
            ? [tag(null, 'z'), tag(8, 'a'), tag(2, 'z'), tag(null, 'a'), tag(2, 'm')]
            : [columnRow(2, null, 'title', 'varchar', 1), columnRow(8, null, 'size', 'int32', 1)],
        ),
      close: () => Promise.resolve(),
    };

    const tags = await createCatalogReader(driver).tags(12, 56);

    expect(tags.table.map(({ key }) => key)).toEqual(['a', 'z']);
    expect(tags.columns).toEqual([
      { columnId: 2, path: ['title'], key: 'm', value: 'm!' },
      { columnId: 2, path: ['title'], key: 'z', value: 'z!' },
      { columnId: 8, path: ['size'], key: 'a', value: 'a!' },
    ]);
  });
});
