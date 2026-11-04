import { describe, expect, it } from 'vitest';
import type { ColumnInfo, SchemaInfo, TableInfo, ViewInfo } from '../../src/catalog/model';
import type { ConnectionProfile } from '../../src/connections/profile';
import type { RelationColumn } from '../../src/data/types';
import {
  changeDetail,
  columnDescription,
  columnTooltip,
  connectionTooltip,
  columnTagDetail,
  macroDescription,
  macroTooltip,
  partitionDetail,
  schemaTooltip,
  sortDetail,
  tableDescription,
  tableTooltip,
  viewColumnTooltip,
  viewTooltip,
} from '../../src/tree/format';
import type { ConnectionState } from '../../src/tree/refs';

const sales: SchemaInfo = { id: 1, name: 'sales', comment: null };

function table(overrides: Partial<TableInfo> = {}, stats: Partial<TableInfo['stats']> = {}): TableInfo {
  return {
    id: 2,
    schemaId: 1,
    name: 'orders',
    comment: 'Customer orders',
    stats: { rows: 2, files: 1, sizeBytes: 1953, ...stats },
    ...overrides,
  };
}

function column(overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    id: 9,
    name: 'amount',
    type: 'decimal(10,2)',
    nullable: true,
    defaultValue: '0',
    comment: 'Net amount in EUR',
    children: [],
    ...overrides,
  };
}

const bigOrders: ViewInfo = {
  id: 4,
  schemaId: 1,
  name: 'big_orders',
  comment: 'Orders above 1',
  sql: 'SELECT * FROM sales.orders WHERE (amount > 1)',
  dialect: 'duckdb',
  columnAliases: [],
};

const sqliteProfile: ConnectionProfile = {
  id: 'lake',
  name: 'Local lake',
  kind: 'sqlite',
  path: 'D:\\data\\ducklake.sqlite',
};

describe('the figures that the tooltips and the completion show', () => {
  it('writes the size of the data files in B, KB, MB, GB and TB with one decimal at most', () => {
    const sizes: [number, string][] = [
      [0, '0 B'],
      [1023, '1023 B'],
      [1024, '1 KB'],
      [1536, '1.5 KB'],
      [1953, '1.9 KB'],
      [1024 ** 2, '1 MB'],
      [Math.round(2.5 * 1024 ** 2), '2.5 MB'],
      [3 * 1024 ** 3, '3 GB'],
      [1234567890123, '1.1 TB'],
      [1024 ** 2 - 1, '1 MB'],
    ];
    for (const [sizeBytes, expected] of sizes) {
      expect(tableTooltip(sales, table({}, { sizeBytes })), String(sizeBytes)).toContain(
        `- Size: ${expected}`,
      );
    }
  });

  it('separates the thousands of the counts, and marks an approximate row count with a tilde', () => {
    const counts: [number, string][] = [
      [0, '0 rows'],
      [1, '1 row'],
      [1234567, '1,234,567 rows'],
    ];
    for (const [rows, expected] of counts) {
      expect(tableDescription(table({}, { rows })), String(rows)).toBe(expected);
    }
    expect(tableTooltip(sales, table({}, { rows: 12345678, files: 1200 }))).toContain(
      ': 12,345,678\n- Data files: 1,200\n',
    );

    const approximate = table({}, { rows: 3, approximate: true });
    expect(tableDescription(approximate)).toBe('~3 rows');
    expect(tableTooltip(sales, approximate)).toContain('): ~3');
    expect(tableTooltip(sales, table({}, { rows: 3 }))).not.toContain('~');
  });
});

describe('the Markdown of the tooltips', () => {
  it('shows the SQL of a view in a code block that backticks and invisible characters cannot break out of', () => {
    const fence = viewTooltip(sales, { ...bigOrders, comment: null, sql: "SELECT '```' AS fence" });
    expect(fence).toContain("````sql\nSELECT '```' AS fence\n````");

    const hidden = `SELECT 1 /*${String.fromCharCode(0x202e)}*/${String.fromCharCode(0x200b)}\tFROM t${String.fromCharCode(0x2028)}WHERE${String.fromCharCode(7)}\r\nx`;
    expect(viewTooltip(sales, { ...bigOrders, sql: hidden })).toContain(
      '```sql\nSELECT 1 /**/\tFROM tWHERE\r\nx\n```',
    );

    const tooltip = viewTooltip(sales, {
      ...bigOrders,
      comment: null,
      sql: "SELECT '```' -- [x](u) <b>\n</b>",
      dialect: 'a_b *c*',
    });
    expect(tooltip).toContain('a\\_b \\*c\\*');
    expect(tooltip).toContain("````sql\nSELECT '```' -- [x](u) <b>\n</b>\n````");
  });

  it('keeps a default value with a backtick inside its code span, and shows an empty default', () => {
    const spans: [string, string][] = [
      ['`0', '`` `0 ``'],
      ['0`', '`` 0` ``'],
      ['`0`', '`` `0` ``'],
      ['a`b', '``a`b``'],
      ['', '``'],
    ];
    for (const [defaultValue, span] of spans) {
      expect(columnTooltip(sales, table(), ['a'], column({ defaultValue, comment: null }))).toContain(
        `- Default: ${span}`,
      );
    }
    const name = column({ id: 3, name: 'name', type: 'varchar', defaultValue: null, comment: null });
    expect(columnTooltip(sales, table(), ['customer', 'name'], name)).toContain(
      '`sales.orders.customer.name`',
    );
  });

  it('shows a comment literally: no formatting, link, heading, list or entity, and the line breaks kept', () => {
    const comment = 'See [the docs](https://example.org) for **bold** <b>html</b> & `code` | a_b ~c~ # d';
    expect(tableTooltip(sales, table({ comment }))).toContain(
      'See \\[the docs\\]\\(https\\:\\/\\/example\\.org\\) for \\*\\*bold\\*\\* \\<b\\>html\\<\\/b\\> \\& \\`code\\` \\| a\\_b \\~c\\~ \\# d',
    );
    expect(tableTooltip(sales, table({ comment: 'First line\r\nSecond line' }))).toContain(
      'First line  \nSecond line',
    );
    expect(tableTooltip(sales, table({ comment: 'C:\\data\\.hidden' }))).toContain(
      'C\\:\\\\data\\\\\\.hidden',
    );
    expect(
      tableTooltip(sales, table({ comment: 'Columns:\n- id\n1. first\nTitle\n=====\nSee &lt;b&gt;' })),
    ).toContain('Columns\\:  \n\\- id  \n1\\. first  \nTitle  \n\\=\\=\\=\\=\\=  \nSee \\&lt\\;b\\&gt\\;');
    expect(schemaTooltip({ id: 1, name: 's', comment: '@user ~ [x]' })).toContain(
      String.raw`\@user \~ \[x\]`,
    );
    expect(schemaTooltip(sales)).toBeUndefined();
    expect(schemaTooltip({ ...sales, comment: '' })).toBeUndefined();
  });

  it('shows the same hostile text literally in every sink, and the name of a connection and a path too', () => {
    // A backslash that could cancel an escape, a link, emphasis, HTML, a heading, a table cell, strikethrough, a code span and a Windows line break.
    const hostile = 'a\\[x](u) *b* _c_ <i>d</i> # e | f ~g~ `h`\r\ni';
    const escaped = 'a\\\\\\[x\\]\\(u\\) \\*b\\* \\_c\\_ \\<i\\>d\\<\\/i\\> \\# e \\| f \\~g\\~ \\`h\\`  \ni';
    const failed = (error: string): ConnectionState => ({ status: 'error', snapshot: 'latest', error });
    const sinks: [string, string][] = [
      ['connection error', connectionTooltip(sqliteProfile, failed(hostile))],
      ['schema comment', schemaTooltip({ ...sales, comment: hostile }) ?? ''],
      ['table comment', tableTooltip(sales, table({ comment: hostile }))],
      ['view comment', viewTooltip(sales, { ...bigOrders, comment: hostile })],
      ['view dialect', viewTooltip(sales, { ...bigOrders, dialect: hostile })],
      ['column comment', columnTooltip(sales, table(), ['amount'], column({ comment: hostile }))],
    ];
    for (const [sink, tooltip] of sinks) {
      expect(tooltip, sink).toContain(escaped);
    }

    expect(
      connectionTooltip(sqliteProfile, failed('Cannot read "C:\\data\\my_lake_1.sqlite": ENOENT.')),
    ).toContain('Cannot read \\"C\\:\\\\data\\\\my\\_lake\\_1\\.sqlite\\"\\: ENOENT\\.');
    const profile: ConnectionProfile = { ...sqliteProfile, name: 'Prod *and* [link](x)' };
    expect(connectionTooltip(profile, { status: 'disconnected', snapshot: 'latest' })).toContain(
      '**Prod \\*and\\* \\[link\\]\\(x\\)** (sqlite)',
    );
  });

  it('removes the characters that reorder or hide text: bidirectional controls, zero-width characters, separators and control codes', () => {
    const hostile = String.fromCharCode(
      ...[
        0x61, 0x202e, 0x62, 0x200b, 0x63, 0x2028, 0x64, 0x2029, 0x65, 0, 0x66, 7, 0x67, 0x202d, 0x68, 0x2066,
        0x69,
      ],
    );

    expect(tableTooltip(sales, table({ comment: hostile }))).toContain('abcdefghi');
    expect(tableTooltip(sales, table({ name: hostile }))).toContain('`sales.abc d efghi`');
    expect(columnTooltip(sales, table(), [hostile], column())).toContain('`sales.orders.abc d efghi`');
    expect(viewTooltip(sales, { ...bigOrders, name: hostile })).toContain('`sales.abc d efghi`');
    // A tab and the line breaks stay while the invisible characters around them go.
    expect(tableTooltip(sales, table({ comment: 'one​\ttwo\r\nthree‮\nfour' }))).toContain(
      'one\ttwo  \nthree  \nfour',
    );
  });

  it('keeps names and types with a backtick or a line break inside one code span', () => {
    // A blank line inside a code span would end the paragraph, and the rest would render as Markdown, e.g. as a link.
    const link = '[Click here](https://evil.example/x)';
    const id: RelationColumn = { name: 'id', type: 'INTEGER', nullable: false };
    expect(columnDescription(id)).toBe('INTEGER NOT NULL');
    expect(viewColumnTooltip(sales, bigOrders, id)).toContain('`sales.big_orders.id`');

    const backtick: RelationColumn = { name: 'a`b', type: 'STRUCT("`x" INTEGER)', nullable: true };
    expect(viewColumnTooltip(sales, bigOrders, backtick)).toBe(
      ['``sales.big_orders.a`b``', '', '- Type: ``STRUCT("`x" INTEGER)``', '- Nullable: yes'].join('\n'),
    );
    const broken: RelationColumn = {
      name: `a\n\n${link}`,
      type: `STRUCT("a\r\n\r\n${link}" INTEGER)`,
      nullable: true,
    };
    expect(viewColumnTooltip(sales, bigOrders, broken)).toBe(
      [
        `\`sales.big_orders.a ${link}\``,
        '',
        `- Type: \`STRUCT("a ${link}" INTEGER)\``,
        '- Nullable: yes',
      ].join('\n'),
    );

    const hostile = column({
      name: `x\n\n${link}`,
      type: `varchar\n\n${link}`,
      defaultValue: `'a\n\n${link}'`,
    });
    expect(columnTooltip(sales, table(), [`x\n\n${link}`], hostile).split('\n\n')).toEqual([
      `\`sales.orders.x ${link}\``,
      'Net amount in EUR',
      [`- Type: \`varchar ${link}\``, '- Nullable: yes', `- Default: \`'a ${link}'\``].join('\n'),
    ]);
    expect(schemaTooltip({ id: 1, name: `s\n\n${link}`, comment: 'Orders' })).toContain(`\`s ${link}\``);
    expect(tableTooltip(sales, table({ name: 'a\n- b\n# c\n\n    d', comment: null })).split('\n\n')[0]).toBe(
      '`sales.a - b # c d`',
    );
    expect(tableTooltip({ ...sales, name: 'x' }, table({ name: 'we`ird' })).split('\n')[0]).toBe(
      '``x.we`ird``',
    );
    expect(tableTooltip({ ...sales, name: 'x' }, table({ name: 't`' })).split('\n')[0]).toBe('`` x.t` ``');
  });
});

describe('the leaves of a table', () => {
  it('describes a tag, a sort expression and a partition column from what the catalog stores', () => {
    expect(
      columnTagDetail(sales, table(), { columnId: 3, path: ['customer', 'name'], key: 'pii', value: 'true' }),
    ).toMatchObject({ label: 'customer.name', description: 'pii: true' });
    expect(
      sortDetail(sales, table(), {
        expression: 'a',
        dialect: 'duckdb',
        direction: 'ASC',
        nullOrder: 'NULLS_LAST',
      }),
    ).toMatchObject({ label: 'a', description: 'ASC NULLS LAST' });
    expect(
      partitionDetail(sales, table(), { columnId: 2, path: ['info', 'c'], transform: 'bucket(4)' }),
    ).toMatchObject({ label: 'info.c', description: 'bucket(4)' });
  });

  it('writes a macro with typed parameters and defaults, by its first overload, and keeps its dialect out of the Markdown', () => {
    const macro = {
      id: 1,
      schemaId: 1,
      name: 'fee',
      kind: 'scalar' as const,
      implementations: [
        {
          dialect: '**d**',
          sql: 'x * y',
          parameters: [
            { name: 'x', type: 'INTEGER', defaultValue: null },
            { name: 'y', type: null, defaultValue: '2' },
          ],
        },
      ],
    };
    expect(macroDescription(macro)).toBe('scalar (x INTEGER, y := 2)');
    expect(macroDescription({ ...macro, kind: 'table', implementations: [] })).toBe('table ()');
    const overload = (...names: string[]) => ({
      dialect: 'duckdb',
      sql: 'x',
      parameters: names.map((name) => ({ name, type: null, defaultValue: null })),
    });
    expect(macroDescription({ ...macro, implementations: [overload('x', 'y'), overload('x')] })).toBe(
      'scalar (x, y)',
    );

    const tooltip = macroTooltip({ id: 1, name: 'shop', comment: null }, macro);
    expect(tooltip).toContain('Dialect: \\*\\*d\\*\\*');
    expect(tooltip).toContain('```sql\nx * y\n```');
  });

  it('shows a change that the catalog could not name as it was stored, and one it could name by its object', () => {
    expect(
      changeDetail({
        action: 'unknown',
        object: null,
        objectId: null,
        schemaName: null,
        name: null,
        raw: 'weird:x',
      }),
    ).toMatchObject({ label: 'weird:x', description: undefined });
    expect(
      changeDetail({
        action: 'created',
        object: 'schema',
        objectId: 1,
        schemaName: null,
        name: 'sales',
        raw: 'created_schema:"sales"',
      }),
    ).toMatchObject({ label: 'sales' });
  });
});
