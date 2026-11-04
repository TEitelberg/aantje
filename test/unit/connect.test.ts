import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, inject, it } from 'vitest';
import type { Driver } from '../../src/catalog/drivers/driver';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { openCatalog } from '../../src/catalog/open';
import type { OpenedCatalog } from '../../src/catalog/open';
import { createCatalogReader } from '../../src/catalog/reader';
import type { ConnectDeps } from '../../src/connections/connect';
import { openWithPassword } from '../../src/connections/connect';
import type { SecretsPort, SettingsPort } from '../../src/connections/ports';
import type { ConnectionProfile, FileProfile, PostgresProfile } from '../../src/connections/profile';
import { passwordSecretKey, passwordSecretValue, toSettingEntry } from '../../src/connections/profile';
import { ConnectionStore } from '../../src/connections/store';
import type { ErrorCode } from '../../src/errors';
import { AantjeError } from '../../src/errors';
import { LATEST_SNAPSHOT, SPEC_VERSION } from '../support/expected';
import { fixturePath, wasmPath } from '../support/fixtures';
import type { PostgresFixture } from '../support/global-setup';

class MemorySettings implements SettingsPort {
  text: string;
  writes = 0;

  constructor(initial: unknown) {
    this.text = JSON.stringify(initial);
  }

  read(): unknown {
    return JSON.parse(this.text) as unknown;
  }

  write(value: unknown): Promise<void> {
    this.text = JSON.stringify(value);
    this.writes++;
    return Promise.resolve();
  }
}

class MemorySecrets implements SecretsPort {
  readonly values = new Map<string, string>();
  /** Every access in order, as "get <key>", "set <key>" or "delete <key>". */
  readonly calls: string[] = [];
  /** Set to make the storage fail like a locked keyring does. */
  unreadable?: Error;
  unwritable?: Error;

  get(key: string): Promise<string | undefined> {
    this.calls.push(`get ${key}`);
    return this.unreadable ? Promise.reject(this.unreadable) : Promise.resolve(this.values.get(key));
  }

  set(key: string, value: string): Promise<void> {
    this.calls.push(`set ${key}`);
    if (this.unwritable) {
      return Promise.reject(this.unwritable);
    }
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.calls.push(`delete ${key}`);
    this.values.delete(key);
    return Promise.resolve();
  }
}

interface Attempt {
  readonly password: string | undefined;
  /** The secrets the log redactor knew when the attempt was made. */
  readonly registered: readonly string[];
}

interface Connection {
  readonly driver: Driver;
  closed: boolean;
}

/**
 * The PostgreSQL server as far as connecting goes: it accepts one password (none at all when `accepts` is
 * undefined) and refuses every other attempt with AUTH_FAILED, like the driver does. An attempt listed in
 * `failures` ends with that error instead. A success opens the real fixture catalog.
 */
class Server {
  readonly attempts: Attempt[] = [];
  readonly refusals: AantjeError[] = [];
  readonly connections: Connection[] = [];
  /** Set to make closing a reader fail. */
  closeError?: Error;

  constructor(
    private readonly accepts: string | undefined,
    private readonly registered: readonly string[],
    private readonly failures: Readonly<Record<number, Error>>,
  ) {}

  async open(password: string | undefined): Promise<OpenedCatalog> {
    const failure = this.failures[this.attempts.length];
    this.attempts.push({ password, registered: [...this.registered] });
    if (failure) {
      throw failure;
    }
    if (password !== this.accepts) {
      const refusal = new AantjeError('AUTH_FAILED', 'Authentication failed on postgres.internal:5432.');
      this.refusals.push(refusal);
      throw refusal;
    }
    const driver = await openSqlite({ path: fixturePath('ducklake.sqlite'), wasmPath });
    const connection: Connection = { driver, closed: false };
    this.connections.push(connection);
    const reader = createCatalogReader({
      query: (sql, params, options) => driver.query(sql, params, options),
      close: async () => {
        connection.closed = true;
        await driver.close();
        if (this.closeError) {
          throw this.closeError;
        }
      },
    });
    // What openCatalog hands out: the reader and the result of its check.
    return { reader, info: await reader.info() };
  }

  /** Releases what a test left open. */
  async dispose(): Promise<void> {
    await Promise.all(this.connections.filter(({ closed }) => !closed).map(({ driver }) => driver.close()));
  }
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.dispose()));
});

/** As an administrator provisions it: without id and port, and with ssl off for a server in the internal network (without ssl a remote host gets TLS). */
const PROVISIONED = [
  {
    name: 'Example Lakehouse',
    kind: 'postgres',
    host: 'postgres',
    database: 'ducklake',
    user: 'ducklake',
    ssl: false,
  },
];
const EXAMPLE: PostgresProfile = {
  id: 'example-lakehouse',
  name: 'Example Lakehouse',
  kind: 'postgres',
  host: 'postgres',
  port: 5432,
  database: 'ducklake',
  user: 'ducklake',
  ssl: false,
};
const KEY = passwordSecretKey(EXAMPLE.id);
const RIGHT = 'right-pw';
const STALE = 'stale-pw';
const TYPED = 'typed-s3cret';
const CATALOG = { specVersion: SPEC_VERSION, latestSnapshot: LATEST_SNAPSHOT };

interface Options {
  /** The password the server wants; undefined when it wants none. */
  readonly accepts?: string;
  readonly stored?: string;
  /** What the user answers to the first, second, ... question. Being asked more often fails the test. */
  readonly answers?: readonly (string | undefined)[];
  /** Errors that replace the outcome of the attempt with that index (counted from 0). */
  readonly failures?: Readonly<Record<number, Error>>;
}

function setup({ accepts, stored, answers = [], failures = {} }: Options = {}) {
  const settings = new MemorySettings(PROVISIONED);
  const secrets = new MemorySecrets();
  if (stored !== undefined) {
    // Seeded the way the store writes it: the password bound to the server it was given for.
    secrets.values.set(KEY, passwordSecretValue(EXAMPLE, stored));
  }
  const registered: string[] = [];
  const store = new ConnectionStore(settings, secrets, (value) => registered.push(value));
  const server = new Server(accepts, registered, failures);
  servers.push(server);
  const opened: ConnectionProfile[] = [];
  const questions: { profile: ConnectionProfile; previousRejected: boolean }[] = [];
  const deps: ConnectDeps = {
    store,
    open: (profile, password) => {
      opened.push(profile);
      return server.open(password);
    },
    askPassword: (profile, previousRejected) => {
      questions.push({ profile, previousRejected });
      if (questions.length > answers.length) {
        throw new Error('The user was asked more often than scripted');
      }
      return Promise.resolve(answers[questions.length - 1]);
    },
  };
  return {
    settings,
    secrets,
    store,
    server,
    /** The profile of each attempt to open. */
    opened,
    questions,
    deps,
    /** What persists: the setting text and the stored secrets. */
    state: () => ({ setting: settings.text, secrets: [...secrets.values] }),
  };
}

/** The error a promise rejects with. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('The promise was expected to reject');
    },
    (error: unknown) => error,
  );
}

/** The messages of an error and of its causes. */
function messagesOf(error: unknown): string {
  const messages: string[] = [];
  for (let current = error; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }
  return messages.join('\n');
}

describe('connecting to a PostgreSQL catalog', () => {
  it('opens with the stored password, or without one when none is stored and the server needs none, and does not ask', async () => {
    const stored = setup({ accepts: RIGHT, stored: RIGHT });
    const before = stored.state();
    const { reader } = await openWithPassword(EXAMPLE, stored.deps);
    await expect(reader.info()).resolves.toStrictEqual(CATALOG);
    expect(stored.server.attempts).toStrictEqual([{ password: RIGHT, registered: [RIGHT] }]);
    expect(stored.questions).toStrictEqual([]);
    expect(stored.state()).toStrictEqual(before);
    expect(stored.server.connections.map(({ closed }) => closed)).toStrictEqual([false]);

    const none = setup({ accepts: undefined });
    const untouched = none.state();
    await expect((await openWithPassword(EXAMPLE, none.deps)).reader.info()).resolves.toStrictEqual(CATALOG);
    expect(none.server.attempts).toStrictEqual([{ password: undefined, registered: [] }]);
    expect(none.questions).toStrictEqual([]);
    expect(none.state()).toStrictEqual(untouched);
  });

  it('asks when none is stored and the server wants one, and stores the password exactly as typed after it worked', async () => {
    const typed = ' pw with spaces ';
    const t = setup({ accepts: typed, answers: [typed] });

    const { reader } = await openWithPassword(EXAMPLE, t.deps);

    await expect(reader.info()).resolves.toStrictEqual(CATALOG);
    expect(t.questions).toStrictEqual([{ profile: EXAMPLE, previousRejected: false }]);
    expect(t.opened).toStrictEqual([EXAMPLE, EXAMPLE]);
    // The typed password is known to the log redactor before it is sent to the server.
    expect(t.server.attempts).toStrictEqual([
      { password: undefined, registered: [] },
      { password: typed, registered: [typed] },
    ]);
    expect([...t.secrets.values]).toStrictEqual([[KEY, passwordSecretValue(EXAMPLE, typed)]]);
    expect(t.settings.writes).toBe(0);
    expect(t.settings.text).toBe(JSON.stringify(PROVISIONED));
    expect(t.server.connections.map(({ closed }) => closed)).toStrictEqual([false]);
  });

  it('asks again when the stored password is refused and replaces it once the new one worked', async () => {
    const t = setup({ accepts: RIGHT, stored: STALE, answers: [RIGHT] });

    const { reader } = await openWithPassword(EXAMPLE, t.deps);

    await expect(reader.info()).resolves.toStrictEqual(CATALOG);
    expect(t.questions).toStrictEqual([{ profile: EXAMPLE, previousRejected: true }]);
    expect(t.server.attempts).toStrictEqual([
      { password: STALE, registered: [STALE] },
      { password: RIGHT, registered: [STALE, RIGHT] },
    ]);
    expect([...t.secrets.values]).toStrictEqual([[KEY, passwordSecretValue(EXAMPLE, RIGHT)]]);
  });

  it('throws the error of the second attempt, asks only once and stores nothing when the typed password is wrong', async () => {
    for (const { stored, previousRejected } of [
      { stored: undefined, previousRejected: false },
      { stored: STALE, previousRejected: true },
    ]) {
      const t = setup({ accepts: RIGHT, stored, answers: ['wrong-pw'] });
      const before = t.state();

      const error = await rejection(openWithPassword(EXAMPLE, t.deps));

      expect(t.server.refusals).toHaveLength(2);
      expect(error).toBe(t.server.refusals[1]);
      expect(t.questions).toStrictEqual([{ profile: EXAMPLE, previousRejected }]);
      expect(t.server.attempts.map(({ password }) => password)).toStrictEqual([stored, 'wrong-pw']);
      expect(t.server.attempts[1]?.registered).toContain('wrong-pw');
      expect(t.state()).toStrictEqual(before);
      expect(t.server.connections).toStrictEqual([]);
    }

    // The second attempt may fail for another reason; that error is passed on as well.
    const down = new AantjeError('CONNECTION_FAILED', 'Cannot connect to postgres:5432: connection refused.');
    const t = setup({ accepts: RIGHT, answers: [RIGHT], failures: { 1: down } });
    const before = t.state();
    await expect(openWithPassword(EXAMPLE, t.deps)).rejects.toBe(down);
    expect(t.questions).toHaveLength(1);
    expect(t.state()).toStrictEqual(before);
  });

  it('throws the original error and stores nothing when the question is cancelled or answered with nothing', async () => {
    for (const answer of [undefined, '']) {
      const t = setup({ accepts: RIGHT, stored: STALE, answers: [answer] });
      const before = t.state();

      const error = await rejection(openWithPassword(EXAMPLE, t.deps));

      expect(error).toBe(t.server.refusals[0]);
      expect(t.server.attempts).toHaveLength(1);
      expect(t.questions).toStrictEqual([{ profile: EXAMPLE, previousRejected: true }]);
      expect(t.state()).toStrictEqual(before);
    }
  });

  it('passes every error that is no AantjeError AUTH_FAILED on untouched and does not ask', async () => {
    const otherCodes = [
      'INVALID_PROFILE',
      'FILE_NOT_FOUND',
      'CONNECTION_FAILED',
      'LOCKED',
      'TIMEOUT',
      'ABORTED',
      'QUERY_FAILED',
      'NOT_A_DUCKLAKE',
      'UNSUPPORTED_VERSION',
    ] as const satisfies readonly ErrorCode[];
    const errors: Error[] = [
      ...otherCodes.map((code) => new AantjeError(code, `The server said ${code}.`)),
      new Error('boom'),
      // A foreign error that only has the code AUTH_FAILED.
      Object.assign(new Error('x'), { code: 'AUTH_FAILED' }),
    ];

    for (const error of errors) {
      const t = setup({ accepts: RIGHT, stored: RIGHT, answers: [TYPED], failures: { 0: error } });
      const before = t.state();

      await expect(openWithPassword(EXAMPLE, t.deps)).rejects.toBe(error);

      expect(t.questions).toStrictEqual([]);
      expect(t.server.attempts).toHaveLength(1);
      expect(t.state()).toStrictEqual(before);
    }
  });

  describe('when the secret storage fails', () => {
    const keyring = new Error('The keyring is locked.');

    it('closes the reader and throws the error of the store when the password cannot be stored, even if closing fails too', async () => {
      const t = setup({ accepts: RIGHT, answers: [RIGHT] });
      t.secrets.unwritable = keyring;
      await expect(openWithPassword(EXAMPLE, t.deps)).rejects.toBe(keyring);
      expect(t.server.connections.map(({ closed }) => closed)).toStrictEqual([true]);
      expect(t.secrets.values.size).toBe(0);
      expect(t.settings.writes).toBe(0);

      const closing = setup({ accepts: RIGHT, answers: [RIGHT] });
      closing.secrets.unwritable = keyring;
      closing.server.closeError = new Error('socket hang up');
      await expect(openWithPassword(EXAMPLE, closing.deps)).rejects.toBe(keyring);
      expect(closing.server.connections.map(({ closed }) => closed)).toStrictEqual([true]);
    });

    it('does not try anything when the stored password cannot be read', async () => {
      const t = setup({ accepts: RIGHT, stored: RIGHT, answers: [TYPED] });
      t.secrets.unreadable = keyring;

      await expect(openWithPassword(EXAMPLE, t.deps)).rejects.toBe(keyring);

      expect(t.server.attempts).toStrictEqual([]);
      expect(t.questions).toStrictEqual([]);
    });
  });

  it('never repeats a password in the error: typed password refused, question cancelled, password cannot be stored', async () => {
    const flows: [Options, Error | undefined][] = [
      [{ accepts: RIGHT, stored: STALE, answers: [TYPED] }, undefined],
      [{ accepts: RIGHT, stored: STALE, answers: [undefined] }, undefined],
      [{ accepts: TYPED, stored: STALE, answers: [TYPED] }, new Error('The keyring is locked.')],
    ];
    for (const [options, unwritable] of flows) {
      const t = setup(options);
      t.secrets.unwritable = unwritable;

      const error = await rejection(openWithPassword(EXAMPLE, t.deps));

      expect(error).toBeInstanceOf(Error);
      expect(messagesOf(error)).not.toContain(TYPED);
      expect(messagesOf(error)).not.toContain(STALE);
    }
  });
});

describe('connecting to a SQLite or DuckDB file', () => {
  it('opens a file without a password and never touches the secret storage', async () => {
    for (const { kind, file } of [
      { kind: 'sqlite', file: 'ducklake.sqlite' },
      { kind: 'duckdb', file: 'ducklake.duckdb' },
    ] as const) {
      const t = setup({ accepts: undefined });
      const profile: FileProfile = { id: 'fixture', name: 'Fixture', kind, path: fixturePath(file) };

      const { reader } = await openWithPassword(profile, t.deps);

      await expect(reader.info()).resolves.toStrictEqual(CATALOG);
      expect(t.server.attempts).toStrictEqual([{ password: undefined, registered: [] }]);
      expect(t.questions).toStrictEqual([]);
      expect(t.secrets.calls).toStrictEqual([]);
      expect(t.settings.writes).toBe(0);
    }
  });

  it('opens the fixture through the real catalog opener and passes the error for a missing file on', async () => {
    const t = setup();
    const deps: ConnectDeps = {
      ...t.deps,
      open: (profile, password) => openCatalog(profile, { wasmPath, password }),
    };
    const sqlite = (path: string): FileProfile => ({ id: 'fixture', name: 'Fixture', kind: 'sqlite', path });

    const { reader } = await openWithPassword(sqlite(fixturePath('ducklake.sqlite')), deps);
    await expect(reader.info()).resolves.toStrictEqual(CATALOG);
    await reader.close();

    const missing = sqlite(join(tmpdir(), 'aantje-no-such-directory', 'missing.sqlite'));
    await expect(openWithPassword(missing, deps)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
    expect(t.questions).toStrictEqual([]);
    expect(t.secrets.calls).toStrictEqual([]);
  });
});

const fixture = inject('postgres');

describe.skipIf(fixture === null)(
  `connecting to the PostgreSQL fixture server${fixture === null ? ' (skipped: set AANTJE_POSTGRES=1, needs Docker)' : ''}`,
  () => {
    function server(): PostgresFixture {
      if (fixture === null) {
        throw new Error('The PostgreSQL fixture is not running; the tests are skipped in that case.');
      }
      return fixture;
    }

    /** The real driver answers, so the errors that decide whether the user is asked come from PostgreSQL itself. */
    function realSetup(stored: string | undefined, answers: readonly string[]) {
      const { host, port, database, user } = server();
      const profile: PostgresProfile = { ...EXAMPLE, host, port, database, user };
      const secrets = new MemorySecrets();
      if (stored !== undefined) {
        secrets.values.set(KEY, passwordSecretValue(profile, stored));
      }
      const store = new ConnectionStore(new MemorySettings([toSettingEntry(profile)]), secrets);
      const questions: boolean[] = [];
      const deps: ConnectDeps = {
        store,
        open: (target, password) => openCatalog(target, { wasmPath, password }),
        askPassword: (_profile, previousRejected) => {
          questions.push(previousRejected);
          return Promise.resolve(answers[questions.length - 1]);
        },
      };
      return { profile, secrets, questions, deps };
    }

    it('asks for the password when none is stored or the stored one is refused, because the driver reports AUTH_FAILED, and stores it', async () => {
      const { password } = server();
      for (const [stored, previousRejected] of [
        [undefined, false],
        ['not-the-password-0451', true],
      ] as const) {
        const t = realSetup(stored, [password]);

        const { reader } = await openWithPassword(t.profile, t.deps);

        await expect(reader.info()).resolves.toStrictEqual(CATALOG);
        expect(t.questions).toStrictEqual([previousRejected]);
        expect([...t.secrets.values]).toStrictEqual([[KEY, passwordSecretValue(t.profile, password)]]);
        await reader.close();
      }
    });

    it('throws the error of the server and stores nothing when the typed password is wrong', async () => {
      const t = realSetup(undefined, ['also-wrong-0451']);

      const error = await rejection(openWithPassword(t.profile, t.deps));

      expect(error).toMatchObject({ code: 'AUTH_FAILED' });
      expect(messagesOf(error)).not.toContain('also-wrong-0451');
      expect(t.questions).toStrictEqual([false]);
      expect(t.secrets.values.size).toBe(0);
    });
  },
);
