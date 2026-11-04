import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import type { GridData } from '../../src/data/types';
import {
  isGridData,
  isOversizedTransfer,
  isResultsMessage,
  isWebviewMessage,
  MAX_FILE_NAME_CHARS,
  MAX_TRANSFER_CHARS,
  rowKindsOf,
} from '../../src/grid/protocol';
import type { ExtensionMessage, ResultsMessage, WebviewMessage } from '../../src/grid/protocol';
import { applyEvent, beginRun, endRun } from '../../src/grid/results-model';
import type { ResultsRunState } from '../../src/grid/results-model';
import { engineSkipReason } from './data-support';
import { realRun } from './results-support';
import type { RealRun } from './results-support';

const skipReason = await engineSkipReason();

describe('the message protocol', () => {
  it('has the documented shapes', () => {
    // These lines fail to compile when a message changes.
    const messages = [
      { type: 'ready' },
      { type: 'copy', text: 'a\tb', what: 'cell' },
      { type: 'copy', text: 'a\tb', what: 'row' },
      { type: 'copy', text: 'a\tb', what: 'all' },
      { type: 'export', csv: 'a\r\n', suggestedName: 'sales.orders.csv' },
      { type: 'reveal', index: 4 },
    ] satisfies WebviewMessage[];
    expectTypeOf<ExtensionMessage>().toEqualTypeOf<
      { readonly type: 'data'; readonly data: GridData } | ResultsMessage
    >();
    for (const message of messages) {
      expect(isWebviewMessage(message)).toBe(true);
    }
  });

  describe('the size a page may ask the host to copy or save', () => {
    const longest = 'x'.repeat(MAX_TRANSFER_CHARS);

    it('accepts the longest text and file name, refuses one character more, and calls only those oversized', () => {
      expect(isWebviewMessage({ type: 'copy', text: longest, what: 'all' })).toBe(true);
      expect(
        isWebviewMessage({
          type: 'export',
          csv: longest,
          suggestedName: 'n'.repeat(MAX_FILE_NAME_CHARS),
        }),
      ).toBe(true);

      const copy = { type: 'copy', text: `${longest}x`, what: 'all' };
      const exported = { type: 'export', csv: `${longest}x`, suggestedName: 'a.csv' };
      const named = { type: 'export', csv: 'a', suggestedName: 'n'.repeat(MAX_FILE_NAME_CHARS + 1) };

      for (const message of [copy, exported, named]) {
        expect(isWebviewMessage(message)).toBe(false);
        expect(isOversizedTransfer(message)).toBe(true);
      }
      for (const message of [
        { type: 'copy', text: 'a', what: 'all' },
        { type: 'copy', text: 'a', what: 'nothing' },
        { type: 'copy', text: 7 },
        { type: 'ready' },
        null,
        'copy',
      ]) {
        expect(isOversizedTransfer(message)).toBe(false);
      }
    });
  });

  it('accepts what survives a round trip through postMessage, and rejects malformed messages', () => {
    const sent: WebviewMessage = { type: 'copy', text: 'Zoë\t日本', what: 'row' };
    expect(isWebviewMessage(structuredClone(sent))).toBe(true);
    expect(isWebviewMessage(JSON.parse(JSON.stringify(sent)))).toBe(true);
    const rows: [string, unknown][] = [
      ['null', null],
      ['a string', 'ready'],
      ['an array', [{ type: 'ready' }]],
      ['no type', { text: 'x' }],
      ['an unknown type', { type: 'run', sql: 'DROP TABLE x' }],
      ['a reveal without an index', { type: 'reveal' }],
      ['a reveal with a negative index', { type: 'reveal', index: -1 }],
      ['a reveal with a fractional index', { type: 'reveal', index: 1.5 }],
      ['a reveal with the index as text', { type: 'reveal', index: '1' }],
      ['a reveal with an infinite index', { type: 'reveal', index: Infinity }],
      ['a copy without text', { type: 'copy', what: 'cell' }],
      ['a copy with a number as text', { type: 'copy', text: 5, what: 'cell' }],
      ['a copy with an unknown scope', { type: 'copy', text: 'x', what: 'everything' }],
      ['an export without a name', { type: 'export', csv: 'a' }],
      ['an export without csv', { type: 'export', suggestedName: 'a.csv' }],
      ['the data message of the other direction', { type: 'data', data: {} }],
    ];
    for (const [name, value] of rows) {
      expect(isWebviewMessage(value), name).toBe(false);
    }
  });
});

describe('the row kinds of a change grid', () => {
  const COLUMNS = ['snapshot_id', 'rowid', 'change_type', 'id'].map((name) => ({
    name,
    type: 'BIGINT',
    kind: 'number' as const,
  }));
  const grid = (rowKinds: unknown, rows = 4): GridData =>
    ({
      table: { schema: 'shop', table: 'customers' },
      columns: COLUMNS,
      rows: Array.from({ length: rows }, () => [1, 2, 'x', 3]),
      limit: 1000,
      truncated: false,
      elapsedMs: 1,
      rowKinds,
    }) as GridData;

  it('are taken as they are when they fit the rows, with every update as a pair', () => {
    const kinds = ['insert', 'update-before', 'update-after', 'delete'];

    expect(rowKindsOf(grid(kinds))).toEqual(kinds);
    expect(rowKindsOf(grid(['update-before', 'update-after', 'update-before', 'update-after']))).toHaveLength(
      4,
    );
    expect(rowKindsOf(grid([], 0))).toEqual([]);

    const sent: ExtensionMessage = { type: 'data', data: grid(['insert', 'delete', 'insert', 'insert']) };
    expect(rowKindsOf(structuredClone(sent).data)).toEqual(['insert', 'delete', 'insert', 'insert']);
  });

  it('are ignored when they do not fit the rows or the columns: the grid is drawn like a preview', () => {
    const rows: [string, unknown][] = [
      ['absent', undefined],
      ['not a list', 'insert'],
      ['too few', ['insert', 'delete']],
      ['too many', ['insert', 'delete', 'insert', 'insert', 'insert']],
      ['an unknown kind', ['insert', 'upsert', 'insert', 'insert']],
      ['an update-before without its partner', ['insert', 'update-before', 'insert', 'delete']],
      ['an update-after without its partner', ['update-after', 'insert', 'insert', 'delete']],
      ['an update-before at the end', ['insert', 'insert', 'insert', 'update-before']],
      ['two before rows in a row', ['update-before', 'update-before', 'update-after', 'delete']],
    ];
    for (const [name, kinds] of rows) {
      expect(rowKindsOf(grid(kinds)), name).toBeUndefined();
    }
    // The grid lacks the columns snapshot_id, rowid and change_type.
    expect(
      rowKindsOf({ ...grid(['insert', 'insert', 'insert', 'insert']), columns: COLUMNS.slice(0, 2) }),
    ).toBeUndefined();
  });
});

describe('the state of a run that was cut short', () => {
  const state: ResultsRunState = {
    script: 'SELECT 1; SELECT 2',
    statements: [
      {
        index: 0,
        sql: 'SELECT 1',
        offset: 0,
        status: 'ok',
        summary: '1 row',
        elapsedMs: 3,
        error: undefined,
      },
      {
        index: 1,
        sql: 'SELECT 2',
        offset: 10,
        status: 'not-run',
        summary: '',
        elapsedMs: undefined,
        error: undefined,
      },
    ],
    resultSets: [],
    end: { cancelled: true, failed: true, elapsedMs: 5, inTransaction: 'aborted' },
  };

  it('is accepted, with a statement that did not run and a transaction that is aborted, also through JSON', () => {
    const message = { type: 'results-state', state };

    expect(isResultsMessage(message)).toBe(true);
    expect(isResultsMessage(JSON.parse(JSON.stringify(message)))).toBe(true);
  });

  it('is refused when a time is not a number: of a statement, of a message or of a run', () => {
    const [first] = state.statements;
    const bad = (change: Record<string, unknown>) => ({
      type: 'results-state',
      state: { ...state, statements: [{ ...first, ...change }] },
    });

    expect(isResultsMessage(bad({ elapsedMs: '3' }))).toBe(false);
    expect(
      isResultsMessage({
        type: 'results-event',
        event: { kind: 'message', index: 0, text: 'Commands completed successfully.', elapsedMs: 1 },
      }),
    ).toBe(true);
    for (const elapsedMs of ['1', undefined]) {
      expect(
        isResultsMessage({
          type: 'results-event',
          event: { kind: 'message', index: 0, text: 'Commands completed successfully.', elapsedMs },
        }),
      ).toBe(false);
    }
  });
});

describe.skipIf(skipReason)('the messages of the results page', () => {
  let real: RealRun;
  beforeAll(async () => {
    real = await realRun();
  });

  const summary = { cancelled: false, failed: true, elapsedMs: 80, inTransaction: 'open' } as const;

  it('are accepted as they are, also after the round trip through postMessage and through JSON', () => {
    const state = endRun(real.events.reduce(applyEvent, beginRun(real.script)), summary);
    const messages: ResultsMessage[] = [
      { type: 'results-begin', script: real.script },
      ...real.events.map((event): ResultsMessage => ({ type: 'results-event', event })),
      { type: 'results-end', summary },
      { type: 'results-state', state },
    ];

    for (const message of messages) {
      expect(isResultsMessage(message)).toBe(true);
      expect(isResultsMessage(structuredClone(message))).toBe(true);
      expect(isResultsMessage(JSON.parse(JSON.stringify(message)))).toBe(true);
    }
    // None of the other messages of the page.
    expect(isResultsMessage({ type: 'data', data: {} })).toBe(false);
    expect(isResultsMessage({ type: 'ready' })).toBe(false);
    expect(isResultsMessage(null)).toBe(false);
    expect(isResultsMessage([])).toBe(false);
    expect(isResultsMessage('results-begin')).toBe(false);
  });

  it('refuse an event that is not what the session yields', () => {
    const find = (kind: string): object => real.events.find((event) => event.kind === kind) ?? {};
    const [start, resultSet, error] = [find('start'), find('resultSet'), find('error')];
    const event = (change: Record<string, unknown>, base: object) => ({
      type: 'results-event',
      event: { ...base, ...change },
    });
    const refused = [
      { type: 'results-event' },
      { type: 'results-event', event: null },
      event({ kind: 'oops' }, start),
      event({ index: -1 }, start),
      event({ index: 0.5 }, start),
      event({ index: '0' }, start),
      event({ sql: 5 }, start),
      event({ offset: -2 }, start),
      event({ statementType: undefined }, start),
      event({ truncated: 'no' }, resultSet),
      event({ elapsedMs: '5' }, resultSet),
      event({ rows: [[{ nested: 'object' }]] }, resultSet),
      event({ rows: ['a row that is no list'] }, resultSet),
      event({ rows: 'many' }, resultSet),
      event({ columns: [{ name: 'a', type: 'INTEGER', kind: 'integer' }] }, resultSet),
      event({ columns: [{ name: 'a', kind: 'number' }] }, resultSet),
      event({ columns: null }, resultSet),
      event({ message: 5 }, error),
      event({ position: { offset: 1 } }, error),
      event({ position: { offset: -1, length: 2 } }, error),
      event({ kind: 'message', text: 'x', elapsedMs: 1, rowsAffected: 'two' }, { index: 0 }),
      event({ kind: 'message', elapsedMs: 1 }, { index: 0 }),
    ];
    for (const message of refused) {
      expect(isResultsMessage(message), JSON.stringify(message).slice(0, 120)).toBe(false);
    }
  });

  it('refuse a begin, an end or a state that is not one, and take a state that is still running', () => {
    expect(isResultsMessage({ type: 'results-begin' })).toBe(false);
    expect(isResultsMessage({ type: 'results-begin', script: 5 })).toBe(false);
    expect(isResultsMessage({ type: 'results-end' })).toBe(false);
    for (const change of [
      { cancelled: 'no' },
      { failed: undefined },
      { elapsedMs: '5' },
      { inTransaction: 'maybe' },
    ]) {
      expect(isResultsMessage({ type: 'results-end', summary: { ...summary, ...change } })).toBe(false);
    }

    const state = real.events.reduce(applyEvent, beginRun(real.script));
    const [first] = state.statements;
    const [set] = state.resultSets;
    const bad = (change: Record<string, unknown>) => ({
      type: 'results-state',
      state: { ...state, ...change },
    });

    expect(isResultsMessage({ type: 'results-state', state })).toBe(true);
    for (const message of [
      { type: 'results-state' },
      { type: 'results-state', state: 'running' },
      bad({ script: 5 }),
      bad({ statements: 'none' }),
      bad({ statements: [{ ...first, status: 'done' }] }),
      bad({ statements: [{ ...first, index: -1 }] }),
      bad({ statements: [{ ...first, summary: undefined }] }),
      bad({ statements: [{ ...first, error: { message: 5 } }] }),
      bad({ resultSets: [{ ...set, statement: 'a' }] }),
      bad({ resultSets: [{ ...set, rows: [[undefined]] }] }),
      bad({ resultSets: [{ ...set, truncated: 0 }] }),
      bad({ end: { cancelled: false } }),
    ]) {
      expect(isResultsMessage(message), JSON.stringify(message).slice(0, 120)).toBe(false);
    }

    // A state that is still running has no end, also when it comes through JSON.
    expect(state.end).toBeUndefined();
    expect(isResultsMessage(JSON.parse(JSON.stringify({ type: 'results-state', state })))).toBe(true);
  });
});

describe('the data message of the grid page', () => {
  const data: GridData = {
    table: { schema: 'sales', table: 'orders' },
    columns: [
      { name: 'id', type: 'INTEGER', kind: 'number' },
      { name: 'note', type: 'VARCHAR', kind: 'text' },
    ],
    rows: [
      [1, 'a'],
      [2, null],
    ],
    limit: 1000,
    truncated: false,
    elapsedMs: 4,
  };

  it('accepts what the engine produces, also after a round trip through postMessage, and rejects the rest', () => {
    expect(isGridData(data)).toBe(true);
    expect(isGridData(structuredClone(data))).toBe(true);
    expect(isGridData({ ...data, rowKinds: ['insert', 'delete'], summary: '1 inserted' })).toBe(true);
    const rows: [string, unknown][] = [
      ['null', null],
      ['a list', [data]],
      ['no table', { ...data, table: undefined }],
      ['a table name that is a number', { ...data, table: { schema: 's', table: 1 } }],
      ['columns that are not a list', { ...data, columns: 'id' }],
      ['a column without a type', { ...data, columns: [{ name: 'id', kind: 'number' }] }],
      ['rows that hold an object', { ...data, rows: [[{}]] }],
      ['a row that is no list', { ...data, rows: ['x'] }],
      ['a limit as text', { ...data, limit: '1000' }],
      ['a negative limit', { ...data, limit: -1 }],
      ['a truncated flag as text', { ...data, truncated: 'no' }],
      ['no elapsed time', { ...data, elapsedMs: undefined }],
      ['row kinds that are no list of text', { ...data, rowKinds: [1] }],
      ['a summary that is a number', { ...data, summary: 3 }],
    ];
    for (const [name, value] of rows) {
      expect(isGridData(value), name).toBe(false);
    }
    // Fields of the message itself count, not what it inherits.
    expect(isGridData(Object.create(data) as object)).toBe(false);
    expect(isWebviewMessage(Object.create({ type: 'ready' }) as object)).toBe(false);
    expect(isResultsMessage(Object.create({ type: 'results-begin', script: 'x' }) as object)).toBe(false);
  });
});
