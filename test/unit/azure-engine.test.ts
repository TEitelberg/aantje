import { describe, expect, it } from 'vitest';
import { containerGlob } from '../../src/azure/attach-lake';
import { parseProfiles, toSettingEntry } from '../../src/connections/profile';
import type { PostgresProfile } from '../../src/connections/profile';
import { azureSecretStatement, setupStatements } from '../../src/data/attach';
import { secretsOf } from '../../src/data/errors';
import type { DataAccess } from '../../src/data/types';

const profile: PostgresProfile = {
  id: 'lake',
  name: 'lake',
  kind: 'postgres',
  host: 'h.postgres.database.azure.com',
  port: 5432,
  database: 'ducklake_catalog',
  user: 'ducklakeadmin',
  ssl: true,
  azureAccount: 'acct',
};

const access = (extra: Partial<DataAccess> = {}): DataAccess => ({
  profile,
  password: 'pg-password',
  s3: {},
  azure: { accountName: 'acct', accessToken: "tok'en" },
  ...extra,
});

describe('setup for an Azure lake', () => {
  it('loads the azure extension before the first secret and quotes the token', () => {
    const statements = setupStatements(access({ s3Credentials: { keyId: 'k', secretKey: 's' } }));
    const firstSecret = statements.findIndex((sql) => sql.startsWith('CREATE OR REPLACE SECRET'));
    expect(statements.indexOf('INSTALL azure')).toBeLessThan(firstSecret);
    expect(statements.indexOf('LOAD azure')).toBeLessThan(firstSecret);
    expect(statements.indexOf('LOAD httpfs')).toBeLessThan(firstSecret);
    const secret = statements.find((sql) => sql.includes('TYPE azure'));
    expect(secret).toBe(azureSecretStatement('acct', "tok'en"));
    expect(secret).toContain("ACCESS_TOKEN 'tok''en'");
    expect(secret).toContain("ACCOUNT_NAME 'acct'");
  });

  it('loads nothing from Azure for a lake that has no account', () => {
    expect(setupStatements(access({ azure: undefined }))).not.toContain('INSTALL azure');
  });

  it('uses the curl transport on Linux only, before the first request', () => {
    const curl = "SET azure_transport_option_type = 'curl'";
    const linux = setupStatements(access(), undefined, 'linux');
    expect(linux.indexOf(curl)).toBeGreaterThan(linux.indexOf('LOAD azure'));
    expect(linux.indexOf(curl)).toBeLessThan(linux.findIndex((sql) => sql.startsWith('ATTACH')));
    expect(setupStatements(access(), undefined, 'win32')).not.toContain(curl);
    expect(setupStatements(access({ azure: undefined }), undefined, 'linux')).not.toContain(curl);
  });

  it('may create the catalog only when it is given a data path', () => {
    const dataPath = 'abfss://lake@acct.dfs.core.windows.net/data/';
    const attach = (statements: string[]): string => statements.find((sql) => sql.startsWith('ATTACH')) ?? '';
    const creating = attach(setupStatements(access(), { readOnly: false, dataPath }));
    expect(creating).toContain(`DATA_PATH '${dataPath}'`);
    expect(creating).not.toMatch(/READ_ONLY|CREATE_IF_NOT_EXISTS false/);
    expect(attach(setupStatements(access(), { readOnly: false }))).toContain('CREATE_IF_NOT_EXISTS false');
  });

  it('counts the token among the secrets that are masked', () => {
    expect(secretsOf(access())).toEqual(expect.arrayContaining(["tok'en", 'pg-password']));
  });
});

describe('containerGlob', () => {
  it('lists the container of the data path', () => {
    expect(containerGlob('abfss://lake@acct.dfs.core.windows.net/data/')).toBe(
      'abfss://lake@acct.dfs.core.windows.net/*',
    );
  });
});

describe('the profile of an Azure lake', () => {
  it('survives the setting and rejects an empty account', () => {
    const withTenant = { ...profile, azureTenant: 'tenant-1' };
    expect(parseProfiles([toSettingEntry(withTenant)]).profiles).toEqual([withTenant]);
    expect(parseProfiles([{ ...toSettingEntry(profile), azureAccount: ' ' }]).problems).toHaveLength(1);
  });
});
