import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogInfo } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import type {
  InputOptions,
  PickItem,
  SecretsPort,
  SettingsPort,
  WizardUi,
} from '../../src/connections/ports';
import type { ConnectionProfile, PostgresProfile } from '../../src/connections/profile';
import { passwordSecretKey, passwordSecretValue } from '../../src/connections/profile';
import { ConnectionStore } from '../../src/connections/store';
import { addConnectionFlow, editConnectionFlow, removeConnectionFlow } from '../../src/connections/wizard';
import { AantjeError, userMessageOf } from '../../src/errors';
import { LATEST_SNAPSHOT, SPEC_VERSION } from '../support/expected';
import { fixturePath, wasmPath } from '../support/fixtures';

/** The user presses Enter on a pick, which takes the first item: the one that is preselected. */
const ENTER = Symbol('Enter');

/**
 * One scripted answer per prompt, in the order the flow asks. A string is typed text, or the label of the
 * picked item (what the user sees, case-sensitive). `ENTER` takes the preselected item of a pick, `undefined` cancels the prompt, a
 * boolean answers a confirmation, and a list holds the texts a user types one after the other until the
 * validation of the prompt accepts one.
 */
type Reply = string | typeof ENTER | readonly string[] | boolean | undefined;

class ScriptedUi implements WizardUi {
  readonly inputs: InputOptions[] = [];
  readonly picks: { title: string; items: readonly PickItem<string>[] }[] = [];
  readonly confirms: { message: string; action: string }[] = [];
  /** The validation messages the user saw, one per rejected attempt. */
  readonly rejected: string[] = [];
  readonly infos: string[] = [];
  readonly errors: string[] = [];
  readonly progress: string[] = [];
  private position = 0;

  constructor(private readonly replies: readonly Reply[]) {}

  /** Scripted answers the flow never asked for. */
  get unused(): number {
    return this.replies.length - this.position;
  }

  pick<T extends string>(title: string, items: readonly PickItem<T>[]): Promise<T | undefined> {
    const reply = this.next(`pick "${title}"`);
    this.picks.push({ title, items });
    if (reply === undefined) {
      return Promise.resolve(undefined);
    }
    const item = reply === ENTER ? items[0] : items.find((candidate) => candidate.label === reply);
    if (!item) {
      throw new Error(`"${String(reply)}" is not one of the choices of "${title}"`);
    }
    return Promise.resolve(item.value);
  }

  input(options: InputOptions): Promise<string | undefined> {
    const reply = this.next(`input "${options.prompt}"`);
    this.inputs.push(options);
    if (reply === undefined) {
      return Promise.resolve(undefined);
    }
    if (typeof reply === 'boolean' || reply === ENTER) {
      throw new Error(`A reply that is not text was scripted for the input "${options.prompt}"`);
    }
    for (const attempt of typeof reply === 'string' ? [reply] : reply) {
      const message = options.validate?.(attempt);
      if (message === undefined) {
        return Promise.resolve(attempt);
      }
      this.rejected.push(message);
    }
    throw new Error(`No scripted text passed the validation of "${options.prompt}"`);
  }

  confirm(message: string, action: string): Promise<boolean> {
    const reply = this.next(`confirm "${message}"`);
    this.confirms.push({ message, action });
    return Promise.resolve(reply === true);
  }

  info(message: string): void {
    this.infos.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }

  withProgress<T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> {
    this.progress.push(title);
    return task(() => undefined);
  }

  /** The preselected (first) label of each TLS question, in order. */
  get tlsDefaults(): string[] {
    return this.picks.filter(({ title }) => title.includes('TLS')).map(({ items }) => items[0]?.label ?? '');
  }

  /** The preselected (first) label of the read-only question. */
  get readOnlyDefault(): string | undefined {
    return this.picks.find(({ title }) => title.includes('read-only'))?.items[0]?.label;
  }

  private next(what: string): Reply {
    if (this.position >= this.replies.length) {
      throw new Error(`The flow asked for more input than scripted: ${what}`);
    }
    return this.replies[this.position++];
  }
}

class MemorySettings implements SettingsPort {
  text = '[]';
  writes = 0;

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

/**
 * The results of the connection test, one per call in order. `registeredBefore` holds, per call, the secrets
 * the log redactor knew at that moment.
 */
function connectionTest(outcomes: readonly (CatalogInfo | Error)[], registered: readonly string[]) {
  const calls: { profile: ConnectionProfile; password: string | undefined }[] = [];
  const registeredBefore: string[][] = [];
  const run = (profile: ConnectionProfile, password?: string): Promise<CatalogInfo> => {
    calls.push({ profile, password });
    registeredBefore.push([...registered]);
    const outcome = outcomes[calls.length - 1];
    if (outcome === undefined) {
      throw new Error('The flow tested the connection more often than scripted');
    }
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  };
  return { calls, registeredBefore, run };
}

function scenario(replies: readonly Reply[], ...outcomes: (CatalogInfo | Error)[]) {
  const settings = new MemorySettings();
  const secrets = new MemorySecrets();
  const registered: string[] = [];
  const store = new ConnectionStore(settings, secrets, (value) => registered.push(value));
  const ui = new ScriptedUi(replies);
  const tests = connectionTest(outcomes, registered);
  /** What the TLS server presents; an Error when it cannot be read. */
  const certificate: { presented: string | Error } = { presented: new Error('no TLS server here') };
  const certificateFingerprint = (): Promise<string> =>
    certificate.presented instanceof Error
      ? Promise.reject(new AantjeError('CONNECTION_FAILED', certificate.presented.message))
      : Promise.resolve(certificate.presented);
  /** The sign-in name of the Microsoft account; an Error when the sign-in fails. `tenants` are the tenants asked for. */
  const microsoft: { user: string | Error; tenants: (string | undefined)[] } = {
    user: 'ada@contoso.com',
    tenants: [],
  };
  const entraUser = (tenant: string | undefined): Promise<string> => {
    microsoft.tenants.push(tenant);
    return microsoft.user instanceof Error ? Promise.reject(microsoft.user) : Promise.resolve(microsoft.user);
  };
  return {
    settings,
    secrets,
    store,
    ui,
    tests,
    certificate,
    microsoft,
    deps: { store, testConnection: tests.run, certificateFingerprint, entraUser },
  };
}

type Scenario = ReturnType<typeof scenario>;

/** What persists: the setting text and the stored secrets. */
const persisted = (s: Scenario) => ({ setting: s.settings.text, secrets: [...s.secrets.values] });

const FOUND: CatalogInfo = { specVersion: SPEC_VERSION, latestSnapshot: LATEST_SNAPSHOT };
const UNREACHABLE = new AantjeError('CONNECTION_FAILED', 'Cannot reach postgres.internal:5433.');

/** kind, name, host, port, database, sign-in (Password, preselected), user; the TLS question and the password prompt follow. */
const POSTGRES_DETAILS: readonly Reply[] = [
  'PostgreSQL',
  'Example Lakehouse',
  'postgres.internal',
  '5433',
  'ducklake',
  ENTER,
  'reader',
];
/** kind, name, host, port, database, sign-in, user, TLS, password, read-only (the preselected answer) */
const POSTGRES_ANSWERS: readonly Reply[] = [...POSTGRES_DETAILS, 'No', 's3cret-pw', ENTER];
const EXAMPLE: PostgresProfile = {
  id: 'example-lakehouse',
  name: 'Example Lakehouse',
  kind: 'postgres',
  host: 'postgres.internal',
  port: 5433,
  database: 'ducklake',
  user: 'reader',
  ssl: false,
};

describe('adding a PostgreSQL connection', () => {
  it('asks kind, name, host, port (5432 prefilled), database, sign-in, user, TLS, password (masked), read-only; tests, then saves the profile and keeps the password in the secret storage', async () => {
    const s = scenario(POSTGRES_ANSWERS, FOUND);

    const saved = await addConnectionFlow(s.ui, s.deps);

    expect(saved).toStrictEqual(EXAMPLE);
    expect(s.store.list()).toStrictEqual([EXAMPLE]);
    expect([...s.secrets.values]).toStrictEqual([
      [passwordSecretKey('example-lakehouse'), passwordSecretValue(EXAMPLE, 's3cret-pw')],
    ]);
    expect(s.settings.text).not.toContain('s3cret-pw');
    expect(s.ui.picks).toHaveLength(4);
    expect(s.ui.inputs.map((input) => input.password === true)).toStrictEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(s.ui.inputs.map((input) => input.value)).toStrictEqual(['', '', '5432', '', '', '']);
    // The typed password is known to the log redactor before the test runs with it.
    expect(s.tests.calls).toStrictEqual([{ profile: EXAMPLE, password: 's3cret-pw' }]);
    expect(s.tests.registeredBefore).toStrictEqual([['s3cret-pw']]);
    expect(s.ui.progress).toHaveLength(1);
    expect(s.ui.infos).toHaveLength(1);
    expect(s.ui.infos[0]).toContain(SPEC_VERSION);
    expect(s.ui.infos[0]).toContain(String(LATEST_SNAPSHOT));
    expect(s.ui.errors).toStrictEqual([]);
    expect(s.ui.unused).toBe(0);
  });

  it('saves the TLS answer as ssl and tests with it; Yes is preselected for a remote host, No for the local machine', async () => {
    for (const [answer, ssl] of [
      ['No', false],
      ['Yes', true],
    ] as const) {
      const s = scenario([...POSTGRES_DETAILS, answer, 's3cret-pw', ENTER], FOUND);
      expect(await addConnectionFlow(s.ui, s.deps)).toStrictEqual({ ...EXAMPLE, ssl });
      expect(s.tests.calls).toStrictEqual([{ profile: { ...EXAMPLE, ssl }, password: 's3cret-pw' }]);
      expect(s.ui.tlsDefaults).toStrictEqual(['Yes']);
    }
    for (const host of ['localhost', '127.0.0.1', '::1']) {
      const details = POSTGRES_DETAILS.map((reply) => (reply === 'postgres.internal' ? host : reply));
      const s = scenario([...details, ENTER, 's3cret-pw', ENTER], FOUND);
      expect(await addConnectionFlow(s.ui, s.deps), host).toStrictEqual({ ...EXAMPLE, host, ssl: false });
      expect(s.ui.tlsDefaults).toStrictEqual(['No']);
    }
  });

  it('saves no password when the prompt is left empty, and keeps a typed one exactly, including surrounding spaces', async () => {
    const empty = scenario([...POSTGRES_DETAILS, 'No', '', ENTER], FOUND);
    await addConnectionFlow(empty.ui, empty.deps);
    expect(empty.store.list()).toStrictEqual([EXAMPLE]);
    expect(empty.secrets.values.size).toBe(0);
    expect(empty.tests.calls).toStrictEqual([{ profile: EXAMPLE, password: undefined }]);

    const spaces = scenario([...POSTGRES_DETAILS, 'No', ' pw with spaces ', ENTER], FOUND);
    await addConnectionFlow(spaces.ui, spaces.deps);
    expect([...spaces.secrets.values.values()]).toStrictEqual([
      passwordSecretValue(EXAMPLE, ' pw with spaces '),
    ]);
    expect(spaces.tests.calls[0]?.password).toBe(' pw with spaces ');
  });

  it('refuses invalid input at each prompt until the user corrects it', async () => {
    const s = scenario(
      [
        'PostgreSQL',
        ['', 'Example Lakehouse'],
        ['db host', 'postgres://db.example.org/lake', 'postgres.internal'],
        ['abc', '0', '65536', '5433'],
        ['', 'ducklake'],
        ENTER,
        ['', 'reader'],
        'No',
        's3cret-pw',
        ENTER,
      ],
      FOUND,
    );

    const saved = await addConnectionFlow(s.ui, s.deps);

    expect(s.ui.rejected).toHaveLength(8);
    expect(saved).toStrictEqual(EXAMPLE);
  });

  it('does not accept the name of an existing connection (ignoring case and spaces) and gives the new one an id no entry uses', async () => {
    const s = scenario(
      ['SQLite', ['example lakehouse ', ' EXAMPLE LAKEHOUSE', 'Second'], '/data/second.sqlite', ENTER],
      FOUND,
    );
    await s.store.add(EXAMPLE);
    await s.store.add({ id: 'second', name: 'Old', kind: 'sqlite', path: '/old.sqlite' });

    const saved = await addConnectionFlow(s.ui, s.deps);

    expect(s.ui.rejected).toHaveLength(2);
    expect(saved).toMatchObject({ id: 'second-2', name: 'Second' });
    expect(s.store.list().map(({ id }) => id)).toStrictEqual(['example-lakehouse', 'second', 'second-2']);
  });

  it('saves nothing and tests nothing when any of the ten prompts is cancelled', async () => {
    for (let index = 0; index < POSTGRES_ANSWERS.length; index++) {
      const s = scenario([...POSTGRES_ANSWERS.slice(0, index), undefined], FOUND);

      expect(await addConnectionFlow(s.ui, s.deps), `prompt ${index}`).toBeUndefined();

      expect(s.settings.writes).toBe(0);
      expect(s.secrets.values.size).toBe(0);
      expect(s.tests.calls).toStrictEqual([]);
      expect(s.ui.unused).toBe(0);
    }
  });
});

describe('adding a SQLite or DuckDB connection', () => {
  const FILE_ANSWERS: readonly Reply[] = ['SQLite', 'Fixture', '/data/ducklake.sqlite', ENTER];

  it('asks kind, name, path (trimmed) and read-only only: no password, no TLS, no secret', async () => {
    for (const [label, kind] of [
      ['SQLite', 'sqlite'],
      ['DuckDB', 'duckdb'],
    ] as const) {
      const s = scenario([label, 'Fixture', '  D:\\data\\ducklake.file  ', 'No'], FOUND);

      const saved = await addConnectionFlow(s.ui, s.deps);

      const expected: ConnectionProfile = {
        id: 'fixture',
        name: 'Fixture',
        kind,
        path: 'D:\\data\\ducklake.file',
      };
      expect(saved).toStrictEqual(expected);
      expect(s.settings.text).toBe(JSON.stringify([expected]));
      expect(s.ui.picks).toHaveLength(2);
      expect(s.ui.inputs.map((input) => input.password === true)).toStrictEqual([false, false]);
      expect(s.secrets.values.size).toBe(0);
      expect(s.tests.calls).toStrictEqual([{ profile: expected, password: undefined }]);
      expect(s.ui.unused).toBe(0);
    }
  });

  it('refuses an empty path and a path wrapped in quotes', async () => {
    const s = scenario(
      ['DuckDB', 'Duck', ['', '"D:\\data\\ducklake.duckdb"', 'D:\\data\\ducklake.duckdb'], ENTER],
      FOUND,
    );

    const saved = await addConnectionFlow(s.ui, s.deps);

    expect(s.ui.rejected).toHaveLength(2);
    expect(saved).toMatchObject({ kind: 'duckdb', path: 'D:\\data\\ducklake.duckdb' });
  });

  it('saves nothing when any of the four prompts is cancelled', async () => {
    for (let index = 0; index < FILE_ANSWERS.length; index++) {
      const s = scenario([...FILE_ANSWERS.slice(0, index), undefined], FOUND);

      expect(await addConnectionFlow(s.ui, s.deps), `prompt ${index}`).toBeUndefined();

      expect(s.settings.writes).toBe(0);
      expect(s.tests.calls).toStrictEqual([]);
      expect(s.ui.unused).toBe(0);
    }
  });
});

describe('when the connection test fails', () => {
  it('shows the error, and Enter on the choice saves the connection anyway', async () => {
    const s = scenario([...POSTGRES_ANSWERS, ENTER], UNREACHABLE);

    const saved = await addConnectionFlow(s.ui, s.deps);

    expect(saved).toStrictEqual(EXAMPLE);
    expect(s.store.list()).toStrictEqual([EXAMPLE]);
    expect([...s.secrets.values.values()]).toStrictEqual([passwordSecretValue(EXAMPLE, 's3cret-pw')]);
    expect(s.ui.errors).toHaveLength(1);
    expect(s.ui.errors[0]).toContain('postgres.internal:5433');
    expect(s.ui.infos).toStrictEqual([]);
  });

  it('asks the questions again, prefilled with the answers, when the user chooses to edit; the TLS answer stays first', async () => {
    const s = scenario(
      [
        ...POSTGRES_DETAILS,
        'Yes',
        's3cret-pw',
        ENTER,
        'Edit settings',
        'Example Lakehouse',
        'postgres.example.org',
        '5433',
        'ducklake',
        ENTER,
        'reader',
        ENTER,
        's3cret-pw',
        ENTER,
      ],
      UNREACHABLE,
      FOUND,
    );

    const saved = await addConnectionFlow(s.ui, s.deps);

    expect(s.ui.inputs.slice(6).map((input) => input.value)).toStrictEqual([
      'Example Lakehouse',
      'postgres.internal',
      '5433',
      'ducklake',
      'reader',
      's3cret-pw',
    ]);
    // The first answer was Yes; asking again keeps it first, and the default of the new host does not override it.
    expect(s.ui.tlsDefaults).toStrictEqual(['Yes', 'Yes']);
    expect(saved).toStrictEqual({ ...EXAMPLE, host: 'postgres.example.org', ssl: true });
    expect(s.tests.calls.map(({ profile }) => (profile as PostgresProfile).host)).toStrictEqual([
      'postgres.internal',
      'postgres.example.org',
    ]);
    expect(s.store.list()).toStrictEqual([saved]);
    expect(s.secrets.values.size).toBe(1);
    expect(s.ui.errors).toHaveLength(1);
    expect(s.ui.infos).toHaveLength(1);
    expect(s.ui.unused).toBe(0);
  });

  it('saves nothing when the user cancels the choice or dismisses it', async () => {
    for (const choice of ['Cancel', undefined]) {
      const s = scenario([...POSTGRES_ANSWERS, choice], UNREACHABLE);

      expect(await addConnectionFlow(s.ui, s.deps)).toBeUndefined();

      expect(s.settings.writes).toBe(0);
      expect(s.secrets.values.size).toBe(0);
      expect(s.ui.errors).toHaveLength(1);
    }
  });

  it('shows only the generic message of an unexpected error, never its text', async () => {
    const leaking = new Error('password authentication failed for user "reader" (password: hunter2)');
    const s = scenario([...POSTGRES_ANSWERS, 'Cancel'], leaking);

    await addConnectionFlow(s.ui, s.deps);

    expect(s.ui.errors).toHaveLength(1);
    expect(s.ui.errors[0]).toContain(userMessageOf(leaking));
    expect(s.ui.errors[0]).not.toMatch(/hunter2|authentication/);
  });
});

describe('editing a connection', () => {
  const PROD: PostgresProfile = {
    id: 'prod',
    name: 'Prod',
    kind: 'postgres',
    host: 'db.example.org',
    port: 5433,
    database: 'lake',
    user: 'reader',
    metadataSchema: 'ducklake_meta',
    ssl: true,
  };
  const OTHER: ConnectionProfile = { id: 'other', name: 'Other', kind: 'sqlite', path: '/other.sqlite' };
  /** name, host, port, database, sign-in, user: the unchanged answers up to the TLS question. */
  const PROD_DETAILS: readonly Reply[] = ['Prod', 'db.example.org', '5433', 'lake', ENTER, 'reader'];

  async function editScenario(replies: readonly Reply[], ...outcomes: (CatalogInfo | Error)[]) {
    const s = scenario(replies, ...outcomes);
    await s.store.add(PROD, 'stored-pw');
    await s.store.add(OTHER);
    return s;
  }

  it('prefills the values, keeps the id and the stored password when the password prompt stays empty, and tests with it', async () => {
    const s = await editScenario(
      ['Prod EU', 'db.example.org', '5433', 'lake', ENTER, 'reader', ENTER, '', ENTER],
      FOUND,
    );

    const saved = await editConnectionFlow(s.ui, PROD, s.deps);

    expect(s.ui.inputs.map((input) => input.value)).toStrictEqual([
      'Prod',
      'db.example.org',
      '5433',
      'lake',
      'reader',
      '',
    ]);
    expect(s.ui.inputs.at(-1)?.password).toBe(true);
    expect(saved).toStrictEqual({ ...PROD, name: 'Prod EU' });
    expect(s.store.list()).toStrictEqual([{ ...PROD, name: 'Prod EU' }, OTHER]);
    expect(s.tests.calls).toStrictEqual([{ profile: { ...PROD, name: 'Prod EU' }, password: 'stored-pw' }]);
    expect(await s.store.password({ ...PROD, name: 'Prod EU' })).toBe('stored-pw');
    expect(s.ui.infos).toHaveLength(1);
  });

  it('replaces the stored password with a typed one and tests with it', async () => {
    const s = await editScenario([...PROD_DETAILS, ENTER, 'new-pw', ENTER], FOUND);

    await editConnectionFlow(s.ui, PROD, s.deps);

    expect(await s.store.password(PROD)).toBe('new-pw');
    expect(s.tests.calls.map(({ password }) => password)).toStrictEqual(['new-pw']);
    expect(s.settings.text).not.toContain('new-pw');
  });

  it('words the password prompt differently when the stored password will not be reused', async () => {
    const kept = await editScenario(
      ['Prod', 'db.example.org', '5433', 'lake', ENTER, 'reader', ENTER, '', ENTER],
      FOUND,
    );
    await editConnectionFlow(kept.ui, PROD, kept.deps);
    const moved = await editScenario(
      ['Prod', 'db2.example.org', '5433', 'lake', ENTER, 'reader', 'No', '', ENTER],
      FOUND,
    );
    await editConnectionFlow(moved.ui, PROD, moved.deps);

    expect(moved.ui.inputs.at(-1)?.prompt).not.toBe(kept.ui.inputs.at(-1)?.prompt);
    expect(moved.ui.inputs.at(-1)?.password).toBe(true);
  });

  it('does not reuse the stored password when the host is edited and the field is left empty; the metadata schema, which it does not ask for, is carried over', async () => {
    // Changing the server and keeping the field empty must not send the old server's password to the new one; the test
    // then runs without a password; the prompt for it says that the stored one is not kept.
    const s = await editScenario(
      ['Prod', 'db2.example.org', '5433', 'lake', ENTER, 'reader', 'No', '', ENTER],
      FOUND,
    );

    const saved = await editConnectionFlow(s.ui, PROD, s.deps);

    expect(saved).toStrictEqual({ ...PROD, host: 'db2.example.org', ssl: false });
    expect(s.tests.calls).toStrictEqual([{ profile: saved, password: undefined }]);
    // The orphaned password of the old server is gone, and none is bound to the new server.
    expect(await s.store.password({ ...PROD, host: 'db2.example.org' })).toBeUndefined();
    expect(s.secrets.values.size).toBe(0);
  });

  it.each([
    { ssl: true, other: 'No' },
    { ssl: false, other: 'Yes' },
  ])(
    'offers the current TLS choice (ssl: $ssl) first: Enter keeps it, the other answer switches it',
    async ({ ssl, other }) => {
      const profile = { ...PROD, ssl };
      const kept = scenario([...PROD_DETAILS, ENTER, '', ENTER], FOUND);
      await kept.store.add(profile, 'stored-pw');
      expect(await editConnectionFlow(kept.ui, profile, kept.deps)).toStrictEqual(profile);
      expect(kept.ui.tlsDefaults).toStrictEqual([ssl ? 'Yes' : 'No']);
      expect(kept.tests.calls.map(({ profile: tested }) => (tested as PostgresProfile).ssl)).toStrictEqual([
        ssl,
      ]);

      const switched = scenario([...PROD_DETAILS, other, '', ENTER], FOUND);
      await switched.store.add(profile, 'stored-pw');
      expect(await editConnectionFlow(switched.ui, profile, switched.deps)).toStrictEqual({
        ...PROD,
        ssl: !ssl,
      });
      expect(switched.store.get('prod')).toStrictEqual({ ...PROD, ssl: !ssl });
      expect(
        switched.tests.calls.map(({ profile: tested }) => (tested as PostgresProfile).ssl),
      ).toStrictEqual([!ssl]);
    },
  );

  it('accepts the own name but not the name of another connection', async () => {
    const s = await editScenario(
      [['other', 'Prod'], 'db.example.org', '5433', 'lake', ENTER, 'reader', ENTER, '', ENTER],
      FOUND,
    );

    await editConnectionFlow(s.ui, PROD, s.deps);

    expect(s.ui.rejected).toHaveLength(1);
    expect(s.store.get('prod')?.name).toBe('Prod');
  });

  it('edits a file connection with name and path prefilled and without a TLS or password prompt', async () => {
    const s = await editScenario(['Other (moved)', '/moved/other.sqlite', ENTER], FOUND);

    const saved = await editConnectionFlow(s.ui, OTHER, s.deps);

    expect(s.ui.inputs.map((input) => input.value)).toStrictEqual(['Other', '/other.sqlite']);
    expect(s.ui.picks).toHaveLength(1);
    expect(saved).toStrictEqual({
      id: 'other',
      name: 'Other (moved)',
      kind: 'sqlite',
      path: '/moved/other.sqlite',
    });
    expect(s.store.get('other')).toStrictEqual(saved);
    expect(s.tests.calls[0]?.password).toBeUndefined();
  });

  it('changes nothing when any of the prompts is cancelled', async () => {
    const changes: Reply[] = ['Prod EU', 'db2.example.org', '5434', 'lake2', ENTER, 'writer', 'No', 'new-pw'];
    for (let index = 0; index <= changes.length; index++) {
      const s = await editScenario([...changes.slice(0, index), undefined], FOUND);
      const before = persisted(s);

      expect(await editConnectionFlow(s.ui, PROD, s.deps), `prompt ${index}`).toBeUndefined();

      expect(persisted(s)).toStrictEqual(before);
      expect(s.tests.calls).toStrictEqual([]);
      expect(s.ui.unused).toBe(0);
    }
  });

  it('after a failed test: saving keeps the typed password and the changes, cancelling leaves profile and password untouched', async () => {
    const saving = await editScenario(
      ['Prod EU', ...PROD_DETAILS.slice(1), ENTER, 'new-pw', ENTER, 'Save anyway'],
      UNREACHABLE,
    );
    const saved = await editConnectionFlow(saving.ui, PROD, saving.deps);
    expect(saved).toStrictEqual({ ...PROD, name: 'Prod EU' });
    expect(saving.store.list()).toStrictEqual([{ ...PROD, name: 'Prod EU' }, OTHER]);
    expect(await saving.store.password({ ...PROD, name: 'Prod EU' })).toBe('new-pw');
    expect(saving.ui.infos).toStrictEqual([]);
    expect(saving.ui.unused).toBe(0);

    const cancelling = await editScenario(
      ['Prod EU', 'db.example.org', '5433', 'lake', ENTER, 'reader', 'No', 'new-pw', ENTER, 'Cancel'],
      UNREACHABLE,
    );
    const before = persisted(cancelling);
    expect(await editConnectionFlow(cancelling.ui, PROD, cancelling.deps)).toBeUndefined();
    expect(persisted(cancelling)).toStrictEqual(before);
  });

  it('after a failed test: editing asks again, prefilled, and tests again with the newer password', async () => {
    const s = await editScenario(
      [
        ...PROD_DETAILS,
        ENTER,
        'new-pw',
        ENTER,
        'Edit settings',
        'Prod',
        'db2.example.org',
        '5433',
        'lake',
        ENTER,
        'reader',
        ENTER,
        'newer-pw',
        ENTER,
      ],
      UNREACHABLE,
      FOUND,
    );

    const saved = await editConnectionFlow(s.ui, PROD, s.deps);

    expect(s.ui.inputs.slice(6).map((input) => input.value)).toStrictEqual([
      'Prod',
      'db.example.org',
      '5433',
      'lake',
      'reader',
      'new-pw',
    ]);
    expect(saved).toStrictEqual({ ...PROD, host: 'db2.example.org' });
    expect(
      s.tests.calls.map(({ profile, password }) => [(profile as PostgresProfile).host, password]),
    ).toStrictEqual([
      ['db.example.org', 'new-pw'],
      ['db2.example.org', 'newer-pw'],
    ]);
    expect(s.store.list()).toStrictEqual([saved, OTHER]);
    expect(await s.store.password({ ...PROD, host: 'db2.example.org' })).toBe('newer-pw');
    expect(s.ui.unused).toBe(0);
  });
});

describe('signing in to PostgreSQL with Microsoft Entra ID', () => {
  const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
  const AZURE: PostgresProfile = {
    id: 'azure-lake',
    name: 'Azure Lake',
    kind: 'postgres',
    host: 'lake-pg.postgres.database.azure.com',
    port: 5432,
    database: 'ducklake_catalog',
    user: 'ada@contoso.com',
    ssl: true,
    azureAccount: 'lakestore01',
    azureTenant: TENANT,
    azureAuth: 'entra',
  };

  it('prefills the user with the Microsoft account of the tenant, asks for no password, saves the storage account and tenant, and stores no secret', async () => {
    const s = scenario(
      [
        'PostgreSQL',
        'Azure Lake',
        AZURE.host,
        '5432',
        AZURE.database,
        'Microsoft Entra ID',
        ['Lake-Store', 'lakestore01'],
        ['contoso', TENANT],
        'ada@contoso.com',
        ENTER,
        ENTER,
      ],
      FOUND,
    );

    const saved = await addConnectionFlow(s.ui, s.deps);

    expect(saved).toStrictEqual(AZURE);
    expect(s.store.list()).toStrictEqual([AZURE]);
    expect(s.secrets.values.size).toBe(0);
    expect(s.tests.calls).toStrictEqual([{ profile: AZURE, password: undefined }]);
    expect(s.microsoft.tenants).toStrictEqual([TENANT]);
    expect(s.ui.inputs.at(-1)?.value).toBe('ada@contoso.com');
    expect(s.ui.inputs.some((input) => input.password === true)).toBe(false);
    expect(s.ui.rejected).toHaveLength(2);
    expect(s.ui.tlsDefaults).toStrictEqual(['Yes']);
    expect(s.ui.unused).toBe(0);
  });

  it('asks for neither storage account nor tenant with a password for a server outside Azure', async () => {
    const s = scenario(POSTGRES_ANSWERS, FOUND);
    expect(await addConnectionFlow(s.ui, s.deps)).toStrictEqual(EXAMPLE);
    expect(s.ui.inputs).toHaveLength(6);
    expect(s.microsoft.tenants).toStrictEqual([]);
  });

  it('lets the user type the name when the Microsoft sign-in fails', async () => {
    const s = scenario(
      [...POSTGRES_DETAILS.slice(0, 5), 'Microsoft Entra ID', '', '', 'svc-lake', 'No', ENTER],
      FOUND,
    );
    s.microsoft.user = new AantjeError('AUTH_FAILED', 'Sign in with your Microsoft account.');

    const saved = await addConnectionFlow(s.ui, s.deps);

    expect(saved).toStrictEqual({ ...EXAMPLE, user: 'svc-lake', azureAuth: 'entra' });
    expect(s.ui.errors).toHaveLength(1);
    expect(s.ui.inputs.at(-1)?.value).toBe('');
  });

  it('switching an edited connection to Entra deletes its password; switching back asks for a new one and stores it', async () => {
    const prod: PostgresProfile = {
      ...EXAMPLE,
      id: 'prod',
      name: 'Prod',
      host: 'db.example.org',
      database: 'lake',
      ssl: true,
    };
    const same = ['Prod', 'db.example.org', '5433', 'lake'];
    const s = scenario(
      [
        ...same,
        'Microsoft Entra ID',
        '',
        '',
        'ada@contoso.com',
        ENTER,
        ENTER,
        ...same,
        'Password',
        'reader',
        ENTER,
        'new-pw',
        ENTER,
      ],
      FOUND,
      FOUND,
    );
    await s.store.add(prod, 'stored-pw');

    const entra = await editConnectionFlow(s.ui, prod, s.deps);

    expect(entra).toStrictEqual({ ...prod, user: 'ada@contoso.com', azureAuth: 'entra' });
    expect(s.secrets.values.size).toBe(0);
    expect(s.tests.calls[0]).toStrictEqual({ profile: entra, password: undefined });

    const back = await editConnectionFlow(s.ui, entra ?? prod, s.deps);

    expect(back).toStrictEqual(prod);
    expect(s.ui.inputs.at(-1)?.password).toBe(true);
    expect(await s.store.password(prod)).toBe('new-pw');
    expect(s.tests.calls[1]).toStrictEqual({ profile: prod, password: 'new-pw' });
    expect(s.microsoft.tenants).toStrictEqual([undefined]);
    expect(s.ui.unused).toBe(0);
  });

  it('keeps the Entra user of an edited connection instead of asking the Microsoft account again', async () => {
    const s = scenario(
      [
        'Azure Lake',
        AZURE.host,
        '5432',
        AZURE.database,
        ENTER,
        'lakestore01',
        TENANT,
        'lake-admins',
        ENTER,
        ENTER,
      ],
      FOUND,
    );
    await s.store.add(AZURE);

    const saved = await editConnectionFlow(s.ui, AZURE, s.deps);

    expect(saved).toStrictEqual({ ...AZURE, user: 'lake-admins' });
    expect(s.ui.inputs.slice(-3).map((input) => input.value)).toStrictEqual([
      'lakestore01',
      TENANT,
      'ada@contoso.com',
    ]);
    expect(s.microsoft.tenants).toStrictEqual([]);
  });
});

describe('removing a connection', () => {
  const LAB: PostgresProfile = { ...EXAMPLE, id: 'lab', name: 'Lab' };

  async function removeScenario(reply: Reply) {
    const s = scenario([reply]);
    await s.store.add(EXAMPLE, 'example-pw');
    await s.store.add(LAB, 'lab-pw');
    return s;
  }

  it('asks for confirmation (naming the connection) and then removes the entry and its password only', async () => {
    const s = await removeScenario(true);

    expect(await removeConnectionFlow(s.ui, EXAMPLE, s.deps)).toBe(true);

    expect(s.ui.confirms).toHaveLength(1);
    expect(s.ui.confirms[0]?.message).toContain('Example Lakehouse');
    expect(s.store.list()).toStrictEqual([LAB]);
    expect([...s.secrets.values]).toStrictEqual([
      [passwordSecretKey('lab'), passwordSecretValue(LAB, 'lab-pw')],
    ]);
  });

  it('mentions a stored secret only for a connection that can have one', async () => {
    const file = scenario([true]);
    const lake = { id: 'f', name: 'File lake', kind: 'sqlite', path: '/x.sqlite' } as const;
    await file.store.add(lake);
    await removeConnectionFlow(file.ui, lake, file.deps);
    const server = await removeScenario(true);
    await removeConnectionFlow(server.ui, EXAMPLE, server.deps);
    expect(file.ui.confirms[0]?.message).not.toMatch(/password|token/);
    expect(server.ui.confirms[0]?.message).toMatch(/password/);
  });

  it('keeps the connection and its password when the confirmation is declined or dismissed', async () => {
    for (const reply of [false, undefined]) {
      const s = await removeScenario(reply);

      expect(await removeConnectionFlow(s.ui, EXAMPLE, s.deps)).toBe(false);

      expect(s.store.list()).toStrictEqual([EXAMPLE, LAB]);
      expect(s.secrets.values.size).toBe(2);
    }
  });
});

describe('with a real DuckLake catalog', () => {
  /** What the extension's test function does for a SQLite profile: open the file read-only and read the catalog info. */
  async function testSqliteFile(profile: ConnectionProfile): Promise<CatalogInfo> {
    if (profile.kind !== 'sqlite') {
      throw new Error('This test only covers SQLite files');
    }
    const driver = await openSqlite({ path: profile.path, wasmPath });
    try {
      return await createCatalogReader(driver).info();
    } finally {
      await driver.close();
    }
  }

  it('saves the fixture catalog and reports its DuckLake version and latest snapshot', async () => {
    const path = fixturePath('ducklake.sqlite');
    const s = scenario(['SQLite', 'Fixture catalog', path, ENTER]);

    const saved = await addConnectionFlow(s.ui, { ...s.deps, testConnection: testSqliteFile });

    expect(saved).toStrictEqual({ id: 'fixture-catalog', name: 'Fixture catalog', kind: 'sqlite', path });
    expect(s.store.list()).toStrictEqual([saved]);
    expect(s.ui.infos).toHaveLength(1);
    expect(s.ui.infos[0]).toContain(SPEC_VERSION);
    expect(s.ui.infos[0]).toContain(String(LATEST_SNAPSHOT));
  });

  it('shows the message of the driver, naming the file, for a file that does not exist and saves nothing when cancelled', async () => {
    const path = join(tmpdir(), 'aantje-no-such-directory', 'missing.sqlite');
    const s = scenario(['SQLite', 'Missing', path, ENTER, 'Cancel']);

    expect(await addConnectionFlow(s.ui, { ...s.deps, testConnection: testSqliteFile })).toBeUndefined();

    expect(s.ui.errors).toHaveLength(1);
    expect(s.ui.errors[0]).toContain(path);
    expect(s.settings.writes).toBe(0);
  });
});

describe('the read-only session question', () => {
  it('preselects Yes for a new DuckDB connection and No for SQLite and PostgreSQL; Enter keeps the default', async () => {
    for (const { label, preselected, saved } of [
      { label: 'SQLite', preselected: 'No', saved: undefined },
      { label: 'DuckDB', preselected: 'Yes', saved: true },
      { label: 'PostgreSQL', preselected: 'No', saved: undefined },
    ] as const) {
      const details =
        label === 'PostgreSQL' ? [...POSTGRES_DETAILS.slice(1), 'No', ''] : ['Lake', '/lake.file'];
      const s = scenario([label, ...details, ENTER], FOUND);

      const profile = await addConnectionFlow(s.ui, s.deps);

      expect(s.ui.readOnlyDefault, label).toBe(preselected);
      expect(profile?.readOnly, label).toBe(saved);
      expect(s.store.list()[0]?.readOnly, label).toBe(saved);
    }
  });

  it('saves Yes as readOnly: true and leaves the property out for No, whatever the default was', async () => {
    const sqliteYes = scenario(['SQLite', 'Lake', '/lake.sqlite', 'Yes'], FOUND);
    expect((await addConnectionFlow(sqliteYes.ui, sqliteYes.deps))?.readOnly).toBe(true);
    expect(JSON.parse(sqliteYes.settings.text)).toStrictEqual([
      { id: 'lake', name: 'Lake', kind: 'sqlite', path: '/lake.sqlite', readOnly: true },
    ]);
    expect(sqliteYes.tests.calls[0]?.profile.readOnly).toBe(true);

    const duckNo = scenario(['DuckDB', 'Lake', '/lake.duckdb', 'No'], FOUND);
    expect((await addConnectionFlow(duckNo.ui, duckNo.deps))?.readOnly).toBeUndefined();
    expect(JSON.parse(duckNo.settings.text)).toStrictEqual([
      { id: 'lake', name: 'Lake', kind: 'duckdb', path: '/lake.duckdb' },
    ]);
  });

  it('preselects the current value when editing, so that Enter keeps it', async () => {
    for (const { current, first } of [
      { current: { readOnly: true }, first: 'Yes' },
      { current: {}, first: 'No' },
      { current: { readOnly: false }, first: 'No' },
    ]) {
      const profile: ConnectionProfile = {
        id: 'lake',
        name: 'Lake',
        kind: 'duckdb',
        path: '/lake.duckdb',
        ...current,
      };
      const s = scenario(['Lake', '/lake.duckdb', ENTER], FOUND);
      await s.store.add(profile);

      const saved = await editConnectionFlow(s.ui, profile, s.deps);

      expect(s.ui.readOnlyDefault, JSON.stringify(current)).toBe(first);
      expect(saved?.readOnly).toBe(first === 'Yes' ? true : undefined);
    }

    const readOnly: PostgresProfile = { ...EXAMPLE, readOnly: true };
    const pg = scenario(
      ['Example Lakehouse', 'postgres.internal', '5433', 'ducklake', ENTER, 'reader', 'No', '', ENTER],
      FOUND,
    );
    await pg.store.add(readOnly, 'pw');
    expect(await editConnectionFlow(pg.ui, readOnly, pg.deps)).toStrictEqual(readOnly);
    expect(pg.ui.readOnlyDefault).toBe('Yes');
  });

  it('switches a stored PostgreSQL connection to read-only and back', async () => {
    const same: Reply[] = [
      'Example Lakehouse',
      'postgres.internal',
      '5433',
      'ducklake',
      ENTER,
      'reader',
      'No',
      '',
    ];
    const s = scenario([...same, 'Yes', ...same, 'No'], FOUND, FOUND);
    await s.store.add(EXAMPLE, 'pw');

    const readOnly = await editConnectionFlow(s.ui, EXAMPLE, s.deps);
    expect(readOnly).toStrictEqual({ ...EXAMPLE, readOnly: true });
    expect(s.store.get('example-lakehouse')).toStrictEqual({ ...EXAMPLE, readOnly: true });

    const writable = await editConnectionFlow(s.ui, readOnly ?? EXAMPLE, s.deps);
    expect(writable).toStrictEqual(EXAMPLE);
    expect(s.store.get('example-lakehouse')).toStrictEqual(EXAMPLE);
  });
});

describe('a DuckDB + Quack connection', () => {
  const PRESENTED = `${'AB:'.repeat(31)}CD`;
  const SERVED: ConnectionProfile = {
    id: 'served',
    name: 'Served',
    kind: 'quack',
    host: 'duckdb',
    port: 9494,
    ssl: true,
    fingerprint: PRESENTED,
  };

  it('asks name, host (not "quack"), port (9494 prefilled), TLS and the token, pins the certificate the user confirmed, and asks nothing about read-only', async () => {
    const s = scenario(
      ['DuckDB + Quack', 'Served', ['quack', 'duckdb'], '9494', ENTER, true, 'tok-1234'],
      FOUND,
    );
    s.certificate.presented = PRESENTED;

    const saved = await addConnectionFlow(s.ui, s.deps);

    expect(saved).toStrictEqual(SERVED);
    expect(s.ui.rejected).toHaveLength(1);
    expect(s.ui.inputs.map((input) => input.value)).toStrictEqual(['', '', '9494', '']);
    expect(s.ui.inputs.at(-1)?.password).toBe(true);
    expect(s.ui.tlsDefaults).toStrictEqual(['Yes']);
    expect(s.ui.confirms[0]?.message).toContain(PRESENTED);
    expect(s.ui.readOnlyDefault).toBeUndefined();
    expect(s.tests.calls).toStrictEqual([{ profile: SERVED, password: 'tok-1234' }]);
    expect([...s.secrets.values]).toStrictEqual([
      [passwordSecretKey('served'), passwordSecretValue(SERVED, 'tok-1234')],
    ]);
    expect(s.settings.text).not.toContain('tok-1234');
    expect(s.ui.unused).toBe(0);
  });

  it('keeps an unchanged certificate and the stored token without asking; a certificate the user does not trust is not pinned, and TLS off drops the pin', async () => {
    const same: Reply[] = ['Served', 'duckdb', '9494', ENTER];
    const s = scenario(
      [...same, '', ...same, false, 'Use the system trust store', '', ...same.slice(0, 3), 'No', ''],
      FOUND,
      FOUND,
      FOUND,
    );
    await s.store.add(SERVED, 'tok-1234');
    s.certificate.presented = PRESENTED;

    expect(await editConnectionFlow(s.ui, SERVED, s.deps)).toStrictEqual(SERVED);
    expect(s.ui.confirms).toStrictEqual([]);
    expect(s.tests.calls[0]?.password).toBe('tok-1234');

    s.certificate.presented = `${'EF:'.repeat(31)}01`;
    const { fingerprint: _pinned, ...unpinned } = SERVED;
    expect(await editConnectionFlow(s.ui, SERVED, s.deps)).toStrictEqual(unpinned);
    expect(s.ui.confirms).toHaveLength(1);

    expect(await editConnectionFlow(s.ui, unpinned, s.deps)).toStrictEqual({ ...unpinned, ssl: false });
    expect(await s.store.password(SERVED)).toBe('tok-1234');
    expect(s.ui.unused).toBe(0);
  });
});
