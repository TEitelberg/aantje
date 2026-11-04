import { describe, expect, it } from 'vitest';
import type { GridColumn, GridData, GridValue, RowKind } from '../../src/data/types';
import {
  cellCopyText,
  cellDisplay,
  cellText,
  changedColumns,
  csvFileName,
  filterRows,
  nextSort,
  restoreView,
  safeCsvFileName,
  saveView,
  sortRows,
  toCsv,
  toTsv,
} from '../../src/grid/model';

const MAX_CELL_CHARS = 2000;
const MAX_TITLE_CHARS = 1000;

type Row = readonly GridValue[];

const col = (name: string, type: string, kind: GridColumn['kind']): GridColumn => ({ name, type, kind });

// sales.orders of the test catalogs as the preview returns it (see test/fixtures/generate.py).
const ORDER_COLUMNS = [
  col('id', 'INTEGER', 'number'),
  col('customer', 'STRUCT(name VARCHAR, tags VARCHAR[])', 'nested'),
  col('attrs', 'MAP(VARCHAR, INTEGER)', 'nested'),
  col('amount', 'DECIMAL(10,2)', 'number'),
  col('created', 'TIMESTAMP', 'text'),
];
const ORDERS: Row[] = [
  [1, '{"name":"a","tags":["x"]}', '[{"key":"k","value":1}]', '1.50', '2026-01-01 00:00:00'],
  [2, '{"name":"b","tags":[]}', '[]', '2.50', '2026-01-02 00:00:00'],
  [3, null, null, '3.00', '2026-01-03 00:00:00'],
];

const ids = (rows: readonly Row[], column = 0): GridValue[] => rows.map((row) => row[column] ?? null);

/** Rows of one column, for sorting and filtering tests. */
const single = (...values: GridValue[]): Row[] => values.map((value) => [value]);

describe('the text of a cell', () => {
  it('shows a real NULL as NULL and keeps "" and the text "NULL" apart, and bounds what is drawn', () => {
    expect(cellText(null, 'number')).toEqual({ text: 'NULL', isNull: true });
    expect(cellText('', 'text')).toEqual({ text: '', isNull: false });
    expect(cellText('NULL', 'text')).toEqual({ text: 'NULL', isNull: false });
    expect(cellText(42, 'number').text).toBe('42');
    expect(cellText('9007199254740993', 'number').text).toBe('9007199254740993');
    expect(cellText('1.50', 'number').text).toBe('1.50');
    expect(cellText(false, 'boolean').text).toBe('false');
    expect(cellText('Zoë 日本', 'text').text).toBe('Zoë 日本');
    expect(cellText('{"name":"a","tags":["x"]}', 'nested').text).toBe('{"name":"a","tags":["x"]}');
    expect(cellText({ k: [1, 2] } as unknown as GridValue, 'nested').text).toBe('{"k":[1,2]}');
    // Copy cell is exact: NULL becomes nothing, the text "NULL" stays, a formula is never neutralised.
    expect(cellCopyText(null, 'text')).toBe('');
    expect(cellCopyText('NULL', 'text')).toBe('NULL');
    expect(cellCopyText('=1+1', 'text')).toBe('=1+1');

    // At most 2000 characters with a tooltip from 61 on, cut at 1000, never splitting a surrogate pair', () => {
    expect(cellDisplay('x'.repeat(60), 'text').title).toBe('');
    expect(cellDisplay('x'.repeat(61), 'text').title).toBe('x'.repeat(61));
    expect(cellDisplay('y'.repeat(MAX_CELL_CHARS), 'text').text).toBe('y'.repeat(MAX_CELL_CHARS));
    const over = cellDisplay('y'.repeat(MAX_CELL_CHARS + 1), 'text');
    expect(over.text).toBe(`${'y'.repeat(MAX_CELL_CHARS)}…`);
    expect(over.title).toBe(`${'y'.repeat(MAX_TITLE_CHARS)}…`);

    const huge = 'abc'.repeat(400_000);
    expect(cellDisplay(huge, 'text').text).toHaveLength(MAX_CELL_CHARS + 1);
    expect(cellCopyText(huge, 'text')).toBe(huge);

    const shown = cellDisplay(`x${'😀'.repeat(1500)}`, 'text').text;
    expect(shown.endsWith('…')).toBe(true);
    const last = shown.charCodeAt(shown.length - 2);
    expect(last >= 0xdc00 && last <= 0xdfff).toBe(true);

    // A screen reader hears a real NULL differently from the text "NULL".
    expect(cellDisplay(null, 'text')).toMatchObject({ isNull: true, text: 'NULL' });
    expect(cellDisplay(null, 'text').label).not.toBe('');
    expect(cellDisplay('NULL', 'text')).toMatchObject({ isNull: false, label: '' });
  });
});

describe('sorting', () => {
  it('goes ascending, descending, off for the same column and restarts for another column', () => {
    const asc = nextSort(undefined, 2);
    expect(asc).toEqual({ column: 2, direction: 'asc' });
    const desc = nextSort(asc, 2);
    expect(desc).toEqual({ column: 2, direction: 'desc' });
    expect(nextSort(desc, 2)).toBeUndefined();
    expect(nextSort(desc, 0)).toEqual({ column: 0, direction: 'asc' });
  });

  it('compares numbers, big integers, decimals, booleans, text and NULL the way a user expects', () => {
    const cases: [string, GridColumn['kind'], string, GridValue[], GridValue[]][] = [
      ['numbers by value, not as text', 'number', 'INTEGER', [10, 9, 100, 2, -5, 0], [-5, 0, 2, 9, 10, 100]],
      [
        'big integers that a double cannot tell apart',
        'number',
        'BIGINT',
        ['9007199254740993', '9007199254740992', '9007199254740994', '-9007199254740993'],
        ['-9007199254740993', '9007199254740992', '9007199254740993', '9007199254740994'],
      ],
      [
        'HUGEINT values mixed with numbers',
        'number',
        'HUGEINT',
        [
          '170141183460469231731687303715884105727',
          5,
          '-170141183460469231731687303715884105728',
          99999999999,
        ],
        [
          '-170141183460469231731687303715884105728',
          5,
          99999999999,
          '170141183460469231731687303715884105727',
        ],
      ],
      [
        'decimals given as strings, with signs, zeros, fraction lengths and leading zeros',
        'number',
        'DECIMAL(18,3)',
        ['10.5', '9.75', '-0.5', '-10', '0.000', '-0.0', '0.05', '0.5', '-0.55', '10.50', '007', '0009.5'],
        ['-10', '-0.55', '-0.5', '0.000', '-0.0', '0.05', '0.5', '007', '0009.5', '9.75', '10.5', '10.50'],
      ],
      [
        'Infinity, NaN and exponent values',
        'number',
        'DOUBLE',
        ['NaN', 3, 'Infinity', 1.5e21, '-Infinity', -2],
        ['-Infinity', -2, 3, 1.5e21, 'Infinity', 'NaN'],
      ],
      [
        'booleans false before true',
        'boolean',
        'BOOLEAN',
        [true, false, true, false],
        [false, false, true, true],
      ],
      [
        'text with numbers inside by number, ignoring case and accents',
        'text',
        'VARCHAR',
        ['item 10', 'item 2', 'Zebra', 'banana', 'Ärger', 'Apple', 'cherry'],
        ['Apple', 'Ärger', 'banana', 'cherry', 'item 2', 'item 10', 'Zebra'],
      ],
      ['NULL last in ascending order', 'number', 'INTEGER', [2, null, 1, null, 3], [1, 2, 3, null, null]],
    ];
    for (const [name, kind, type, values, ascending] of cases) {
      const columns = [col('c', type, kind)];
      expect(ids(sortRows(single(...values), columns, { column: 0, direction: 'asc' })), name).toEqual(
        ascending,
      );
    }
  });

  it('sorts the orders in both directions with NULL last, stays stable, and never modifies its input', () => {
    const copy = ORDERS.map((row) => [...row]);
    expect(ids(sortRows(ORDERS, ORDER_COLUMNS, { column: 3, direction: 'desc' }), 3)).toEqual([
      '3.00',
      '2.50',
      '1.50',
    ]);
    expect(ids(sortRows(ORDERS, ORDER_COLUMNS, { column: 1, direction: 'asc' }))).toEqual([1, 2, 3]);
    expect(ids(sortRows(ORDERS, ORDER_COLUMNS, { column: 1, direction: 'desc' }))).toEqual([2, 1, 3]);
    expect(
      ids(sortRows(single(2, null, 1), [col('n', 'INTEGER', 'number')], { column: 0, direction: 'desc' })),
    ).toEqual([2, 1, null]);
    expect(ORDERS).toEqual(copy);
    expect(sortRows(ORDERS, ORDER_COLUMNS, undefined)).toBe(ORDERS);
    expect(sortRows(ORDERS, ORDER_COLUMNS, { column: 9, direction: 'asc' })).toBe(ORDERS);

    const columns = [col('t', 'VARCHAR', 'text'), col('i', 'INTEGER', 'number')];
    const rows: Row[] = [
      ['a', 1],
      ['B', 2],
      ['A', 3],
      ['b', 4],
      ['a', 5],
    ];
    expect(ids(sortRows(rows, columns, { column: 0, direction: 'asc' }), 1)).toEqual([1, 3, 5, 2, 4]);
    expect(ids(sortRows(rows, columns, { column: 0, direction: 'desc' }), 1)).toEqual([2, 4, 1, 3, 5]);
  });
});

describe('filtering', () => {
  it('matches a substring of the shown text ignoring case, combines columns with AND, and takes NULL and !NULL', () => {
    expect(ids(filterRows(ORDERS, ORDER_COLUMNS, ['', '"NAME":"B"']))).toEqual([2]);
    expect(ids(filterRows(ORDERS, ORDER_COLUMNS, ['', '', '', '.50']))).toEqual([1, 2]);
    expect(ids(filterRows(ORDERS, ORDER_COLUMNS, ['', '', '', '.50', '01-02']))).toEqual([2]);
    expect(filterRows(ORDERS, ORDER_COLUMNS, ['1', '', '', '2.50'])).toEqual([]);
    expect(ids(filterRows(ORDERS, ORDER_COLUMNS, ['', ' null ']))).toEqual([3]);
    expect(ids(filterRows(ORDERS, ORDER_COLUMNS, ['', '!NULL']))).toEqual([1, 2]);
    // A plain text never matches a NULL cell although it is shown as NULL; spaces in a text filter count.
    expect(filterRows(ORDERS, ORDER_COLUMNS, ['', '', 'ul'])).toEqual([]);
    const text = [col('t', 'VARCHAR', 'text')];
    expect(ids(filterRows(single('NULL', null, 'nullable'), text, ['nul']))).toEqual(['NULL', 'nullable']);
    expect(ids(filterRows(single('a b', 'ab', 'a'), text, ['a ']))).toEqual(['a b']);
    expect(ids(filterRows(single('a b', 'ab', 'a'), text, ['a b ']))).toEqual([]);
    expect(ids(filterRows(single('Zoë', 'Zoe', '日本語'), text, ['ZOË']))).toEqual(['Zoë']);
    expect(ids(filterRows(single(true, false, null), [col('b', 'BOOLEAN', 'boolean')], ['tru']))).toEqual([
      true,
    ]);
    // Empty filters return the rows themselves.
    expect(filterRows(ORDERS, ORDER_COLUMNS, [])).toBe(ORDERS);
    expect(filterRows(ORDERS, ORDER_COLUMNS, ['', '', '', '', ''])).toBe(ORDERS);
  });
});

/** A small RFC 4180 reader, to prove that what toCsv writes can be read back. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (quoted) {
      if (char === '"' && text.charAt(i + 1) === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\r' && text.charAt(i + 1) === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i++;
    } else {
      field += char;
    }
  }
  return records;
}

describe('the CSV export', () => {
  it('writes the orders with a header row, CRLF line ends, NULL as an empty field and no byte order mark', () => {
    const csv = toCsv(ORDER_COLUMNS, ORDERS);
    expect(csv).toBe(
      'id,customer,attrs,amount,created\r\n' +
        '1,"{""name"":""a"",""tags"":[""x""]}","[{""key"":""k"",""value"":1}]",1.50,2026-01-01 00:00:00\r\n' +
        '2,"{""name"":""b"",""tags"":[]}",[],2.50,2026-01-02 00:00:00\r\n' +
        '3,,,3.00,2026-01-03 00:00:00\r\n',
    );
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(toCsv(ORDER_COLUMNS, [])).toBe('id,customer,attrs,amount,created\r\n');
  });

  it('quotes fields with commas, quotes and line breaks, also in the header, and writes a single empty field as ""', () => {
    const columns = [col('a,b', 'VARCHAR', 'text'), col('say "hi"', 'VARCHAR', 'text')];
    const rows: Row[] = [
      ['x,y', 'he said "no"'],
      ['line1\nline2', 'cr\rlf'],
      [' padded ', 'Zoë 日本'],
    ];
    expect(toCsv(columns, rows)).toBe(
      '"a,b","say ""hi"""\r\n"x,y","he said ""no"""\r\n"line1\nline2","cr\rlf"\r\n padded ,Zoë 日本\r\n',
    );
    // A blank line is no record: a single column writes an empty field as "".
    expect(toCsv([col('a', 'VARCHAR', 'text')], single(null, 'x', '', null))).toBe(
      'a\r\n""\r\nx\r\n""\r\n""\r\n',
    );
    expect(toCsv(ORDER_COLUMNS, [[null, null, null, null, null]])).toBe(
      'id,customer,attrs,amount,created\r\n,,,,\r\n',
    );
  });

  it('puts a quote in front of text that a spreadsheet would run as a formula, and leaves plain numbers alone', () => {
    const rows = single(
      '=1+1',
      '+1',
      '@SUM(A1)',
      '\tx',
      '\rx',
      '-5',
      '-1.50',
      '-1+1',
      '-cmd|calc',
      '-',
      '-1e5',
      '-.5',
      '- 5',
      '1-1',
      'a=b',
      ' =1',
      '',
      null,
      "'=1",
    );
    const columns = [col('t', 'VARCHAR', 'text'), col('n', 'INTEGER', 'number')];
    expect(
      toCsv(
        columns,
        rows.map((row) => [...row, 7]),
      ),
    ).toBe(
      [
        't,n',
        "'=1+1,7",
        "'+1,7",
        "'@SUM(A1),7",
        "'\tx,7",
        '"\'\rx",7',
        '-5,7',
        '-1.50,7',
        "'-1+1,7",
        "'-cmd|calc,7",
        "'-,7",
        "'-1e5,7",
        "'-.5,7",
        "'- 5,7",
        '1-1,7',
        'a=b,7',
        ' =1,7',
        ',7',
        ',7',
        "'=1,7",
        '',
      ].join('\r\n'),
    );
  });

  it('neutralises column names and text cells, but never numbers, booleans and nested values, in CSV and TSV alike', () => {
    const typed = [
      col('n', 'INTEGER', 'number'),
      col('d', 'DECIMAL(10,2)', 'number'),
      col('b', 'BOOLEAN', 'boolean'),
      col('j', 'JSON', 'nested'),
    ];
    expect(toCsv(typed, [['=1+1', '+3', false, '@x']])).toBe('n,d,b,j\r\n=1+1,+3,false,@x\r\n');
    // The catalog chooses column names.
    expect(
      toCsv([col('=HYPERLINK("http://x")', 'VARCHAR', 'text'), col('ok', 'INTEGER', 'number')], []),
    ).toBe('"\'=HYPERLINK(""http://x"")",ok\r\n');
    const columns = [col('=total', 'VARCHAR', 'text'), col('n', 'INTEGER', 'number')];
    expect(toTsv(columns, [['=1+1', -5]], false)).toBe("'=1+1\t-5");
    expect(toTsv(columns, [['@SUM(A1:A9)', 3]], true)).toBe("'=total\tn\n'@SUM(A1:A9)\t3");
  });

  it('can be read back unchanged, whatever the cells contain', () => {
    const alphabet = ['a', 'Z', ' ', ',', '"', '\n', '\r', '\r\n', '\t', 'ö', '日', '{', "'", ';'];
    let seed = 12345;
    const next = (max: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    const text = (): string =>
      Array.from({ length: next(8) }, () => alphabet[next(alphabet.length)]).join('');
    const columns = [col('a', 'VARCHAR', 'text'), col('b', 'VARCHAR', 'text'), col('c', 'INTEGER', 'number')];
    const rows: Row[] = Array.from({ length: 300 }, () => [text(), text(), next(1000)]);
    const parsed = parseCsv(toCsv(columns, rows));
    expect(parsed).toHaveLength(301);
    expect(parsed[0]).toEqual(['a', 'b', 'c']);
    // Text that starts with a tab or a CR is the one thing the export changes, by a leading quote.
    const written = (value: GridValue): string =>
      typeof value === 'string' && /^[\t\r]/.test(value) ? `'${value}` : String(value);
    expect(parsed.slice(1)).toEqual(rows.map((row) => row.map(written)));
  });
});

describe('the clipboard text of Copy row and Copy all', () => {
  it('is tab separated with LF, no line break at the end, and quotes fields with tabs, line breaks and quotes', () => {
    expect(toTsv(ORDER_COLUMNS, ORDERS.slice(1), true)).toBe(
      'id\tcustomer\tattrs\tamount\tcreated\n' +
        '2\t"{""name"":""b"",""tags"":[]}"\t[]\t2.50\t2026-01-02 00:00:00\n' +
        '3\t\t\t3.00\t2026-01-03 00:00:00',
    );
    expect(toTsv(ORDER_COLUMNS, [ORDERS[0] ?? []], false)).toBe(
      '1\t"{""name"":""a"",""tags"":[""x""]}"\t"[{""key"":""k"",""value"":1}]"\t1.50\t2026-01-01 00:00:00',
    );
    expect(
      toTsv([col('t', 'VARCHAR', 'text')], [['a\tb'], ['c\nd'], ['e"f'], ['plain, with comma']], false),
    ).toBe('"a\tb"\n"c\nd"\n"e""f"\nplain, with comma');
  });
});

describe('the file name of the export', () => {
  it('never returns a path or a device name for a file name, and is schema.table.csv for a table', () => {
    const cases: [string, string][] = [
      ['sales.orders.csv', 'sales.orders.csv'],
      ['report', 'report.csv'],
      ['Report.CSV', 'Report.csv'],
      ['Café sales 日本.csv', 'Café sales 日本.csv'],
      ['../../etc/passwd', '.._.._etc_passwd.csv'],
      ['/abs/path.csv', '_abs_path.csv'],
      ['C:\\Users\\x\\y.csv', 'C__Users_x_y.csv'],
      ['a\u0000b\nc.csv', 'a_b_c.csv'],
      ['aux.x.csv', '_aux.x.csv'],
      ['CON', '_CON.csv'],
      ['com1.csv', '_com1.csv'],
      ['Lpt9.data', '_Lpt9.data.csv'],
      ['nul .csv', '_nul.csv'],
      ['console.csv', 'console.csv'],
      ['com10.csv', 'com10.csv'],
      ['orders..csv', 'orders.csv'],
      ['orders. . .csv', 'orders.csv'],
      ['', 'export.csv'],
      ['...', 'export.csv'],
      ['.csv', 'export.csv'],
      ['a'.repeat(300), `${'a'.repeat(80)}.csv`],
      [`${'😀'.repeat(100)}.csv`, `${'😀'.repeat(80)}.csv`],
      [`${'a'.repeat(79)}.b`, `${'a'.repeat(79)}.csv`],
    ];
    for (const [name, safe] of cases) {
      expect(safeCsvFileName(name), name).toBe(safe);
      expect(safeCsvFileName(safe), safe).toBe(safe);
    }
    expect(csvFileName({ schema: 'sales', table: 'orders' })).toBe('sales.orders.csv');
    expect(csvFileName({ schema: 'a/b', table: 'c:d*e?"f"<g>|h\\i\nj' })).toBe('a_b.c_d_e__f__g__h_i_j.csv');
    expect(csvFileName({ schema: 'aux', table: 't' })).toBe('_aux.t.csv');
    expect(csvFileName({ schema: '..', table: '..' })).toBe('export.csv');
    expect(csvFileName({ schema: 's'.repeat(300), table: 't' })).toHaveLength(84);
  });
});

describe('the saved view', () => {
  const data: GridData = {
    table: { schema: 'sales', table: 'orders' },
    columns: ORDER_COLUMNS,
    rows: ORDERS,
    limit: 1000,
    truncated: false,
    elapsedMs: 12.4,
  };
  const none = { sort: undefined, filters: ['', '', '', '', ''] };

  it('brings sort and filters back for the same result, and starts fresh for a new result or a broken state', () => {
    const view = { sort: { column: 3, direction: 'desc' as const }, filters: ['', 'b', '', '2', ''] };
    expect(restoreView(saveView(data, view), data)).toEqual(view);
    expect(restoreView(JSON.parse(JSON.stringify(saveView(data, view))), data)).toEqual(view);
    expect(restoreView(saveView(data, none), data)).toEqual(none);

    const saved = saveView(data, { sort: { column: 0, direction: 'asc' }, filters: ['1', '', '', '', ''] });
    expect(restoreView(saved, { ...data, elapsedMs: 13.1 })).toEqual(none);
    expect(restoreView(saved, { ...data, rows: ORDERS.slice(1) })).toEqual(none);
    expect(restoreView(saved, { ...data, table: { schema: 'sales', table: 'tmp' } })).toEqual(none);

    const broken: unknown[] = [
      undefined,
      null,
      'sorted',
      { filters: ['a'] },
      { filters: [1, 2, 3, 4, 5] },
      { sort: { column: 5, direction: 'asc' } },
      { sort: { column: -1, direction: 'asc' } },
      { sort: { column: 0.5, direction: 'asc' } },
      { sort: { column: 0, direction: 'up' } },
      { sort: 3 },
      { sort: null },
    ];
    for (const change of broken) {
      const state =
        typeof change === 'object' && change !== null ? { ...saveView(data, none), ...change } : change;
      expect(restoreView(state, data), JSON.stringify(change)).toEqual(none);
    }
  });
});

describe('the changed cells of an update pair', () => {
  const pair = (before: Row, after: Row): [Row[], readonly RowKind[]] => [
    [before, after],
    ['update-before', 'update-after'],
  ];

  it('are the columns of the table that differ, the same for both rows, without the feed columns and the neighbours', () => {
    const rows: Row[] = [
      ['16', '1', 'insert', 2, 'bob', 'bronze'],
      ['17', '1', 'update_preimage', 2, 'bob', 'bronze'],
      ['17', '1', 'update_postimage', 2, 'bobby', 'gold'],
      ['17', '2', 'update_preimage', 3, 'cy', null],
      ['17', '2', 'update_postimage', 3, 'cy', null],
      ['18', '3', 'delete', 4, 'di', 'silver'],
    ];
    const kinds: RowKind[] = [
      'insert',
      'update-before',
      'update-after',
      'update-before',
      'update-after',
      'delete',
    ];
    expect([...changedColumns(rows, kinds, 1)]).toEqual([4, 5]);
    expect([...changedColumns(rows, kinds, 2)]).toEqual([4, 5]);
    // The pair of rowid 2 differs only in change_type, which is no column of the table; a NULL that stays is no change.
    expect([...changedColumns(rows, kinds, 3)]).toEqual([]);
    expect([...changedColumns(rows, kinds, 4)]).toEqual([]);
    // An insert that looks like the row after it, and a delete next to a post-image, have no partner.
    expect([...changedColumns(rows, kinds, 0)]).toEqual([]);
    expect([...changedColumns(rows, kinds, 5)]).toEqual([]);

    const nulls = pair(
      ['5', '0', 'update_preimage', 1, null, 'x'],
      ['5', '0', 'update_postimage', 1, 'n', null],
    );
    expect([...changedColumns(...nulls, 0)]).toEqual([4, 5]);
    expect([...changedColumns(...nulls, 1)]).toEqual([4, 5]);
    const first = pair(['5', '0', 'update_preimage', 1, 'a'], ['5', '0', 'update_postimage', 2, 'a']);
    expect([...changedColumns(...first, 0)]).toEqual([3]);
    const toEmpty = pair(['5', '0', 'update_preimage', 1, null], ['5', '0', 'update_postimage', 1, '']);
    expect([...changedColumns(...toEmpty, 0)]).toEqual([4]);
    const fromText = pair(['5', '0', 'update_preimage', 1, 'null'], ['5', '0', 'update_postimage', 1, null]);
    expect([...changedColumns(...fromText, 1)]).toEqual([4]);
  });
});
