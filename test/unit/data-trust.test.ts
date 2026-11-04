import { describe, expect, it } from 'vitest';
import type { ConnectionProfile, PostgresProfile } from '../../src/connections/profile';
import { ViewTrustStore } from '../../src/data/trust';
import type { MementoPort } from '../../src/data/trust';

const postgres: PostgresProfile = {
  id: 'wh',
  name: 'Warehouse',
  kind: 'postgres',
  host: 'db.example.org',
  port: 5432,
  database: 'lake',
  user: 'etl',
};
const sqlite: ConnectionProfile = {
  id: 'local',
  name: 'Local',
  kind: 'sqlite',
  path: 'D:\\data\\lake.sqlite',
};

/** A memento that stores JSON like the editor does, so that a value that is not plain data would show up. */
function memory(initial: readonly string[] = []): MementoPort & { stored(): string; updates(): number } {
  let json = JSON.stringify(initial);
  let updates = 0;
  return {
    get: () => JSON.parse(json) as string[],
    update: (value) => {
      json = JSON.stringify(value);
      updates++;
      return Promise.resolve();
    },
    stored: () => json,
    updates: () => updates,
  };
}

describe('ViewTrustStore', () => {
  it('trusts nothing until the user said so, then exactly that connection, also after a rename and in a new store on the same memento, with one entry per connection', async () => {
    const port = memory();
    const store = new ViewTrustStore(port);
    expect(store.isTrusted(postgres)).toBe(false);
    expect(store.isTrusted(sqlite)).toBe(false);

    await store.trust(sqlite);
    await store.trust(sqlite);

    expect(store.isTrusted(sqlite)).toBe(true);
    expect(store.isTrusted({ ...sqlite, name: 'Renamed' })).toBe(true);
    expect(store.isTrusted(postgres)).toBe(false);
    expect(port.get()).toHaveLength(1);
    expect(new ViewTrustStore(port).isTrusted(sqlite)).toBe(true);
  });

  it('asks again when the target of a connection is edited: host, port, database, user, metadata schema or TLS flag of PostgreSQL, file or kind of a file connection', async () => {
    const store = new ViewTrustStore(memory());
    await store.trust(postgres);
    await store.trust(sqlite);

    const edited: [string, ConnectionProfile][] = [
      ['host', { ...postgres, host: 'other.example.org' }],
      ['port', { ...postgres, port: 5433 }],
      ['database', { ...postgres, database: 'other' }],
      ['user', { ...postgres, user: 'admin' }],
      ['metadata schema', { ...postgres, metadataSchema: 'ducklake_meta' }],
      ['TLS flag', { ...postgres, ssl: true }],
      ['path', { ...sqlite, path: 'D:\\data\\other.sqlite' }],
      ['kind', { ...sqlite, kind: 'duckdb' }],
    ];
    for (const [what, profile] of edited) {
      expect(store.isTrusted(profile), what).toBe(false);
    }
  });

  it('ties the trust of a Quack connection to its server: another host or port asks again, a rename or a new certificate pin does not', async () => {
    const quack: ConnectionProfile = {
      id: 'q',
      name: 'Served',
      kind: 'quack',
      host: 'duckdb',
      port: 9494,
      ssl: true,
    };
    const store = new ViewTrustStore(memory());
    await store.trust(quack);

    expect(store.isTrusted({ ...quack, name: 'Renamed', fingerprint: 'AB' })).toBe(true);
    expect(store.isTrusted({ ...quack, host: 'other' })).toBe(false);
    expect(store.isTrusted({ ...quack, port: 9495 })).toBe(false);
  });

  it('does not treat an unset TLS flag and false as different, does not mix up the ids of two connections, and never stores a password', async () => {
    const port = memory();
    const store = new ViewTrustStore(port);
    await store.trust({ ...postgres, password: 'hunter2' } as typeof postgres);
    await store.trust({ ...sqlite, id: 'a' });

    expect(store.isTrusted({ ...postgres, ssl: false })).toBe(true);
    expect(store.isTrusted({ ...sqlite, id: 'a-2' })).toBe(false);
    expect(store.isTrusted({ ...sqlite, id: 'a b' })).toBe(false);
    expect(port.stored()).not.toContain('hunter2');
  });

  describe('revoke', () => {
    it('forgets one connection under every target it ever had, keeps the others, persists, and writes nothing for a connection that was never trusted', async () => {
      const port = memory();
      const store = new ViewTrustStore(port);
      const moved = { ...sqlite, path: 'D:\\data\\moved.sqlite' };
      await store.trust(postgres);
      await store.trust(sqlite);
      await store.trust(moved);

      await store.revoke(moved);

      expect(store.isTrusted(moved)).toBe(false);
      expect(store.isTrusted(sqlite)).toBe(false);
      expect(store.isTrusted(postgres)).toBe(true);
      expect(new ViewTrustStore(port).isTrusted(sqlite)).toBe(false);

      const before = port.updates();
      await store.revoke(sqlite);
      expect(port.updates()).toBe(before);

      await store.revokeAll();
      expect(store.isTrusted(postgres)).toBe(false);
      expect(port.get()).toEqual([]);
    });

    it('does not touch a connection whose id starts with the same letters or differs only by a character that is encoded in the key', async () => {
      const store = new ViewTrustStore(memory());
      const prefixed = { ...sqlite, id: 'local-2' };
      const spaced = { ...sqlite, id: 'a b' };
      const plain = { ...sqlite, id: 'a' };
      await store.trust(sqlite);
      await store.trust(prefixed);
      await store.trust(spaced);
      await store.trust(plain);

      await store.revoke(sqlite);
      await store.revoke(plain);

      expect(store.isTrusted(sqlite)).toBe(false);
      expect(store.isTrusted(plain)).toBe(false);
      expect(store.isTrusted(prefixed)).toBe(true);
      expect(store.isTrusted(spaced)).toBe(true);
    });
  });

  describe('onDidTrust', () => {
    it('tells the listener which connection was newly trusted, once the answer is stored, and stays silent for one that is trusted already and for revoking', async () => {
      const store = new ViewTrustStore(memory());
      const told: { id: string; trustedThen: boolean }[] = [];
      store.onDidTrust((profile) => told.push({ id: profile.id, trustedThen: store.isTrusted(profile) }));

      await store.trust(postgres);
      await store.trust(postgres);
      await store.revoke(postgres);
      await store.revokeAll();

      expect(told).toEqual([{ id: 'wh', trustedThen: true }]);
    });

    it('tells again when a connection is trusted again after it was revoked, and stops telling a listener that was disposed', async () => {
      const store = new ViewTrustStore(memory());
      const first: string[] = [];
      const second: string[] = [];
      const subscription = store.onDidTrust((profile) => first.push(profile.id));
      store.onDidTrust((profile) => second.push(profile.id));

      await store.trust(sqlite);
      subscription.dispose();
      await store.revoke(sqlite);
      await store.trust(sqlite);

      expect(first).toEqual(['local']);
      expect(second).toEqual(['local', 'local']);
    });
  });
});
