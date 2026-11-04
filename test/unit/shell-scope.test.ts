import { describe, expect, it } from 'vitest';
import { isReportScope, scopeKey, scopeOfNode } from '../../src/shell/scope';

describe('the scope of a report', () => {
  it('is the lake for a connection and the schema for a schema node, and nothing for other nodes', () => {
    const schema = { id: 4, name: 'shop', comment: null };

    expect(scopeOfNode({ kind: 'connection', connectionId: 'c' })).toEqual({ kind: 'lake' });
    expect(scopeOfNode({ kind: 'schema', connectionId: 'c', schema })).toEqual({
      kind: 'schema',
      id: 4,
      name: 'shop',
    });
    expect(scopeOfNode({ kind: 'message', connectionId: 'c', text: 'x' })).toBeUndefined();
  });

  it('keeps the panel of a schema apart from the lake and from another schema', () => {
    const keys = [
      scopeKey('c', { kind: 'lake' }),
      scopeKey('c', { kind: 'schema', id: 1, name: 'a' }),
      scopeKey('c', { kind: 'schema', id: 2, name: 'b' }),
      scopeKey('d', { kind: 'lake' }),
    ];

    expect(new Set(keys).size).toBe(4);
  });

  it('accepts the two shapes and nothing else from a page message', () => {
    expect(isReportScope({ kind: 'lake' })).toBe(true);
    expect(isReportScope({ kind: 'schema', id: 1, name: 'shop' })).toBe(true);
    expect(isReportScope({ kind: 'schema', id: 1 })).toBe(false);
    expect(isReportScope({ kind: 'schema', id: -1, name: 'shop' })).toBe(false);
    expect(isReportScope({ kind: 'table', id: 1, name: 'x' })).toBe(false);
    expect(isReportScope(undefined)).toBe(false);
  });
});
