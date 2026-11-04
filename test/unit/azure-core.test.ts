import { describe, expect, it, vi } from 'vitest';
import { allows } from '../../src/azure/arm';
import { decodeClaims, requireUserName } from '../../src/azure/jwt';
import { dataPathOf, parseLakeOutputs } from '../../src/azure/lake-outputs';
import { resourceNames, uniqueSuffix, validateNamePrefix } from '../../src/azure/names';
import { generatePassword } from '../../src/azure/password';
import { discoverPublicIp, isIpv4 } from '../../src/azure/public-ip';
import { isRolePropagation, withBackoff } from '../../src/azure/retry';
import { jwt, OID, TID } from './azure-support';

describe('decodeClaims', () => {
  it('reads the object and tenant id', () => {
    expect(decodeClaims(jwt({ oid: OID, tid: TID }))).toEqual({ oid: OID, tid: TID });
  });

  it('reads the sign-in name from upn, else preferred_username', () => {
    expect(
      decodeClaims(jwt({ oid: OID, tid: TID, upn: 'a@x.com', preferred_username: 'b@x.com' })).userName,
    ).toBe('a@x.com');
    expect(decodeClaims(jwt({ oid: OID, tid: TID, preferred_username: 'b@x.com' })).userName).toBe('b@x.com');
    expect(() => requireUserName(jwt({ oid: OID, tid: TID }))).toThrow(/user name/);
  });

  it.each([['not a token'], [jwt({ tid: TID })], [jwt({ oid: 'x', tid: TID })]])('rejects %s', (token) => {
    expect(() => decodeClaims(token)).toThrow();
  });
});

describe('generatePassword', () => {
  it('meets the PostgreSQL rule and differs per call', () => {
    const passwords = Array.from({ length: 200 }, () => generatePassword());
    for (const password of passwords) {
      expect(password).toHaveLength(32);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/\d/);
      expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(new Set(passwords).size).toBe(passwords.length);
  });
});

describe('names', () => {
  it('accepts a short lowercase prefix only', () => {
    expect(validateNamePrefix('sales-lake')).toBeUndefined();
    for (const bad of ['ab', 'Sales', '1lake', 'lake-', 'averyverylongprefix']) {
      expect(validateNamePrefix(bad)).toBeDefined();
    }
  });

  it('takes the first 13 hex digits of a GUID, as the default of the template does, and a new GUID per call', () => {
    expect(uniqueSuffix('0F8FAD5B-D9CB-469F-A165-70867728950E')).toBe('0f8fad5bd9cb4');
    const suffixes = Array.from({ length: 200 }, () => uniqueSuffix());
    for (const suffix of suffixes) expect(suffix).toMatch(/^[0-9a-f]{13}$/);
    expect(new Set(suffixes).size).toBe(suffixes.length);
  });

  it('keeps the storage account name within the 3 to 24 lowercase letters and digits', () => {
    const { storageAccount, server } = resourceNames('my-lake-1234', uniqueSuffix());
    expect(storageAccount).toMatch(/^[a-z0-9]{3,24}$/);
    expect(server).toMatch(/^[a-z0-9-]{3,63}$/);
  });
});

describe('allows', () => {
  const owner = [{ actions: ['*'], notActions: [] }];
  const contributor = [
    { actions: ['*'], notActions: ['Microsoft.Authorization/*/Write', 'Microsoft.Authorization/*/Delete'] },
  ];
  const action = 'Microsoft.Authorization/roleAssignments/write';

  it('allows an owner and refuses a contributor', () => {
    expect(allows(owner, action)).toBe(true);
    expect(allows(contributor, action)).toBe(false);
  });

  it('allows when another entry grants it, and ignores case', () => {
    const both = [...contributor, { actions: ['microsoft.authorization/roleassignments/write'] }];
    expect(allows(both, action)).toBe(true);
    expect(allows([], action)).toBe(false);
  });
});

describe('parseLakeOutputs', () => {
  const lake = {
    attach:
      "ATTACH 'ducklake:postgres:dbname=ducklake_catalog host=h.postgres.database.azure.com sslmode=verify-full sslrootcert=system user=ducklakeadmin' AS lake (DATA_PATH 'abfss://lake@acct.dfs.core.windows.net/data/');",
    azureSecret: { provider: 'access_token', accountName: 'acct' },
    postgres: {
      host: 'h.postgres.database.azure.com',
      database: 'ducklake_catalog',
      user: 'ducklakeadmin',
      port: 5432,
    },
  };

  it('reads the JSON string and the outputs object of a deployment alike', () => {
    const outputs = parseLakeOutputs(JSON.stringify(lake));
    expect(outputs.postgres.host).toBe('h.postgres.database.azure.com');
    expect(parseLakeOutputs({ ducklake: { type: 'String', value: JSON.stringify(lake) } })).toEqual(outputs);
    expect(dataPathOf(outputs)).toBe('abfss://lake@acct.dfs.core.windows.net/data/');
  });

  it('knows the authentication mode; an older deployment means a password', () => {
    expect(parseLakeOutputs(JSON.stringify(lake)).authentication).toBe('password');
    const entra = { ...lake, authentication: 'entra', entraToken: { scope: 'x', use: 'y' } };
    expect(parseLakeOutputs(JSON.stringify(entra)).authentication).toBe('entra');
  });

  it('rejects other JSON', () => {
    expect(() => parseLakeOutputs('{"a":1}')).toThrow();
    expect(() => parseLakeOutputs('nope')).toThrow();
  });
});

describe('withBackoff', () => {
  it('waits longer each time and returns the first success', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    let calls = 0;
    const result = await withBackoff(
      () => (++calls < 4 ? Promise.reject(new Error('403')) : Promise.resolve('ok')),
      { isRetryable: isRolePropagation, sleep, initialDelayMs: 100, maxDelayMs: 250 },
    );
    expect(result).toBe('ok');
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200, 250]);
  });

  it('does not retry another failure and gives up after the attempts', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const other = vi.fn(() => Promise.reject(new Error('password authentication failed')));
    await expect(withBackoff(other, { isRetryable: isRolePropagation, sleep })).rejects.toThrow('password');
    expect(other).toHaveBeenCalledTimes(1);

    const always = vi.fn(() => Promise.reject(new Error('AuthorizationPermissionMismatch')));
    await expect(
      withBackoff(always, { isRetryable: isRolePropagation, sleep, attempts: 3 }),
    ).rejects.toThrow();
    expect(always).toHaveBeenCalledTimes(3);
  });
});

describe('discoverPublicIp', () => {
  it('returns the address the service answers', async () => {
    const answer = vi.fn(() => Promise.resolve(new Response('203.0.113.7\n')));
    expect(await discoverPublicIp(answer as unknown as typeof fetch)).toBe('203.0.113.7');
  });

  it('refuses an answer that is not an IPv4 address', async () => {
    const html = vi.fn(() => Promise.resolve(new Response('<html>blocked</html>')));
    await expect(discoverPublicIp(html as unknown as typeof fetch)).rejects.toThrow();
    expect(isIpv4('300.1.1.1')).toBe(false);
  });
});
