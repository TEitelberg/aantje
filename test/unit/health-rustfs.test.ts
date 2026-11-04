import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataAccess } from '../../src/data/types';
import type { FileProfile } from '../../src/connections/profile';
import { engineSkipReason, extensionDirectory } from './data-support';
import type { DataFixture } from './data-support';
import { checkFixture, editCatalog, ids, lake, problems } from './health-support';

// A real object store: rustfs/rustfs:1.0.4 in a throw-away container with its data in memory. It
// needs Docker, so it runs with AANTJE_RUSTFS=1 (or AANTJE_POSTGRES=1, which asks for Docker as well).
const wanted = process.env.AANTJE_RUSTFS === '1' || process.env.AANTJE_POSTGRES === '1';
const docker = wanted && spawnSync('docker', ['version', '--format', '{{.Server.Version}}']).status === 0;
const skipReason = !wanted
  ? 'set AANTJE_RUSTFS=1 to run it (needs Docker)'
  : !docker
    ? 'Docker is not available'
    : await engineSkipReason();
if (skipReason) {
  console.info(`The health tests with RustFS are skipped: ${skipReason}.`);
}

const BUCKET = 'health-lake';

describe.skipIf(skipReason)('a lake on RustFS', () => {
  const name = `aantje-test-health-${randomBytes(3).toString('hex')}`;
  const keyId = `hc${randomBytes(5).toString('hex')}`;
  const secret = randomBytes(16).toString('hex');
  const directory = mkdtempSync(join(tmpdir(), 'aantje-rustfs-'));
  let endpoint = '';
  let fixture: DataFixture;

  const access = (extra: Partial<DataAccess> = {}): Partial<DataAccess> => ({
    s3: { endpoint, urlStyle: 'path' },
    s3Credentials: { keyId, secretKey: secret },
    ...extra,
  });
  const now = { now: () => new Date() };

  /** Signed requests with curl, which every platform with Docker has. */
  const s3 = (method: string, key: string, file?: string): number =>
    Number(
      execFileSync(
        'curl',
        [
          ...[
            '-sS',
            '-o',
            file && method === 'GET' ? file : process.platform === 'win32' ? 'NUL' : '/dev/null',
          ],
          ...['-w', '%{http_code}', '--aws-sigv4', 'aws:amz:us-east-1:s3', '--user', `${keyId}:${secret}`],
          ...['-X', method, ...(file && method === 'PUT' ? ['-T', file] : [])],
          `${endpoint}/${key}`,
        ],
        { encoding: 'utf8' },
      ),
    );

  async function withLake(statements: readonly string[]): Promise<void> {
    const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
    const connection = await instance.connect();
    try {
      for (const sql of ['LOAD ducklake', 'LOAD sqlite', 'LOAD httpfs']) await connection.run(sql);
      await connection.run(
        `CREATE SECRET s (TYPE s3, KEY_ID '${keyId}', SECRET '${secret}', ENDPOINT '${endpoint.replace('http://', '')}', USE_SSL false, URL_STYLE 'path')`,
      );
      await connection.run(
        `ATTACH 'ducklake:sqlite:${join(directory, 'meta.sqlite').replaceAll('\\', '/')}' AS lake (DATA_PATH 's3://${BUCKET}/ducklake/', DATA_INLINING_ROW_LIMIT 0)`,
      );
      for (const sql of statements) await connection.run(sql);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }

  beforeAll(async () => {
    execFileSync(
      'docker',
      [
        ...['run', '-d', '--name', name, '-p', '127.0.0.1::9000'],
        ...['--tmpfs', '/data:rw,uid=10001,gid=10001,mode=0755'],
        ...['-e', `RUSTFS_ACCESS_KEY=${keyId}`, '-e', `RUSTFS_SECRET_KEY=${secret}`],
        ...['-e', 'RUSTFS_VOLUMES=/data', '-e', 'RUSTFS_ADDRESS=0.0.0.0:9000'],
        ...['-e', 'RUSTFS_CONSOLE_ENABLE=false', '-e', 'RUSTFS_OBS_LOG_DIRECTORY='],
        'rustfs/rustfs:1.0.4',
      ],
      { stdio: 'ignore' },
    );
    const port = execFileSync('docker', ['port', name, '9000/tcp'], { encoding: 'utf8' })
      .trim()
      .split(':')
      .pop();
    endpoint = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt++) {
      if (
        spawnSync('docker', ['exec', name, 'curl', '-fsS', '-o', '/dev/null', 'http://127.0.0.1:9000/health'])
          .status === 0
      )
        break;
      if (attempt > 120) throw new Error('RustFS did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(s3('PUT', BUCKET)).toBe(200);
    await withLake([
      'USE lake',
      'CREATE SCHEMA shop',
      'CREATE TABLE shop.events (id INT, kind VARCHAR)',
      'ALTER TABLE shop.events SET PARTITIONED BY (kind)',
      "INSERT INTO shop.events VALUES (1, 'a b'), (2, 'b'), (3, 'a b')",
      'CREATE TABLE shop.plain (x INT)',
      'INSERT INTO shop.plain SELECT range FROM range(100)',
      'ALTER TABLE shop.plain RENAME TO renamed',
      'DELETE FROM shop.renamed WHERE x < 10',
    ]);
    const profile: FileProfile = {
      id: 'rustfs',
      name: 'rustfs',
      kind: 'sqlite',
      path: join(directory, 'meta.sqlite'),
    };
    fixture = { profile, directory, remove: () => Promise.resolve() };
  }, 180_000);

  afterAll(() => {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    rmSync(directory, { recursive: true, force: true });
  });

  const keysOf = (prefix: string): string[] => {
    const out = execFileSync(
      'curl',
      [
        '-sS',
        '--aws-sigv4',
        'aws:amz:us-east-1:s3',
        '--user',
        `${keyId}:${secret}`,
        `${endpoint}/${BUCKET}/?list-type=2&prefix=${prefix}`,
      ],
      { encoding: 'utf8' },
    );
    return [...out.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => match[1] ?? '');
  };

  it('finds a healthy lake healthy, also with the deep check, and lists with the sizes and no request for a file', async () => {
    const report = await checkFixture(fixture, { scope: lake, depth: 'deep' }, access(), now);

    expect(problems(report)).toEqual([]);
    expect(ids(report)).toEqual([]);
    expect(report.groups.map((group) => group.state)).toEqual(['done', 'done', 'done', 'done']);
    expect(keysOf('ducklake/shop/events/')).toHaveLength(2);
  }, 60_000);

  it('names an object that was deleted, with the key as the store knows it', async () => {
    // The table was renamed to shop.renamed and keeps the directory it was created with.
    const [key = ''] = keysOf('ducklake/shop/plain/');
    const saved = join(directory, 'saved.parquet');
    expect(s3('GET', `${BUCKET}/${key}`, saved)).toBe(200);
    expect(s3('DELETE', `${BUCKET}/${key}`)).toBe(204);
    try {
      const report = await checkFixture(fixture, { scope: lake }, access(), now);

      const missing = report.findings.filter((item) => item.check === 'storage.file-missing');
      expect(missing).toHaveLength(1);
      expect(missing[0]).toMatchObject({ severity: 'error', objectKey: `s3://${BUCKET}/${key}` });
      expect(missing[0]?.scope).toMatchObject({ kind: 'table', schema: 'shop', name: 'renamed' });
      expect(report.summary.errors).toBe(1);
    } finally {
      expect(s3('PUT', `${BUCKET}/${key}`, saved)).toBe(200);
    }
  }, 60_000);

  it('finds an object that no row names, and one with the size of another', async () => {
    const stray = join(directory, 'stray.bin');
    writeFileSync(stray, 'stray');
    expect(s3('PUT', `${BUCKET}/ducklake/shop/events/ducklake-stray.parquet`, stray)).toBe(200);
    const [key = ''] = keysOf('ducklake/shop/events/kind=b');
    const original = join(directory, 'original.parquet');
    expect(s3('GET', `${BUCKET}/${key}`, original)).toBe(200);
    expect(s3('PUT', `${BUCKET}/${key}`, stray)).toBe(200);
    try {
      const report = await checkFixture(fixture, { scope: lake }, access(), now);

      expect(report.findings.map((item) => [item.check, item.severity])).toEqual([
        ['storage.file-size-mismatch', 'error'],
        ['storage.file-orphaned', 'info'],
      ]);
      expect(report.findings[1]?.objectKey).toBe(
        `s3://${BUCKET}/ducklake/shop/events/ducklake-stray.parquet`,
      );
      expect(report.findings[1]?.detail).toContain('5 B, modified just now');
    } finally {
      expect(s3('PUT', `${BUCKET}/${key}`, original)).toBe(200);
      expect(s3('DELETE', `${BUCKET}/ducklake/shop/events/ducklake-stray.parquet`)).toBe(204);
    }
  }, 60_000);

  it('follows the pages of a listing of more than a thousand objects, and cuts it at the limit', async () => {
    const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
    const connection = await instance.connect();
    try {
      await connection.run('LOAD httpfs');
      await connection.run(
        `CREATE SECRET s (TYPE s3, KEY_ID '${keyId}', SECRET '${secret}', ENDPOINT '${endpoint.replace('http://', '')}', USE_SSL false, URL_STYLE 'path')`,
      );
      for (let i = 0; i < 1100; i++) {
        await connection.run(
          `COPY (SELECT ${i} AS x) TO 's3://${BUCKET}/ducklake/zz/f${String(i).padStart(4, '0')}.parquet'`,
        );
      }
    } finally {
      connection.closeSync();
      instance.closeSync();
    }

    const all = await checkFixture(fixture, { scope: lake }, access(), now);
    const cut = await checkFixture(fixture, { scope: lake, limits: { storageFiles: 1050 } }, access(), now);

    // 1 100 objects under zz/ and 4 files of the lake: 50 findings are reported, the rest is counted.
    expect(all.findings.filter((item) => item.check === 'storage.file-orphaned')).toHaveLength(50);
    expect(all.groups[2]).toEqual({ group: 'storage', state: 'done', omitted: 1050 });
    // Cut after the 1 050th key in key order, which lies in zz/: the 4 files of the lake come before it.
    expect(cut.groups[2]).toEqual({ group: 'storage', state: 'done', truncated: true, omitted: 996 });
    for (const key of keysOf('ducklake/zz/')) {
      expect(s3('DELETE', `${BUCKET}/${key}`)).toBe(204);
    }
  }, 180_000);

  it.each([
    [
      'a wrong secret',
      { s3Credentials: { keyId, secretKey: 'wrong-secret-wrong-secret' } },
      'the secret key does not match it',
    ],
    [
      'an unknown key id',
      { s3Credentials: { keyId: 'nosuchkeyid', secretKey: secret } },
      'does not know the key id',
    ],
    ['no credentials', { s3Credentials: undefined }, 'No credentials were sent'],
  ] as const)(
    'refuses %s with the 403 of RustFS',
    async (_name, extra, cause) => {
      const report = await checkFixture(fixture, { scope: lake }, access(extra), now);

      expect(ids(report, 'connection').filter((id) => id !== 'connection.credentials-missing')).toEqual([
        'connection.store-access-denied',
      ]);
      expect(
        report.findings.find((item) => item.check === 'connection.store-access-denied')?.cause,
      ).toContain(cause);
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(JSON.stringify(report)).not.toContain(keyId);
    },
    60_000,
  );

  it('tells a bucket that does not exist', async () => {
    await editCatalog(fixture, [
      `UPDATE meta.ducklake_metadata SET value = 's3://no-such-bucket/ducklake/' WHERE key = 'data_path'`,
    ]);
    try {
      // The environment names the endpoint that is set, so there is nothing to suggest.
      const report = await checkFixture(fixture, { scope: lake }, access(), {
        ...now,
        env: { AWS_ENDPOINT_URL_S3: endpoint },
      });

      expect(ids(report, 'connection')).toEqual(['connection.store-bucket-missing']);
      expect(report.findings[0]?.cause).toContain('The bucket "no-such-bucket" is not in the store');
    } finally {
      await editCatalog(fixture, [
        `UPDATE meta.ducklake_metadata SET value = 's3://${BUCKET}/ducklake/' WHERE key = 'data_path'`,
      ]);
    }
  }, 60_000);

  it('tells the virtual-host style on an IP address and TLS against plain HTTP', async () => {
    const vhost = await checkFixture(
      fixture,
      { scope: lake },
      access({ s3: { endpoint, urlStyle: 'vhost' } }),
      now,
    );
    const tls = await checkFixture(
      fixture,
      { scope: lake },
      access({ s3: { endpoint: endpoint.replace('http://', ''), urlStyle: 'path' } }),
      now,
    );

    expect(ids(vhost, 'connection')).toEqual([
      'connection.store-host-unresolved',
      'connection.url-style-vhost-ip',
    ]);
    expect(ids(tls, 'connection')).toEqual(['connection.store-ssl-mismatch']);
  }, 60_000);

  it('tells a port where nothing listens', async () => {
    const report = await checkFixture(
      fixture,
      { scope: lake },
      access({ s3: { endpoint: 'http://127.0.0.1:1', urlStyle: 'path' } }),
      now,
    );

    expect(ids(report, 'connection')).toEqual(['connection.store-unreachable']);
  }, 60_000);
});
