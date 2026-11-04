import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenedCatalog } from '../../src/catalog/open';
import { openWithPassword } from '../../src/connections/connect';
import type { ConnectDeps } from '../../src/connections/connect';
import { parseProfiles, toSettingEntry } from '../../src/connections/profile';
import type { PostgresProfile } from '../../src/connections/profile';
import { postgresSecretStatement, setupStatements } from '../../src/data/attach';
import { secretsOf } from '../../src/data/errors';
import { startRenewal } from '../../src/data/renewal';
import type { DataAccess } from '../../src/data/types';
import { AantjeError } from '../../src/errors';

const profile: PostgresProfile = {
  id: 'lake',
  name: 'lake',
  kind: 'postgres',
  host: 'h.postgres.database.azure.com',
  port: 5432,
  database: 'ducklake_catalog',
  user: 'ada@contoso.com',
  ssl: true,
  azureAccount: 'acct',
  azureAuth: 'entra',
};

describe('the profile of an Entra lake', () => {
  it('survives the setting, and only the two modes are valid', () => {
    expect(parseProfiles([toSettingEntry(profile)]).profiles).toEqual([profile]);
    expect(parseProfiles([{ ...toSettingEntry(profile), azureAuth: 'kerberos' }]).problems).toHaveLength(1);
  });
});

describe('connecting with an Entra token', () => {
  const opened = {} as OpenedCatalog;
  const deps = (overrides: Partial<ConnectDeps> = {}) => {
    const open = vi.fn((_profile: unknown, _password: string | undefined) => Promise.resolve(opened));
    const password = vi.fn(() => Promise.resolve('stored'));
    const askPassword = vi.fn(() => Promise.resolve('typed'));
    const all: ConnectDeps = {
      store: { password, registerPassword: vi.fn(), update: vi.fn() },
      open,
      askPassword,
      entraToken: vi.fn(() => Promise.resolve('entra-token')),
      ...overrides,
    };
    return { all, open, password, askPassword };
  };

  it('opens with a fresh token as the password and reads no stored password', async () => {
    const { all, open, password } = deps();
    expect(await openWithPassword(profile, all)).toBe(opened);
    expect(open).toHaveBeenCalledWith(profile, 'entra-token');
    expect(password).not.toHaveBeenCalled();
    await openWithPassword(profile, all);
    expect(all.entraToken).toHaveBeenCalledTimes(2);
  });

  it('does not ask for a password when the token is refused', async () => {
    const refused = new AantjeError('AUTH_FAILED', 'refused');
    const { all, askPassword } = deps({ open: () => Promise.reject(refused) });
    await expect(openWithPassword(profile, all)).rejects.toThrow('refused');
    expect(askPassword).not.toHaveBeenCalled();
  });

  it('still uses the stored password for a lake in password mode', async () => {
    const { all, open } = deps();
    await openWithPassword({ ...profile, azureAuth: undefined }, all);
    expect(open).toHaveBeenCalledWith(expect.anything(), 'stored');
  });
});

describe('the engine with an Entra token', () => {
  const access: DataAccess = {
    profile,
    password: 'tok"en',
    s3: {},
    azure: { accountName: 'acct', accessToken: 'storage-token' },
  };

  it('puts the token into the PostgreSQL secret as the password, with the Entra user', () => {
    const secret = setupStatements(access).find((sql) => sql.includes('TYPE postgres'));
    expect(secret).toBe(postgresSecretStatement(profile, 'tok"en'));
    expect(secret).toContain("PASSWORD 'tok\"en'");
    expect(secret).toContain("USER 'ada@contoso.com'");
    expect(secret).toContain("SSLMODE 'verify-full'");
  });

  it('masks the token in engine errors', () => {
    expect(secretsOf(access)).toEqual(expect.arrayContaining(['tok"en', 'storage-token']));
  });
});

describe('startRenewal', () => {
  afterEach(() => vi.useRealTimers());

  it('runs every job each round, and a failing job neither stops the others nor the next round', async () => {
    vi.useFakeTimers();
    const good = vi.fn(() => Promise.resolve());
    const bad = vi.fn(() => Promise.reject(new Error('sign-in lost')));
    const errors: unknown[] = [];
    const timer = startRenewal([bad, good], (error) => errors.push(error), 1000);
    await vi.advanceTimersByTimeAsync(2500);
    clearInterval(timer);
    expect(good).toHaveBeenCalledTimes(2);
    expect(bad).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(2);
  });
});
