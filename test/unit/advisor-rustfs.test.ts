import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdvisorData } from '../../src/advisor/model';
import { readAdvisor } from '../../src/advisor/read';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { createCatalogReader } from '../../src/catalog/reader';
import type { FileProfile } from '../../src/connections/profile';
import type { DataAccess } from '../../src/data/types';
import { wasmPath } from '../support/fixtures';
import { engineSkipReason, extensionDirectory } from './data-support';

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
  console.info(`The advisor tests with RustFS are skipped: ${skipReason}.`);
}

const BUCKET = 'advisor-lake';

describe.skipIf(skipReason)('the Maintenance Advisor on a lake in RustFS', () => {
  const name = `aantje-test-advisor-${randomBytes(3).toString('hex')}`;
  const keyId = `ad${randomBytes(5).toString('hex')}`;
  const secret = randomBytes(16).toString('hex');
  let directory = '';
  let endpoint = '';
  let data: AdvisorData;
  /** The size of the file of `merged` that the catalog still needs. */
  let keptBytes = 0;

  /** Signed requests with curl, which every platform with Docker has. */
  const curl = (args: readonly string[]): string =>
    execFileSync(
      'curl',
      ['-sS', '--aws-sigv4', 'aws:amz:us-east-1:s3', '--user', `${keyId}:${secret}`, ...args],
      { encoding: 'utf8' },
    );
  const put = (key: string, bytes: number): void => {
    const file = join(directory, 'upload.bin');
    writeFileSync(file, 'z'.repeat(bytes));
    curl(['-X', 'PUT', '-T', file, `${endpoint}/${BUCKET}/${key}`]);
  };
  /** The keys below a prefix with the size of each, as the store lists them. */
  const listing = (prefix: string): Map<string, number> =>
    new Map(
      [
        ...curl([`${endpoint}/${BUCKET}/?list-type=2&prefix=${prefix}`]).matchAll(
          /<Key>([^<]+)<\/Key>[\s\S]*?<Size>(\d+)<\/Size>/g,
        ),
      ].map((match) => [match[1] ?? '', Number(match[2])]),
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
    directory = mkdtempSync(join(tmpdir(), 'aantje-advisor-rustfs-'));
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
    curl(['-X', 'PUT', `${endpoint}/${BUCKET}`]);
    await withLake([
      'USE lake',
      'CREATE TABLE many (id INT)',
      ...[0, 1, 2, 3, 4, 5].map((part) => `INSERT INTO many SELECT range + ${part * 10} FROM range(10)`),
      'CREATE TABLE merged (id INT)',
      ...[0, 1, 2].map((part) => `INSERT INTO merged SELECT range + ${part * 10} FROM range(10)`),
      "CALL ducklake_merge_adjacent_files('lake', 'merged')",
      "CALL ducklake_expire_snapshots('lake', older_than => now() + INTERVAL 1 DAY)",
      // The objects are as old as the test, so the age that DuckLake applies to them must be none.
      "CALL lake.set_option('delete_older_than', '0 seconds')",
    ]);
    put('ducklake/stray-a.parquet', 1234);
    put('ducklake/sub/stray-b.parquet', 4321);
    const profile: FileProfile = {
      id: 'rustfs',
      name: 'rustfs',
      kind: 'sqlite',
      path: join(directory, 'meta.sqlite'),
    };
    const access: DataAccess = {
      profile,
      s3: { endpoint, urlStyle: 'path' },
      s3Credentials: { keyId, secretKey: secret },
      extensionDirectory,
    };
    const reader = createCatalogReader(await openSqlite({ path: profile.path, wasmPath }));
    try {
      data = await readAdvisor({ reader, access }, 'RustFS lake', new Date(), undefined);
      const { files } = await reader.fileLocations({}, (await reader.properties()).dataPath, 100);
      keptBytes = files
        .filter((file) => file.table === 'merged' && file.endSnapshot === null)
        .reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
    } finally {
      await reader.close();
    }
  }, 240_000);

  afterAll(() => {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    if (directory !== '') rmSync(directory, { recursive: true, force: true });
  });

  it('sizes the orphaned objects with the sizes the store lists', () => {
    const sizes = listing('ducklake/');
    expect(data.orphans).toEqual({
      state: 'measured',
      value: {
        files: 2,
        bytes:
          (sizes.get('ducklake/stray-a.parquet') ?? 0) + (sizes.get('ducklake/sub/stray-b.parquet') ?? 0),
        sized: 2,
      },
    });
    expect(data.orphans).toMatchObject({ value: { bytes: 1234 + 4321 } });
  });

  it('sizes the objects the cleanup would delete: the store holds four files of the merged table, the catalog needs one', () => {
    const sizes = listing('ducklake/main/merged/');
    expect(sizes.size).toBe(4);
    expect(keptBytes).toBeGreaterThan(0);
    expect(data.scheduled.count).toBe(3);
    expect(data.cleanup).toEqual({
      state: 'measured',
      value: {
        files: 3,
        bytes: [...sizes.values()].reduce((sum, size) => sum + size, 0) - keptBytes,
        sized: 3,
      },
    });
  });

  it('names the tables with many small files and measures the dry runs of the expiry', () => {
    expect(data.merge.map(({ table, files, smallFiles }) => [table.name, files, smallFiles])).toEqual([
      ['many', 6, 6],
    ]);
    expect(data.expiry).toMatchObject({ state: 'measured', value: { expiring: 0 } });
    expect(data.policy.delete).toBe('0 seconds');
  });
});
