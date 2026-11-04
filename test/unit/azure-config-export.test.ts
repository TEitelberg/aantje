import { describe, expect, it } from 'vitest';
import { azureNotebookConfig } from '../../src/azure/config-export';
import type { PostgresProfile } from '../../src/connections/profile';

const lake: PostgresProfile = {
  id: 'p1',
  name: 'Azure lake',
  kind: 'postgres',
  host: 'srv.postgres.database.azure.com',
  port: 5432,
  database: 'ducklake_catalog',
  user: 'ducklakeadmin',
  ssl: true,
  azureAccount: 'acct1',
  azureTenant: 'tenant-1',
};

describe('azureNotebookConfig', () => {
  it('has the values of the lake in the keys of azure.config.json, and no password', () => {
    const text = azureNotebookConfig(lake) ?? '';
    expect(JSON.parse(text)).toEqual({
      storageAccount: 'acct1',
      container: 'lake',
      dataPrefix: 'data',
      bronzePrefix: 'bronze',
      lakeName: 'azure_lake',
      pgHost: 'srv.postgres.database.azure.com',
      pgPort: 5432,
      pgDatabase: 'ducklake_catalog',
      pgUser: 'ducklakeadmin',
      auth: 'device_code',
      pgAuth: 'password',
      tenantId: 'tenant-1',
    });
    expect(text.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(text) as object).join()).not.toMatch(/password|secret|token/i);
  });

  it('asks for an Entra token when the lake signs in to PostgreSQL with Entra', () => {
    expect(JSON.parse(azureNotebookConfig({ ...lake, azureAuth: 'entra' }) ?? '{}')).toMatchObject({
      pgAuth: 'entra',
    });
  });

  it('leaves the tenant empty when the profile has none', () => {
    const { azureTenant: _tenant, ...withoutTenant } = lake;
    expect(JSON.parse(azureNotebookConfig(withoutTenant) ?? '{}')).toMatchObject({ tenantId: '' });
  });

  it('is nothing for a PostgreSQL connection that is not an Azure lake', () => {
    const { azureAccount: _account, ...plain } = lake;
    expect(azureNotebookConfig(plain)).toBeUndefined();
  });
});
