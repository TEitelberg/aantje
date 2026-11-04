import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as InstanceModule from '../../src/data/instance';
import type { DataAccess } from '../../src/data/types';
import { copyDataFixture, engineSkipReason } from './data-support';
import type { DataFixture } from './data-support';
import { checkFixture, ids, lake, problems, startFakeStore } from './health-support';
import type { FakeStore } from './health-support';

// Engine options of the test: `instanceOptions` takes them for tests only; no setting and no field of `DataAccess` does.
const engineOptions = vi.hoisted((): { value: Record<string, string> } => ({ value: {} }));

vi.mock('../../src/data/instance', async (importOriginal) => {
  const original = await importOriginal<typeof InstanceModule>();
  return {
    ...original,
    instanceOptions: (access: DataAccess) => original.instanceOptions(access, engineOptions.value),
  };
});

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Health check S3 tests are skipped: ${skipReason}`);
}

const BUCKET = 'example-lake';
const KEY_ID = 'AKIAHEALTHKEYID';
const SECRET = 'sekrit-health-secret';
const ORDERS = 'sales/orders/ducklake-01a18c33-cfcb-7cc1-bfe9-dfce5e8d67c6.parquet';

// A lake on an S3 endpoint that is a directory: the data fixture, whose three files lie at s3://example-lake/ducklake/....
describe.skipIf(skipReason)('a lake on an object store that speaks S3', () => {
  let fixture: DataFixture;
  let store: FakeStore;
  let root: string;
  const access = (extra: Partial<DataAccess> = {}): Partial<DataAccess> => ({
    s3: { endpoint: store.endpoint, urlStyle: 'path' },
    s3Credentials: { keyId: KEY_ID, secretKey: SECRET },
    ...extra,
  });

  beforeAll(async () => {
    fixture = await copyDataFixture('sqlite', `s3://${BUCKET}/ducklake/`);
    root = join(fixture.directory, 'sqlite-files');
    store = await startFakeStore(root, BUCKET, 'ducklake');
  });
  afterAll(async () => {
    await store.close();
    await fixture.remove();
  });
  beforeEach(() => {
    store.mode.value = 'serve';
    store.pageSize.value = 1000;
    store.requests.length = 0;
  });
  afterEach(() => {
    store.mode.value = 'serve';
    engineOptions.value = {};
  });

  const check = (
    extra: Partial<DataAccess> = {},
    depth: 'quick' | 'deep' = 'quick',
    env: Record<string, string> = {},
  ) => checkFixture(fixture, { scope: lake, depth, snapshot: 13 }, access(extra), { env });

  it('finds nothing wrong when every file is in the store, lists without opening a file, follows pages and opens footers when deep', async () => {
    const report = await check();

    expect(problems(report)).toEqual([]);
    expect(ids(report)).toEqual([]);
    expect(report.groups.map((group) => group.state)).toEqual(['done', 'done', 'done', 'skipped']);
    // One request that probes the store and one listing; the sizes come with the listing, no HEAD or GET of a file.
    expect(store.requests.map((line) => line.split('?')[0])).toEqual([
      'GET /example-lake/',
      'GET /example-lake/',
    ]);

    store.requests.length = 0;
    store.pageSize.value = 1;
    expect(problems(await check())).toEqual([]);
    expect(
      store.requests.filter((line) => line.includes('continuation-token')).length,
    ).toBeGreaterThanOrEqual(2);
    expect(store.requests.some((line) => line.startsWith('HEAD'))).toBe(false);

    store.pageSize.value = 1000;
    store.requests.length = 0;
    const deep = await check({}, 'deep');
    expect(problems(deep)).toEqual([]);
    expect(deep.groups[3]).toEqual({ group: 'deep', state: 'done' });
    expect(store.requests.some((line) => line.startsWith('GET /example-lake/ducklake/sales/orders/'))).toBe(
      true,
    );
  });

  it('stops the deep check at the first file the store refuses, while the quick groups are done', async () => {
    store.mode.value = 'filesDenied';

    const report = await check({}, 'deep');

    expect(report.groups.map((group) => group.state)).toEqual(['done', 'done', 'done', 'failed']);
    expect(ids(report)).toEqual([]);
  });

  it('tells names apart by case, and names the key of a lost file and of a stray file the way the store knows it', async () => {
    const lower = join(root, ORDERS);
    const upperName = 'ducklake-01A18C33-CFCB-7CC1-BFE9-DFCE5E8D67C6';
    const upper = join(root, ORDERS.replace('ducklake-01a18c33-cfcb-7cc1-bfe9-dfce5e8d67c6', upperName));
    renameSync(lower, upper);
    try {
      const report = await check();

      expect(report.findings.map((item) => item.id)).toEqual([
        'storage.file-missing:data:0',
        `storage.file-orphaned:s3://${BUCKET}/ducklake/${ORDERS.replace('ducklake-01a18c33-cfcb-7cc1-bfe9-dfce5e8d67c6', upperName)}`,
      ]);
    } finally {
      renameSync(upper, lower);
    }

    const copy = join(root, 'sales/orders/ducklake-stray.parquet');
    writeFileSync(copy, 'abc');
    rmSync(lower);
    try {
      const report = await check();

      expect(report.findings.map((item) => [item.id, item.severity, item.objectKey])).toEqual([
        ['storage.file-missing:data:0', 'error', `s3://${BUCKET}/ducklake/${ORDERS}`],
        [
          `storage.file-orphaned:s3://${BUCKET}/ducklake/sales/orders/ducklake-stray.parquet`,
          'info',
          `s3://${BUCKET}/ducklake/sales/orders/ducklake-stray.parquet`,
        ],
      ]);
    } finally {
      rmSync(copy);
    }
  });

  it('tells a refusal by the store from the credentials, stops there after one request, and never mentions the key id or the secret', async () => {
    const causes = new Set<string | undefined>();
    for (const mode of ['denied', 'signature', 'keyId'] as const) {
      store.mode.value = mode;
      store.requests.length = 0;

      const report = await check();

      expect(ids(report, 'connection'), mode).toEqual(['connection.store-access-denied']);
      causes.add(report.findings.find((item) => item.group === 'connection')?.cause);
      expect(
        report.groups.map((group) => [group.group, group.state]),
        mode,
      ).toEqual([
        ['catalog', 'done'],
        ['connection', 'done'],
        ['storage', 'skipped'],
        ['deep', 'skipped'],
      ]);
      // One request was enough to learn it.
      expect(store.requests, mode).toHaveLength(1);
    }
    expect(causes.size, 'each refusal has its own cause').toBe(3);

    // The key id as the bucket name of the url: it must not come back in any field.
    store.mode.value = 'signature';
    const named = await copyDataFixture('sqlite', `s3://${KEY_ID}/ducklake/`);
    try {
      const report = await checkFixture(
        named,
        { scope: lake },
        {
          s3: { endpoint: store.endpoint, urlStyle: 'path' },
          s3Credentials: { keyId: KEY_ID, secretKey: SECRET },
        },
      );

      const text = JSON.stringify(report);
      expect(text).not.toContain(KEY_ID);
      expect(text).not.toContain(SECRET);
      expect(report.findings.find((item) => item.group === 'connection')?.detail).toContain(
        "'s3://***/ducklake/'",
      );
    } finally {
      await named.remove();
    }
  });

  it('tells a missing bucket from a refusal, also if the environment names another endpoint', async () => {
    const other = await copyDataFixture('sqlite', 's3://nosuchbucket/ducklake/');
    try {
      const report = await checkFixture(other, { scope: lake }, access());
      expect(ids(report, 'connection')).toEqual(['connection.store-bucket-missing']);
      expect(report.findings[0]?.detail).toContain('nosuchbucket');

      const withEnv = await checkFixture(other, { scope: lake }, access(), {
        env: { AWS_ENDPOINT_URL_S3: 'http://rustfs:9000' },
      });
      expect(ids(withEnv, 'connection')).toEqual(['connection.store-bucket-missing']);
    } finally {
      await other.remove();
    }
  });

  it('tells a server that is no object store, TLS against plain HTTP, an unresolvable host, a dead port and missing credentials', async () => {
    store.mode.value = 'proxy';
    expect(ids(await check(), 'connection')).toEqual(['connection.store-not-found']);
    store.mode.value = 'serve';

    // An endpoint without http:// makes DuckDB speak TLS.
    const tls = await check({ s3: { endpoint: store.endpoint.replace('http://', ''), urlStyle: 'path' } });
    expect(ids(tls, 'connection')).toEqual(['connection.store-ssl-mismatch']);

    const vhost = await check({ s3: { endpoint: store.endpoint, urlStyle: 'vhost' } });
    expect(ids(vhost, 'connection')).toEqual([
      'connection.store-host-unresolved',
      'connection.url-style-vhost-ip',
    ]);
    expect(vhost.findings.find((item) => item.check === 'connection.url-style-vhost-ip')?.settingKey).toBe(
      's3.urlStyle',
    );

    const dead = await check({ s3: { endpoint: 'http://127.0.0.1:1', urlStyle: 'path' } });
    expect(ids(dead, 'connection')).toEqual(['connection.store-unreachable']);
    expect(dead.findings[0]?.detail).toContain('Could not connect to server');

    const anonymous = await check({ s3Credentials: undefined });
    expect(ids(anonymous, 'connection')).toEqual(['connection.credentials-missing']);
    expect(anonymous.findings[0]?.severity).toBe('warning');
  }, 60_000);

  // The default endpoint of DuckDB is AWS. The engine option s3_endpoint points it at the fake store, which answers like
  // AWS does to a request without keys, so nothing leaves the machine. The setting aantje.s3.endpoint stays empty.
  it('reports a lake with no endpoint and no credentials as one finding that names the endpoint of the environment', async () => {
    store.mode.value = 'denied';
    engineOptions.value = {
      s3_endpoint: store.endpoint.replace('http://', ''),
      s3_use_ssl: 'false',
      s3_url_style: 'path',
    };
    const report = await check({ s3: {}, s3Credentials: undefined }, 'quick', {
      AWS_ENDPOINT_URL_S3: store.endpoint,
      AWS_ENDPOINT_URL: 'http://ignored:9000',
    });

    const connection = report.findings.filter((item) => item.group === 'connection');
    const notSet = connection.find((item) => item.check === 'connection.endpoint-not-set');
    expect(notSet).toMatchObject({
      severity: 'error',
      settingKey: 's3.endpoint',
      suggestion: { endpoint: store.endpoint, urlStyle: 'path', source: 'AWS_ENDPOINT_URL_S3' },
    });
    expect(connection.map((item) => item.check).toSorted()).toEqual([
      'connection.credentials-missing',
      'connection.endpoint-not-set',
      'connection.store-access-denied',
    ]);
    expect(report.groups.map((group) => group.state)).toEqual(['done', 'done', 'skipped', 'skipped']);
    expect(store.requests, 'the request of the engine reached the fake store, not AWS').toHaveLength(1);
    expect(store.requests[0]).toMatch(/^GET \/example-lake\/\?/);
  });
});
