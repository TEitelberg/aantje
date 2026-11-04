import { describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile } from '../../src/connections/profile';
import { trustKey } from '../../src/data/trust';
import { createTrustStore } from '../../src/data/trust.vscode';

// `createTrustStore` reads a memento; the other export of the module asks the user, which these tests never do.
vi.mock('vscode', () => ({ window: {} }));

const KEY = 'aantje.trustedViews';

const sqlite: ConnectionProfile = {
  id: 'local',
  name: 'Local',
  kind: 'sqlite',
  path: 'D:\\data\\lake.sqlite',
};

/** A memento holding whatever an older version, another extension or a hand edit left under the key. */
function memento(initial: unknown) {
  const stored = new Map<string, unknown>([[KEY, initial]]);
  return {
    // Like the editor's: the default stands in for an unset value only, a stored null is returned.
    get: <T>(key: string, fallback?: T): T | undefined => {
      const value = stored.get(key) as T | undefined;
      return value === undefined ? fallback : value;
    },
    update: (key: string, value: unknown) => {
      stored.set(key, value);
      return Promise.resolve();
    },
    keys: () => [...stored.keys()],
    stored: () => stored.get(KEY),
  };
}

function trustStore(initial: unknown) {
  const state = memento(initial);
  const warnings: string[] = [];
  const store = createTrustStore(state, { warn: (message) => void warnings.push(message) });
  return { store, state, warnings };
}

describe('createTrustStore on a memento', () => {
  it('uses a stored list of keys as it is and warns neither about it nor about an unset key', () => {
    const { store, warnings } = trustStore([trustKey(sqlite)]);
    expect(store.isTrusted(sqlite)).toBe(true);
    expect(store.isTrusted({ ...sqlite, id: 'other' })).toBe(false);
    expect(warnings).toEqual([]);

    const unset = trustStore(undefined);
    expect(unset.store.isTrusted(sqlite)).toBe(false);
    expect(unset.warnings).toEqual([]);
  });

  it('treats a stored value that is no list of texts as no trust at all, warns once naming the key, and still lets the user trust a connection', async () => {
    for (const garbage of ['yes', { local: true }, ['ok', 7], null, 42]) {
      const { store, state, warnings } = trustStore(garbage);
      const label = JSON.stringify(garbage);

      expect(store.isTrusted(sqlite), label).toBe(false);
      await store.trust(sqlite);

      expect(store.isTrusted(sqlite), label).toBe(true);
      expect(Array.isArray(state.stored()), label).toBe(true);
      expect(
        (state.stored() as unknown[]).every((key) => typeof key === 'string'),
        label,
      ).toBe(true);
      expect(warnings, label).toHaveLength(1);
      expect(warnings[0], label).toContain(KEY);
    }
  });
});
