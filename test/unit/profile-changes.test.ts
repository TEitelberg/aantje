import { describe, expect, it } from 'vitest';
import type { ConnectionProfile } from '../../src/connections/profile';
import { invalidEntriesText, reopenedIds, signaturesOf } from '../../src/profile-changes';

const lake = (id: string, extra: Record<string, unknown> = {}): ConnectionProfile => ({
  id,
  name: `Lake ${id}`,
  kind: 'sqlite',
  path: `/data/${id}.sqlite`,
  ...extra,
});

describe('reopenedIds', () => {
  it('names only a connection whose way of opening changed: not a rename, not a new connection', () => {
    const before = signaturesOf([lake('a'), lake('b')]);

    expect(reopenedIds(before, [lake('a', { name: 'Renamed' }), lake('b')])).toEqual(new Set());
    expect(reopenedIds(before, [lake('a', { path: '/elsewhere.sqlite' }), lake('b')])).toEqual(
      new Set(['a']),
    );
    expect(reopenedIds(before, [lake('c')])).toEqual(new Set());
  });
});

describe('invalidEntriesText', () => {
  it('says nothing without invalid entries and names the number otherwise', () => {
    expect(invalidEntriesText(0)).toBeUndefined();
    expect(invalidEntriesText(1)).toContain('aantje.connections');
    expect(invalidEntriesText(3)).toContain('3');
  });
});
