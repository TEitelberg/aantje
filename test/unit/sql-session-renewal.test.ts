import { describe, expect, it } from 'vitest';
import type { PostgresProfile } from '../../src/connections/profile';
import type { DataAccess } from '../../src/data/types';
import { maskSecrets } from '../../src/secrets';
import { tokenRenewals } from '../../src/sql/session';

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

// A long SQL session replaces its tokens on a timer (`startRenewal`, tested in azure-entra.test.ts); these are the jobs.
describe('the token renewal of a SQL session', () => {
  it('replaces the storage secret and the Entra password with new tokens, and masks every token it handed out', async () => {
    let round = 0;
    const access = {
      profile,
      s3: {},
      azure: { accountName: 'acct', refresh: () => Promise.resolve(`storage-token-${++round}`) },
      renewPassword: () => Promise.resolve(`entra-token-${round}`),
    } as unknown as DataAccess;
    const secrets: string[] = [];
    const statements: string[] = [];
    const jobs = tokenRenewals(access, secrets, (sql) => Promise.resolve(void statements.push(sql)));

    for (let pass = 0; pass < 2; pass++) {
      for (const job of jobs) await job();
    }

    // Each round replaces both secrets with the token of that round.
    expect(jobs).toHaveLength(2);
    expect(statements).toHaveLength(4);
    for (const token of ['storage-token-1', 'storage-token-2', 'entra-token-1', 'entra-token-2']) {
      expect(
        statements.filter((sql) => sql.includes(token)),
        token,
      ).toHaveLength(1);
    }
    // An error that quotes an old or a new token shows none of them.
    expect(maskSecrets('failed with storage-token-1, then entra-token-2', secrets)).not.toMatch(/token-\d/);
  });

  it('has nothing to renew for a lake without a storage token or an Entra login', () => {
    const plain = { profile: { ...profile, azureAuth: undefined }, s3: {} } as unknown as DataAccess;
    expect(tokenRenewals(plain, [], () => Promise.resolve())).toEqual([]);
  });
});
