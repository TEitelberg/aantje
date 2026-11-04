import { describe, expect, it } from 'vitest';
import type { SecretsPort, SettingsPort } from '../../src/connections/ports';
import type { ConnectionProfile, FileProfile, PostgresProfile } from '../../src/connections/profile';
import { passwordSecretKey, passwordSecretValue, toSettingEntry } from '../../src/connections/profile';
import { ConnectionStore } from '../../src/connections/store';

/**
 * The setting as the JSON text the editor persists. Every read returns a fresh, frozen copy, so a store that
 * changes what it read in place fails instead of silently corrupting the editor's configuration.
 */
class MemorySettings implements SettingsPort {
  text: string | undefined;
  writes = 0;

  constructor(initial?: unknown) {
    this.text = initial === undefined ? undefined : JSON.stringify(initial);
  }

  read(): unknown {
    return this.text === undefined ? undefined : deepFreeze(JSON.parse(this.text) as unknown);
  }

  write(value: unknown): Promise<void> {
    this.text = JSON.stringify(value);
    this.writes++;
    return Promise.resolve();
  }
}

class MemorySecrets implements SecretsPort {
  readonly values = new Map<string, string>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

function setup(initialSetting: unknown, registerSecret?: (value: string) => void) {
  const settings = new MemorySettings(initialSetting);
  const secrets = new MemorySecrets();
  return { settings, secrets, store: new ConnectionStore(settings, secrets, registerSecret) };
}

const example: PostgresProfile = {
  id: 'example-lakehouse',
  name: 'Example Lakehouse',
  kind: 'postgres',
  host: 'postgres',
  port: 5432,
  database: 'ducklake',
  user: 'ducklake',
  ssl: false,
};
const lab: PostgresProfile = { ...example, id: 'lab', name: 'Lab', host: 'lab.example.org', ssl: true };
const fixture: FileProfile = {
  id: 'fixture',
  name: 'Fixture',
  kind: 'sqlite',
  path: 'D:\\data\\ducklake.sqlite',
};
const duck: FileProfile = { id: 'duck', name: 'Duck', kind: 'duckdb', path: '/data/d.duckdb' };

/** Entries a user may have typed into settings.json that aantje cannot (or need not) interpret. */
const HAND_EDITED: unknown[] = [
  { name: 'Broken', kind: 'postgres', database: 'lake', user: 'reader' },
  'a stray string',
  { name: 'Future', kind: 'clickhouse', endpoint: 'https://example.org' },
  { id: 'prod', name: 'Prod', kind: 'sqlite', path: '/prod.sqlite', comment: 'an unknown property' },
  null,
];

const INVALID = { code: 'INVALID_PROFILE' };

describe('adding a connection', () => {
  it('writes the profile without a password to the setting and the password, bound to the server, to the secret storage', async () => {
    const { settings, secrets, store } = setup([]);
    // A deleted profile with the same id may have left a password behind; it must not be inherited.
    secrets.values.set(passwordSecretKey(lab.id), 'stale-pw');

    await store.add(example, 's3cret-pw');
    await store.add(lab);

    expect(settings.text).toBe(JSON.stringify([toSettingEntry(example), toSettingEntry(lab)]));
    expect(settings.text).not.toContain('s3cret-pw');
    expect([...secrets.values]).toStrictEqual([
      ['aantje.connection.example-lakehouse.password', passwordSecretValue(example, 's3cret-pw')],
    ]);
    expect(await store.password(example)).toBe('s3cret-pw');
    expect(await store.password(lab)).toBeUndefined();
    expect(store.list()).toStrictEqual([example, lab]);
    expect(store.get('example-lakehouse')).toStrictEqual(example);
  });

  it('never stores a secret for a SQLite or DuckDB file', async () => {
    const { settings, secrets, store } = setup([]);

    await store.add(fixture, 'ignored-pw');
    await store.add(duck, 'ignored-pw');

    expect(secrets.values.size).toBe(0);
    expect(settings.text).toBe(JSON.stringify([toSettingEntry(fixture), toSettingEntry(duck)]));
  });

  it('refuses a name (ignoring case) or an id that is in use, writes nothing and leaves the existing password alone', async () => {
    const { settings, secrets, store } = setup([]);
    await store.add(example, 'original-pw');
    await store.add(fixture);
    const before = settings.text;

    await expect(store.add({ ...fixture, id: 'other', name: 'FIXTURE' })).rejects.toMatchObject(INVALID);
    await expect(store.add({ ...example, name: 'Clone' }, 'other-pw')).rejects.toMatchObject(INVALID);

    expect(settings.text).toBe(before);
    expect([...secrets.values.values()]).toStrictEqual([passwordSecretValue(example, 'original-pw')]);
  });
});

describe('updating a connection', () => {
  it('keeps the stored password while the server is unchanged, replaces it when a new one is given', async () => {
    const { settings, secrets, store } = setup([]);
    await store.add(example, 'old-pw');
    await store.add(lab);
    const renamed = { ...example, name: 'Example Lakehouse (renamed)' };

    await store.update(renamed);
    expect(await store.password(renamed)).toBe('old-pw');
    expect(settings.text).toBe(JSON.stringify([toSettingEntry(renamed), toSettingEntry(lab)]));

    await store.update(renamed, 'new-pw');
    expect([...secrets.values]).toStrictEqual([
      [passwordSecretKey(example.id), passwordSecretValue(renamed, 'new-pw')],
    ]);
    expect(settings.text).not.toContain('new-pw');
  });

  it('does not keep the password when the server changes, and removes the orphan of the old server', async () => {
    const { secrets, store } = setup([]);
    await store.add(example, 'old-pw');
    const moved = { ...example, host: 'db2.internal' };

    await store.update(moved);

    // The password was given for host "postgres"; it must not be sent to "db2.internal", and it is not left behind.
    expect(await store.password(moved)).toBeUndefined();
    expect(secrets.values.size).toBe(0);
  });

  it('writes a changed read-only switch into the entry and reads it back, in both directions', async () => {
    const { settings, store } = setup([]);
    await store.add(example);

    await store.update({ ...example, readOnly: true });
    expect(JSON.parse(settings.text ?? '[]')).toStrictEqual([{ ...toSettingEntry(example), readOnly: true }]);
    expect(store.get(example.id)?.readOnly).toBe(true);

    await store.update(example);
    expect(JSON.parse(settings.text ?? '[]')).toStrictEqual([toSettingEntry(example)]);
    expect(store.get(example.id)?.readOnly).toBeUndefined();
  });

  it('leaves a provisioned entry (without id) alone when only a password is stored, and writes the derived id once it changes', async () => {
    const provisioned = [
      {
        name: 'Example Lakehouse',
        kind: 'postgres',
        host: 'postgres',
        database: 'ducklake',
        user: 'ducklake',
        ssl: false,
      },
    ];
    const { settings, secrets, store } = setup(provisioned);
    expect(store.list()).toStrictEqual([example]);

    await store.update(example, 'asked-once');
    expect(settings.writes).toBe(0);
    expect(settings.text).toBe(JSON.stringify(provisioned));
    expect([...secrets.values]).toStrictEqual([
      [passwordSecretKey('example-lakehouse'), passwordSecretValue(example, 'asked-once')],
    ]);

    await store.update({ ...example, host: 'db2.internal' });
    expect(settings.text).toBe(JSON.stringify([toSettingEntry({ ...example, host: 'db2.internal' })]));
  });

  it('refuses a name that another connection uses and a connection that does not exist', async () => {
    const { settings, store } = setup([]);
    await store.add(example);
    await store.add(lab);
    const before = settings.text;

    await expect(store.update({ ...lab, name: 'example lakehouse' })).rejects.toMatchObject(INVALID);
    await expect(store.update(fixture, 'pw')).rejects.toMatchObject(INVALID);

    expect(settings.text).toBe(before);
  });
});

describe('removing a connection', () => {
  it('removes the entry and its password only, and refuses a connection that does not exist', async () => {
    const { settings, secrets, store } = setup([]);
    await store.add(example, 'example-pw');
    await store.add(lab, 'lab-pw');

    await store.remove(example.id);
    await expect(store.remove('missing')).rejects.toMatchObject(INVALID);

    expect(settings.text).toBe(JSON.stringify([toSettingEntry(lab)]));
    expect([...secrets.values]).toStrictEqual([
      [passwordSecretKey(lab.id), passwordSecretValue(lab, 'lab-pw')],
    ]);
  });
});

describe('entries the user edited by hand', () => {
  it('lists the usable profile, reports the index of each skipped entry and proposes ids that no entry uses', () => {
    const { store } = setup(HAND_EDITED);

    expect(store.list().map(({ id }) => id)).toStrictEqual(['prod']);
    expect(store.problems().map((problem) => Number(/\[(\d+)\]/.exec(problem)?.[1]))).toStrictEqual([
      0, 1, 2, 4,
    ]);
    expect(store.newId('Prod')).toBe('prod-2');
    expect(store.newId('Fresh Start')).toBe('fresh-start');
    // The id of an entry it cannot interpret is in use as well.
    expect(setup([{ id: 'old', name: 'Old', kind: 'mysql' }]).store.newId('Old')).toBe('old-2');
  });

  it('keeps every other entry exactly as written when adding, updating and removing', async () => {
    const { settings, store } = setup(HAND_EDITED);
    const moved: ConnectionProfile = {
      id: 'prod',
      name: 'Prod (moved)',
      kind: 'sqlite',
      path: '/moved.sqlite',
    };

    await store.add(example, 'pw');
    expect(settings.text).toBe(JSON.stringify([...HAND_EDITED, toSettingEntry(example)]));

    await store.update({ ...example, host: 'db2.internal' });
    expect(settings.text).toBe(
      JSON.stringify([...HAND_EDITED, toSettingEntry({ ...example, host: 'db2.internal' })]),
    );

    await store.remove(example.id);
    expect(settings.text).toBe(JSON.stringify(HAND_EDITED));

    await store.update(moved);
    expect(settings.text).toBe(JSON.stringify([...HAND_EDITED.slice(0, 3), { ...moved }, null]));

    await store.remove('prod');
    expect(settings.text).toBe(JSON.stringify([...HAND_EDITED.slice(0, 3), null]));
  });

  it('starts the array when the setting is missing or null, and refuses to overwrite one that is not an array', async () => {
    for (const initial of [undefined, null]) {
      const { settings, store } = setup(initial);
      await store.add(fixture);
      expect(settings.text).toBe(JSON.stringify([toSettingEntry(fixture)]));
    }

    const { settings, store } = setup({ not: 'an array' });
    const before = settings.text;
    expect(store.list()).toStrictEqual([]);
    expect(store.problems()).toHaveLength(1);
    await expect(store.add(example)).rejects.toMatchObject(INVALID);
    expect(settings.text).toBe(before);
  });
});

describe('secrets and the log redactor', () => {
  it('registers every password it reads, is told about or stores, and ignores empty values', async () => {
    const registered: string[] = [];
    const { secrets, store } = setup([toSettingEntry(example)], (value) => registered.push(value));
    secrets.values.set(passwordSecretKey(example.id), passwordSecretValue(example, 'stored-pw'));

    expect(await store.password(example)).toBe('stored-pw');
    expect(await store.password({ ...example, id: 'unknown' })).toBeUndefined();
    store.registerPassword('typed-pw');
    store.registerPassword('');
    store.registerPassword(undefined);
    await store.add(lab, 'added-pw');

    expect(registered).toStrictEqual(['stored-pw', 'typed-pw', 'added-pw']);
  });
});
