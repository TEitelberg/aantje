import { describe, expect, it } from 'vitest';
import { positionOf } from '../../src/sql/position';
import type { Position, State } from '../../src/sql/position';
import type { SqlToken } from '../../src/sql/tokens';

const state = (change: Partial<State>): { state: State } => ({
  state: {
    kind: 'statement',
    statement: undefined,
    clause: '',
    expectRelation: false,
    afterRelation: false,
    setTarget: false,
    createTarget: false,
    columnPath: false,
    inFrom: false,
    name: undefined,
    lambda: undefined,
    ...change,
  },
});

const OPERATORS = new Set(['(', ')', ',', '::', '=>', '*', ':']);

/** The tokens of the words, with the type that `sql_tokenize` gives them. */
const tokens = (...words: string[]): SqlToken[] =>
  words.map((word, index) => ({
    start: index * 2,
    end: index * 2 + 1,
    word,
    type: OPERATORS.has(word) ? 'OPERATOR' : /^[A-Z]+$/.test(word) ? 'KEYWORD' : 'IDENTIFIER',
  }));

const at = (chain: { state: State }[], ...words: string[]): Position => positionOf(chain, tokens(...words));

describe('positionOf', () => {
  it('knows only a keyword when no frame is open, and a type after a cast operator in every frame', () => {
    expect(at([])).toBe('keyword');
    expect(at([state({ clause: 'select', statement: 'SELECT' })], 'x', '::')).toBe('type');
    expect(at([state({ kind: 'values' })], '::')).toBe('type');
  });

  it.each<[string, string | undefined, Position]>([
    ['', undefined, 'statement'],
    ['', 'SELECT', 'keyword'],
    ['with', 'WITH', 'statement'],
    ['select', 'SELECT', 'expression'],
    ['returning', 'INSERT', 'expression'],
    ['limit', 'SELECT', 'value'],
    ['values', 'INSERT', 'value'],
    ['use', 'USE', 'schema'],
    ['call', 'CALL', 'call'],
    ['create-name', 'CREATE', 'name'],
    ['conflict', 'INSERT', 'keyword'],
    ['copy-to', 'COPY', 'name'],
    ['unpivot-into', 'UNPIVOT', 'keyword'],
  ])('maps the clause "%s" of %s to %s', (clause, statement, position) => {
    expect(at([state({ clause, statement })])).toBe(position);
  });

  it('distinguishes the setting from its value, and the column from the expression in SET', () => {
    const setting = state({ clause: 'setting', statement: 'SET' });
    expect(at([setting], 'SET')).toBe('setting');
    expect(at([setting], 'SET', 'threads', '=>')).toBe('value');
    expect(at([state({ clause: 'set', statement: 'UPDATE', setTarget: true })])).toBe('target-column');
    expect(at([state({ clause: 'set', statement: 'UPDATE' })])).toBe('expression');
  });

  it('names the relation that is expected by what the statement does with it', () => {
    expect(at([state({ clause: 'from', statement: 'SELECT', expectRelation: true })])).toBe('from');
    expect(at([state({ clause: 'from', statement: 'DELETE', expectRelation: true })])).toBe('relation');
    expect(
      at([state({ clause: 'create', statement: 'CREATE', expectRelation: true, createTarget: true })]),
    ).toBe('new-relation');
    expect(
      at([state({ clause: 'comment', statement: 'COMMENT', expectRelation: true, columnPath: true })]),
    ).toBe('column-path');
  });

  it('expects a name after AS, except for the query of CREATE VIEW and the type of CAST', () => {
    const outer = state({ clause: 'select', statement: 'SELECT' });
    expect(at([outer], 'AS')).toBe('name');
    expect(at([state({ clause: 'create', statement: 'CREATE' })], 'AS')).toBe('statement');
    expect(at([state({ kind: 'call', name: 'TRY_CAST' }), outer], 'x', 'AS')).toBe('type');
    expect(at([state({ kind: 'call', name: 'LOWER' }), outer], 'x', 'AS')).toBe('name');
  });

  it('reads the next keyword after a relation, and the parts of ALTER TABLE', () => {
    const after = [state({ clause: 'alter', statement: 'ALTER', afterRelation: true })];
    expect(at(after, 'orders')).toBe('keyword');
    expect(at(after, 'ALTER', 'COLUMN', 'x', 'TYPE')).toBe('type');
    expect(at(after, 'RENAME', 'TO')).toBe('name');
    expect(at(after, 'ADD', 'COLUMN')).toBe('name');
    expect(at(after, 'DROP', 'COLUMN')).toBe('target-column');
    expect(at(after, 'ALTER')).toBe('target-column');
    expect(at(after, 'ADD', 'c')).toBe('type');
  });

  it('knows the parts of AT (VERSION => ... , TIMESTAMP => ...)', () => {
    const snapshot = [state({ kind: 'snapshot' })];
    expect(at(snapshot, 'AT', '(')).toBe('snapshot-clause');
    expect(at(snapshot, 'VERSION', '=>')).toBe('snapshot-version');
    expect(at(snapshot, 'TIMESTAMP', '=>')).toBe('snapshot-timestamp');
    expect(at(snapshot, 'OTHER', '=>')).toBe('name');
  });

  it('completes the columns of a column list, the names and types of a CREATE TABLE list, values and nothing in a quiet frame', () => {
    expect(at([state({ kind: 'insert-columns' })], '(')).toBe('target-column');
    expect(at([state({ kind: 'column-list' })], 'a', ',')).toBe('target-column');
    expect(at([state({ kind: 'column-list' })], 'a')).toBe('keyword');
    const create = [state({ kind: 'create-columns' })];
    expect(at(create, '(')).toBe('name');
    expect(at(create, '(', 'a')).toBe('type');
    expect(at(create, '(', 'a', 'INTEGER')).toBe('keyword');
    expect(at([state({ kind: 'values' })], '(')).toBe('value');
    expect(at([state({ kind: 'quiet' })], '(')).toBe('name');
  });

  it('reads the frames of DuckDB: lambda heads, star lists, windows, pivots and the options of COPY', () => {
    const outer = state({ clause: 'select', statement: 'SELECT' });
    const call = (body: boolean): { state: State } =>
      state({ kind: 'call', lambda: { params: ['x'], body } });
    expect(at([call(false), outer], 'lambda', 'x', ',')).toBe('name');
    expect(at([call(true), outer], 'x', ':')).toBe('expression');
    expect(at([outer], 'SELECT', '*', 'EXCLUDE')).toBe('column');
    expect(at([outer], 'price', '*', 'EXCLUDE')).toBe('expression');
    expect(at([state({ kind: 'columns' }), outer], '(')).toBe('column');
    expect(at([state({ kind: 'replace' }), outer], '(')).toBe('expression');
    expect(at([state({ kind: 'replace' }), outer], 'x', 'AS')).toBe('column');
    expect(at([state({ kind: 'rename' }), outer], 'x', 'AS')).toBe('name');
    expect(at([state({ kind: 'window', clause: 'over' }), outer], '(')).toBe('keyword');
    expect(at([state({ kind: 'window', clause: 'partition' }), outer], 'BY')).toBe('expression');
    expect(at([state({ kind: 'pivot', name: 'PIVOT' })], '(')).toBe('expression');
    expect(at([state({ kind: 'pivot', name: 'UNPIVOT' })], '(')).toBe('name');
    expect(at([state({ clause: 'pivot', statement: 'PIVOT', expectRelation: true })])).toBe('from');
    const copy = [state({ kind: 'copy-options' })];
    expect(at(copy, '(')).toBe('copy-option');
    expect(at(copy, 'FORMAT')).toBe('copy-format');
    expect(at(copy, 'HEADER')).toBe('name');
  });

  it('asks the enclosing frame for a group, and for a call unless the call is a table function', () => {
    const outer = state({ clause: 'where', statement: 'SELECT' });
    expect(at([state({ kind: 'group' }), outer], '(')).toBe('expression');
    expect(at([state({ kind: 'call', name: 'LOWER' }), outer], '(')).toBe('expression');
    expect(at([state({ kind: 'call', name: 'READ_CSV', inFrom: true }), outer], '(')).toBe('value');
  });
});
