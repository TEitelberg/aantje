import { describe, expect, it } from 'vitest';
import type { SecretsPort } from '../../src/connections/ports';
import { S3CredentialStore } from '../../src/data/credentials';

function memorySecrets(initial: Record<string, string> = {}): SecretsPort & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: (key) => Promise.resolve(values.get(key)),
    set: (key, value) => Promise.resolve(void values.set(key, value)),
    delete: (key) => Promise.resolve(void values.delete(key)),
  };
}

const ENV = { AWS_ACCESS_KEY_ID: 'env-key', AWS_SECRET_ACCESS_KEY: 'env-secret' };
const FROM_ENV = { keyId: 'env-key', secretKey: 'env-secret' };

describe('S3CredentialStore', () => {
  it('keeps what was set under the documented keys, prefers it over the environment, falls back to the AWS variables, and counts half a pair as nothing', async () => {
    const secrets = memorySecrets();
    const store = new S3CredentialStore(secrets, undefined, ENV);
    expect(await store.get()).toEqual(FROM_ENV);

    await store.set({ keyId: 'AKIA1', secretKey: 'secret1' });
    expect(await store.get()).toEqual({ keyId: 'AKIA1', secretKey: 'secret1' });
    expect(Object.fromEntries(secrets.values)).toEqual({
      'aantje.s3.keyId': 'AKIA1',
      'aantje.s3.secretKey': 'secret1',
    });

    const half = memorySecrets({ 'aantje.s3.keyId': 'only-the-key' });
    expect(
      await new S3CredentialStore(half, undefined, { AWS_ACCESS_KEY_ID: 'only-env-key' }).get(),
    ).toBeUndefined();
    expect(await new S3CredentialStore(half, undefined, ENV).get()).toEqual(FROM_ENV);
    expect(await new S3CredentialStore(memorySecrets(), undefined, {}).get()).toBeUndefined();
  });

  it('clear removes the stored credentials, after which the environment applies again', async () => {
    const secrets = memorySecrets();
    const store = new S3CredentialStore(secrets, undefined, ENV);
    await store.set({ keyId: 'AKIA1', secretKey: 'secret1' });
    await store.clear();

    expect(secrets.values.size).toBe(0);
    expect(await store.get()).toEqual(FROM_ENV);
  });

  it('registers every secret it hands out or stores for log redaction, and nothing when there are none', async () => {
    const registered: string[] = [];
    const register = (value: string): number => registered.push(value);
    await new S3CredentialStore(memorySecrets(), register, {}).get();
    expect(registered).toEqual([]);

    const store = new S3CredentialStore(memorySecrets(), register, ENV);
    await store.get();
    expect(registered).toEqual(['env-key', 'env-secret']);

    registered.length = 0;
    await store.set({ keyId: 'AKIA1', secretKey: 'secret1' });
    await store.get();
    expect(registered).toEqual(['AKIA1', 'secret1', 'AKIA1', 'secret1']);
  });
});
