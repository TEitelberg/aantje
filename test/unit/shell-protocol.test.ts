import { describe, expect, it } from 'vitest';
import { isCount, isOneOf, isOptional, isString } from '../../src/guards';
import { actionGuard, isShellRequest } from '../../src/shell/protocol';

const isFilterView = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && typeof (value as { filter?: unknown }).filter === 'string';

describe('what the extension accepts from any report page besides its actions', () => {
  it('accepts ready, refresh and Open as Markdown with a view that the guard knows or none', () => {
    for (const value of [
      { type: 'ready' },
      { type: 'refresh' },
      { type: 'markdown' },
      { type: 'markdown', view: { filter: 'table' } },
      { type: 'markdown', view: undefined },
    ]) {
      expect(isShellRequest(value, isFilterView), JSON.stringify(value)).toBe(true);
    }
  });

  it('rejects everything else, and takes a view only from a guard that knows its shape', () => {
    for (const value of [
      null,
      undefined,
      'ready',
      42,
      [],
      [{ type: 'ready' }],
      {},
      { type: 'READY' },
      { type: 'ready', view: {} },
      { type: 'ready', extra: true },
      { type: 'refresh', snapshot: 3 },
      { type: 'markdown', text: '# my own document' },
      { type: 'markdown', markdown: '# my own document' },
      { type: 'markdown', view: 'table' },
      { type: 'markdown', view: null },
      { type: 'markdown', view: { filter: 3 } },
      { type: 'markdown', view: [] },
      { type: 'action', action: 'x' },
      Object.create({ type: 'ready' }),
      Object.create({ type: 'markdown' }),
    ]) {
      expect(isShellRequest(value, isFilterView), JSON.stringify(value)).toBe(false);
    }
    const none = (): boolean => false;
    expect(isShellRequest({ type: 'markdown' }, none)).toBe(true);
    expect(isShellRequest({ type: 'markdown', view: { filter: 'x' } }, none)).toBe(false);
  });
});

describe('the guard for the actions of a report', () => {
  const guard = actionGuard({
    open: { id: isCount },
    compare: { id: isCount, against: isOneOf('previous', 'latest', 'other'), other: isOptional(isCount) },
    refreshAll: {},
  });

  it('accepts every declared action with exactly its fields', () => {
    for (const value of [
      { type: 'action', action: 'open', id: 3 },
      { type: 'action', action: 'compare', id: 0, against: 'latest' },
      { type: 'action', action: 'compare', id: 1, against: 'other', other: 5 },
      { type: 'action', action: 'refreshAll' },
    ]) {
      expect(guard(value), JSON.stringify(value)).toBe(true);
    }
  });

  it('rejects undeclared actions, wrong fields and what is no action', () => {
    const rows: [string, unknown][] = [
      ['an action that nobody declared', { type: 'action', action: 'quit' }],
      ['a command id as the action', { type: 'action', action: 'workbench.action.quit' }],
      ['the name of an inherited property as the action', { type: 'action', action: 'toString' }],
      ['the prototype as the action', { type: 'action', action: '__proto__' }],
      ['the constructor as the action', { type: 'action', action: 'constructor' }],
      ['a different letter case', { type: 'action', action: 'Open', id: 1 }],
      ['an action without its field', { type: 'action', action: 'open' }],
      ['a field of the wrong kind', { type: 'action', action: 'open', id: '3' }],
      ['a fraction as a count', { type: 'action', action: 'open', id: 1.5 }],
      ['a negative count', { type: 'action', action: 'open', id: -1 }],
      ['a choice that is not offered', { type: 'action', action: 'compare', id: 1, against: 'run' }],
      ['a field of another action', { type: 'action', action: 'open', id: 1, against: 'latest' }],
      ['a field that nobody declared', { type: 'action', action: 'open', id: 1, command: 'quit' }],
      [
        'a field with the name of an inherited property',
        { type: 'action', action: 'open', id: 1, toString: 'x' },
      ],
      ['a list as the action, whose text is a known action', { type: 'action', action: ['open'], id: 1 }],
      ['free text next to an action without fields', { type: 'action', action: 'refreshAll', text: 'DROP' }],
      ['no type', { action: 'refreshAll' }],
      ['another type', { type: 'markdown', action: 'refreshAll' }],
      ['an array', [{ type: 'action', action: 'refreshAll' }]],
      ['null', null],
      ['a string', 'refreshAll'],
      [
        'the action from the prototype',
        Object.assign(Object.create({ action: 'refreshAll' }) as object, { type: 'action' }),
      ],
      [
        'a field from the prototype',
        Object.assign(Object.create({ id: 5 }) as object, { type: 'action', action: 'open' }),
      ],
    ];
    for (const [name, value] of rows) {
      expect(guard(value), name).toBe(false);
    }
  });

  it('checks an optional field and every field with the test it was declared with', () => {
    const base = { type: 'action', action: 'compare', id: 1, against: 'other' };
    expect(guard(base)).toBe(true);
    expect(guard({ ...base, other: undefined })).toBe(true);
    expect(guard({ ...base, other: 2 })).toBe(true);
    expect(guard({ ...base, other: '2' })).toBe(false);
    expect(guard({ ...base, other: -1 })).toBe(false);
    const named = actionGuard({ rename: { to: isString } });
    expect(named({ type: 'action', action: 'rename', to: 'x' })).toBe(true);
    expect(named({ type: 'action', action: 'rename', to: 4 })).toBe(false);
  });
});
