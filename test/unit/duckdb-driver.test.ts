import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Driver } from '../../src/catalog/drivers/driver';
import { openDuckdb } from '../../src/catalog/drivers/duckdb';
import { AantjeError } from '../../src/errors';
import { BIG_ORDERS_VIEW_SQL, ID, LATEST_SNAPSHOT, SNAPSHOT, SPEC_VERSION } from '../support/expected';
import { fixturePath } from '../support/fixtures';
import { duckdbSource } from '../support/sources/duckdb';
import { sqliteSource } from '../support/sources/sqlite';

const unavailable = duckdbSource.skipReason() !== undefined;

// About 10^10 multiplications: a minute or more of work on any machine unless the driver interrupts it. The
// result is tiny, so a query that was not stopped resolves; it cannot fail by accident and look cancelled.
const LONG_QUERY = 'SELECT max((a.range * b.range) % 7) AS m FROM range(100000) a, range(100000) b';
// Stopping takes milliseconds; anything near this limit means the engine kept working.
const PROMPTLY_MS = 2000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const tempDirs: string[] = [];
const processes = new Set<() => Promise<void>>();

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aantje-duckdb-'));
  tempDirs.push(dir);
  return dir;
}

function copyOfFixture(): string {
  const path = join(tempDir(), 'catalog.duckdb');
  copyFileSync(fixturePath('ducklake.duckdb'), path);
  return path;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function listing(dir: string): Record<string, number> {
  return Object.fromEntries(readdirSync(dir).map((name) => [name, statSync(join(dir, name)).size]));
}

const enginePath = createRequire(import.meta.url).resolve('@duckdb/node-api');

// A second process that opens the catalog with the real engine, optionally runs one statement, and keeps the
// file open until it is stopped. The stdin listener keeps the instance referenced: a garbage-collected
// instance would silently give the file back.
const holderScript = `
const duckdb = require(process.argv[1]);
duckdb.DuckDBInstance.create(process.argv[2], { access_mode: process.argv[3] })
  .then(async (instance) => {
    const connection = await instance.connect();
    await connection.run(process.argv[4] || 'SELECT 1');
    process.stdin.once('end', () => { connection.closeSync(); instance.closeSync(); });
    process.stdin.resume();
    process.stdout.write('ready\\n');
  })
  .catch((error) => { process.stderr.write(String(error.message)); process.exit(2); });
`;

/** Resolves once the other process holds the file; rejects if it could not open it. */
function startProcess(
  path: string,
  mode: 'READ_WRITE' | 'READ_ONLY',
  statement = '',
): Promise<{ stop(): Promise<void> }> {
  const child = spawn(process.execPath, ['-e', holderScript, '--', enginePath, path, mode, statement], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const stop = async (): Promise<void> => {
    child.kill();
    await exited;
  };
  processes.add(stop);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => resolve({ stop }));
    void exited.then(() => reject(new Error(`The other process could not open the file: ${stderr}`)));
  });
}

// Whatever a test leaves behind, no helper process outlives it.
afterEach(async () => {
  await Promise.all([...processes].map((stop) => stop()));
  processes.clear();
});

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe.skipIf(unavailable)('duckdb driver on the DuckLake fixture', () => {
  let driver: Driver;
  let sqlite: Driver;
  beforeAll(async () => {
    driver = await duckdbSource.open();
    sqlite = await sqliteSource.open();
  });
  afterAll(async () => {
    await driver.close();
    await sqlite.close();
  });

  const sameAsSqlite = [
    {
      name: 'DuckLake version',
      sql: "SELECT value FROM ducklake_metadata WHERE key = 'version'",
      params: [],
      expected: [{ value: SPEC_VERSION }],
    },
    {
      name: 'number of snapshots',
      sql: 'SELECT count(*) AS snapshots FROM ducklake_snapshot',
      params: [],
      expected: [{ snapshots: LATEST_SNAPSHOT + 1 }],
    },
    {
      name: 'columns of sales.orders including nested fields',
      sql: 'SELECT column_id, column_name, column_type, parent_column FROM ducklake_column WHERE table_id = ? AND end_snapshot IS NULL ORDER BY column_order',
      params: [ID.orders],
      expected: [
        { column_id: 1, column_name: 'id', column_type: 'int32', parent_column: null },
        { column_id: 2, column_name: 'customer', column_type: 'struct', parent_column: null },
        { column_id: 3, column_name: 'name', column_type: 'varchar', parent_column: 2 },
        { column_id: 4, column_name: 'tags', column_type: 'list', parent_column: 2 },
        { column_id: 5, column_name: 'element', column_type: 'varchar', parent_column: 4 },
        { column_id: 6, column_name: 'attrs', column_type: 'map', parent_column: null },
        { column_id: 7, column_name: 'key', column_type: 'varchar', parent_column: 6 },
        { column_id: 8, column_name: 'value', column_type: 'int32', parent_column: 6 },
        { column_id: 9, column_name: 'amount', column_type: 'decimal(10,2)', parent_column: null },
        { column_id: 10, column_name: 'created', column_type: 'timestamp', parent_column: null },
      ],
    },
    {
      name: 'comment of sales.orders',
      sql: "SELECT value FROM ducklake_tag WHERE object_id = ? AND key = 'comment' AND end_snapshot IS NULL",
      params: [ID.orders],
      expected: [{ value: 'Customer orders' }],
    },
    {
      name: 'definition of the view',
      sql: 'SELECT sql FROM ducklake_view WHERE view_id = ?',
      params: [ID.bigOrdersView],
      expected: [{ sql: BIG_ORDERS_VIEW_SQL }],
    },
    {
      name: 'what the delete statement changed',
      sql: 'SELECT changes_made FROM ducklake_snapshot_changes WHERE snapshot_id = ?',
      params: [SNAPSHOT.deleteOrder2],
      expected: [{ changes_made: `deleted_from_table:${ID.orders}` }],
    },
    {
      name: 'live rows and files of sales.orders after the delete',
      sql: `SELECT sum(f.record_count) - coalesce(sum(d.delete_count), 0) AS live_rows, count(f.data_file_id) AS files
            FROM ducklake_data_file f
            LEFT JOIN ducklake_delete_file d ON d.data_file_id = f.data_file_id
              AND ? >= d.begin_snapshot AND (? < d.end_snapshot OR d.end_snapshot IS NULL)
            WHERE f.table_id = ? AND ? >= f.begin_snapshot AND (? < f.end_snapshot OR f.end_snapshot IS NULL)`,
      params: [LATEST_SNAPSHOT, LATEST_SNAPSHOT, ID.orders, LATEST_SNAPSHOT, LATEST_SNAPSHOT],
      expected: [{ live_rows: 2, files: 1 }],
    },
  ];

  it('reads the same rows from the real catalog as the SQLite fixture does', async () => {
    for (const { name, sql, params, expected } of sameAsSqlite) {
      expect(await driver.query(sql, params), name).toEqual(expected);
      expect(await sqlite.query(sql, params), name).toEqual(expected);
    }
  });

  it('normalises engine types, binds positional parameters and names the columns of a result', async () => {
    const rows = await driver.query(`SELECT
        7::BIGINT AS a_bigint, 8::HUGEINT AS a_hugeint, 9::INTEGER AS an_integer, 1.5 AS a_decimal, 2.25::DOUBLE AS a_double,
        TIMESTAMP '2026-01-02 03:04:05.678' AS a_timestamp,
        TIMESTAMPTZ '2026-01-02 03:04:05.678+02' AS a_timestamptz,
        DATE '2026-01-02' AS a_date,
        TRUE AS a_boolean, NULL AS a_null, 'text' AS a_varchar,
        '12345678-1234-5678-1234-567812345678'::UUID AS a_uuid`);
    expect(rows).toEqual([
      {
        a_bigint: 7,
        a_hugeint: 8,
        an_integer: 9,
        a_decimal: 1.5,
        a_double: 2.25,
        a_timestamp: '2026-01-02T03:04:05.678Z',
        a_timestamptz: '2026-01-02T01:04:05.678Z',
        a_date: '2026-01-02T00:00:00.000Z',
        a_boolean: true,
        a_null: null,
        a_varchar: 'text',
        a_uuid: '12345678-1234-5678-1234-567812345678',
      },
    ]);
    // Timestamps round down to the millisecond, also before 1970.
    expect(
      await driver.query(`SELECT
        TIMESTAMP '2026-01-02 03:04:05.678999' AS after_epoch,
        TIMESTAMP '1969-12-31 23:59:59.9995' AS before_epoch`),
    ).toEqual([{ after_epoch: '2026-01-02T03:04:05.678Z', before_epoch: '1969-12-31T23:59:59.999Z' }]);
    const times = (
      await driver.query('SELECT snapshot_time FROM ducklake_snapshot ORDER BY snapshot_id')
    ).map((row) => row.snapshot_time);
    expect(times).toHaveLength(LATEST_SNAPSHOT + 1);
    for (const time of times) expect(time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect([...times].sort()).toEqual(times);

    expect(await driver.query('SELECT 1 AS a, 2 AS a, 3 AS "MixedCase"')).toEqual([
      { a: 1, 'a:1': 2, mixedcase: 3 },
    ]);
    expect(
      await driver.query('SELECT ? AS flag, ? AS small, ? AS big, ? AS ratio, ? AS text, ? AS nothing', [
        true,
        42,
        3_000_000_000,
        0.25,
        "it's",
        null,
      ]),
    ).toEqual([{ flag: true, small: 42, big: 3_000_000_000, ratio: 0.25, text: "it's", nothing: null }]);
  });

  it('returns exactly representable integers but refuses larger ones instead of rounding them', async () => {
    const edge = await driver.query(
      'SELECT 9007199254740991::BIGINT AS high, -9007199254740991::BIGINT AS low',
    );
    expect(edge).toEqual([{ high: Number.MAX_SAFE_INTEGER, low: Number.MIN_SAFE_INTEGER }]);

    await expect(driver.query('SELECT 9007199254740993::BIGINT AS big')).rejects.toMatchObject({
      code: 'QUERY_FAILED',
      userMessage: expect.stringContaining('9007199254740993') as unknown,
    });
    await expect(driver.query('SELECT -9007199254740993::BIGINT AS big')).rejects.toMatchObject({
      code: 'QUERY_FAILED',
      userMessage: expect.stringContaining('-9007199254740993') as unknown,
    });
    await expect(
      driver.query('SELECT 170141183460469231731687303715884105727::HUGEINT AS huge'),
    ).rejects.toMatchObject({ code: 'QUERY_FAILED' });
  });

  it('answers concurrent queries independently and reports a failing statement as QUERY_FAILED with the engine message', async () => {
    const numbers = Array.from({ length: 12 }, (_, i) => i);
    const results = await Promise.all(numbers.map((n) => driver.query('SELECT ? AS n', [n])));
    expect(results).toEqual(numbers.map((n) => [{ n }]));

    await expect(driver.query('SELEC 1')).rejects.toMatchObject({
      code: 'QUERY_FAILED',
      userMessage: expect.stringContaining('SELEC') as unknown,
      cause: expect.any(Error) as unknown,
    });
    await expect(driver.query('SELECT * FROM no_such_table')).rejects.toMatchObject({
      code: 'QUERY_FAILED',
      userMessage: expect.stringContaining('no_such_table') as unknown,
    });
    expect(await driver.query('SELECT 1 AS still_works')).toEqual([{ still_works: 1 }]);
  });
});

describe.skipIf(unavailable)('duckdb driver is strictly read-only', () => {
  it('rejects every statement that changes the catalog and leaves the catalog file untouched', async () => {
    const statements = [
      "INSERT INTO ducklake_metadata VALUES ('intruder', '1', NULL, NULL)",
      "DELETE FROM ducklake_metadata WHERE key = 'version'",
      "UPDATE ducklake_metadata SET value = '9' WHERE key = 'version'",
      'CREATE TABLE intruder (id INTEGER)',
      'DROP TABLE ducklake_tag',
      'SELECT 1; DELETE FROM ducklake_metadata',
    ];
    const path = copyOfFixture();
    const before = { hash: sha256(path), files: listing(dirname(path)) };
    const driver = await openDuckdb({ path });
    try {
      for (const statement of statements) {
        await expect(driver.query(statement), statement).rejects.toMatchObject({ code: 'QUERY_FAILED' });
      }
      expect(await driver.query("SELECT value FROM ducklake_metadata WHERE key = 'version'")).toEqual([
        { value: SPEC_VERSION },
      ]);
    } finally {
      await driver.close();
    }
    expect(sha256(path)).toBe(before.hash);
    expect(listing(dirname(path))).toEqual(before.files);
  });

  it('does not let a view inside a foreign catalog file read other files', async () => {
    const dir = tempDir();
    const secret = join(dir, 'secret.txt');
    writeFileSync(secret, 'top secret');
    const path = join(dir, 'foreign.duckdb');
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const writable = await DuckDBInstance.create(path);
    const connection = await writable.connect();
    await connection.run(
      `CREATE VIEW leak AS SELECT content FROM read_text('${secret.split('\\').join('/')}')`,
    );
    connection.closeSync();
    writable.closeSync();

    const driver = await openDuckdb({ path });
    try {
      await expect(driver.query('SELECT content FROM leak')).rejects.toMatchObject({ code: 'QUERY_FAILED' });
    } finally {
      await driver.close();
    }
  });
});

describe.skipIf(unavailable)('duckdb driver cancellation', () => {
  let driver: Driver;
  beforeAll(async () => {
    driver = await duckdbSource.open();
  });
  afterAll(() => driver.close());

  // The interrupt is repeated until the query ends; a timer that outlives the query would keep firing for ever.
  async function expectInterruptsToStop(run: () => Promise<unknown>): Promise<void> {
    const { DuckDBConnection } = await import('@duckdb/node-api');
    const interrupt = vi.spyOn(DuckDBConnection.prototype, 'interrupt');
    try {
      await run();
      const atEnd = interrupt.mock.calls.length;
      expect(atEnd).toBeGreaterThan(0);
      await sleep(300);
      expect(interrupt).toHaveBeenCalledTimes(atEnd);
    } finally {
      interrupt.mockRestore();
    }
  }

  it('stops a long-running query with TIMEOUT after statementTimeoutMs, stops repeating the interrupt and stays usable', async () => {
    const limited = await openDuckdb({ path: fixturePath('ducklake.duckdb'), statementTimeoutMs: 300 });
    try {
      const started = performance.now();
      await expectInterruptsToStop(() =>
        expect(limited.query(LONG_QUERY)).rejects.toMatchObject({ code: 'TIMEOUT' }),
      );
      expect(performance.now() - started).toBeLessThan(300 + PROMPTLY_MS + 300);
      expect(await limited.query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    } finally {
      await limited.close();
    }
    // A query that finishes within the limit goes through.
    const roomy = await openDuckdb({ path: fixturePath('ducklake.duckdb'), statementTimeoutMs: 10_000 });
    try {
      expect(await roomy.query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    } finally {
      await roomy.close();
    }
  });

  it('stops a long-running query with ABORTED when its signal fires, stops repeating the interrupt and stays usable', async () => {
    await expectInterruptsToStop(async () => {
      const controller = new AbortController();
      const query = driver.query(LONG_QUERY, [], { signal: controller.signal });
      await sleep(200);
      const aborted = performance.now();
      controller.abort();
      await expect(query).rejects.toMatchObject({ code: 'ABORTED' });
      expect(performance.now() - aborted).toBeLessThan(PROMPTLY_MS);
    });
    expect(await driver.query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    // An already aborted signal runs nothing.
    await expect(driver.query('SELECT 1', [], { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });

  // A query passes through connecting, preparing and running; counting event-loop turns (microseconds) reaches
  // each of these stages, which milliseconds would step over.
  it('cancels a query that is aborted at any stage after it was submitted', async () => {
    for (const turns of [0, 1, 2, 4, 8, 16, 32, 64, 128]) {
      const controller = new AbortController();
      const query = driver.query(LONG_QUERY, [], { signal: controller.signal });
      for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
      const aborted = performance.now();
      controller.abort();
      await expect(query, `after ${turns} turns`).rejects.toMatchObject({ code: 'ABORTED' });
      expect(performance.now() - aborted).toBeLessThan(PROMPTLY_MS);
    }
  });

  it('cancels a query that is aborted at the very moment the engine is about to start it', async () => {
    // The engine discards an interrupt that arrives before it starts a statement, so the driver has to repeat
    // it. Aborting right before the real run call hits that moment every time instead of by luck.
    const { DuckDBConnection } = await import('@duckdb/node-api');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- applied to the instance below
    const run = DuckDBConnection.prototype.run;
    const controller = new AbortController();
    const abortThenRun = vi.spyOn(DuckDBConnection.prototype, 'run').mockImplementation(function (
      this: InstanceType<typeof DuckDBConnection>,
      ...args: Parameters<typeof run>
    ) {
      controller.abort();
      return run.apply(this, args);
    });
    try {
      const started = performance.now();
      await expect(driver.query(LONG_QUERY, [], { signal: controller.signal })).rejects.toMatchObject({
        code: 'ABORTED',
      });
      expect(performance.now() - started).toBeLessThan(PROMPTLY_MS);
    } finally {
      abortThenRun.mockRestore();
    }
  });

  it('cancels only the query whose signal fired', async () => {
    const first = new AbortController();
    const second = new AbortController();
    const a = driver.query(LONG_QUERY, [], { signal: first.signal });
    const b = driver.query(LONG_QUERY, [], { signal: second.signal });
    let bSettled = false;
    const bResult = b.then(
      () => (bSettled = true),
      () => (bSettled = true),
    );
    await sleep(200);
    const aborted = performance.now();
    first.abort();
    await expect(a).rejects.toMatchObject({ code: 'ABORTED' });
    expect(performance.now() - aborted).toBeLessThan(PROMPTLY_MS);
    await sleep(300);
    expect(bSettled).toBe(false);
    second.abort();
    await expect(b).rejects.toMatchObject({ code: 'ABORTED' });
    await bResult;
  });
});

describe.skipIf(unavailable)('duckdb driver and other users of the file', () => {
  it('reports LOCKED while another process has the catalog open for writing, also for the Linux and macOS lock error, and connects once it lets go', async () => {
    const path = copyOfFixture();
    const writer = await startProcess(path, 'READ_WRITE');

    await expect(openDuckdb({ path })).rejects.toMatchObject({ code: 'LOCKED' });

    await writer.stop();
    const driver = await openDuckdb({ path });
    try {
      expect(await driver.query("SELECT value FROM ducklake_metadata WHERE key = 'version'")).toEqual([
        { value: SPEC_VERSION },
      ]);
    } finally {
      await driver.close();
    }

    const { DuckDBInstance } = await import('@duckdb/node-api');
    const engineError = new Error(
      'IO Error: Could not set lock on file "catalog.duckdb": Conflicting lock is held in /usr/bin/node (PID 1)',
    );
    const create = vi.spyOn(DuckDBInstance, 'create').mockRejectedValue(engineError);
    try {
      await expect(openDuckdb({ path: fixturePath('ducklake.duckdb') })).rejects.toMatchObject({
        code: 'LOCKED',
        cause: engineError,
      });
    } finally {
      create.mockRestore();
    }
  });

  it('shares the file with other readers and keeps writers out until it is closed', async () => {
    const path = copyOfFixture();
    const driver = await openDuckdb({ path });
    try {
      const reader = await startProcess(path, 'READ_ONLY');
      await reader.stop();
      await expect(startProcess(path, 'READ_WRITE')).rejects.toThrow();
    } finally {
      await driver.close();
    }
    const writer = await startProcess(path, 'READ_WRITE');
    await writer.stop();
  });

  it('releases the file after failed, timed-out and cancelled queries', async () => {
    const path = copyOfFixture();
    const driver = await openDuckdb({ path, statementTimeoutMs: 200 });
    await expect(driver.query('SELEC 1')).rejects.toMatchObject({ code: 'QUERY_FAILED' });
    await expect(driver.query(LONG_QUERY)).rejects.toMatchObject({ code: 'TIMEOUT' });
    const controller = new AbortController();
    controller.abort();
    await expect(driver.query('SELECT 1', [], { signal: controller.signal })).rejects.toMatchObject({
      code: 'ABORTED',
    });
    await driver.close();

    const writer = await startProcess(path, 'READ_WRITE');
    await writer.stop();
  });

  it('cancels a running query on close(), which returns only after the query has ended', async () => {
    const path = copyOfFixture();
    const driver = await openDuckdb({ path });
    const running = driver.query(LONG_QUERY);
    let ended = false;
    const markEnded = (): void => void (ended = true);
    running.then(markEnded, markEnded);
    await sleep(200);
    const closing = performance.now();
    await driver.close();
    expect(ended).toBe(true);
    expect(performance.now() - closing).toBeLessThan(PROMPTLY_MS);
    await expect(running).rejects.toMatchObject({ code: 'ABORTED' });

    const writer = await startProcess(path, 'READ_WRITE');
    await writer.stop();
  });

  it('can be closed and opened repeatedly, refuses queries once closed, and opens a file that this process already holds', async () => {
    const closed = await duckdbSource.open();
    await Promise.all([closed.close(), closed.close()]);
    await closed.close();
    await expect(closed.query('SELECT 1')).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });

    const path = copyOfFixture();
    const snapshots = 'SELECT count(*) AS snapshots FROM ducklake_snapshot';
    const first = await openDuckdb({ path });
    for (let round = 0; round < 5; round++) {
      const again = await openDuckdb({ path });
      expect(await again.query(snapshots)).toEqual([{ snapshots: LATEST_SNAPSHOT + 1 }]);
      await again.close();
    }
    expect(await first.query(snapshots)).toEqual([{ snapshots: LATEST_SNAPSHOT + 1 }]);
    await first.close();
    const writer = await startProcess(path, 'READ_WRITE');
    await writer.stop();

    // The engine shares an instance that this process holds through its cache.
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const other = await DuckDBInstance.fromCache(path, { access_mode: 'READ_ONLY' });
    try {
      const driver = await openDuckdb({ path });
      try {
        expect(await driver.query(snapshots)).toEqual([{ snapshots: LATEST_SNAPSHOT + 1 }]);
      } finally {
        await driver.close();
      }
    } finally {
      other.closeSync();
    }
  });

  it('shows commits that a crashed writer left in the write-ahead log without touching any file', async () => {
    const path = copyOfFixture();
    const writer = await startProcess(
      path,
      'READ_WRITE',
      "INSERT INTO ducklake_metadata VALUES ('crash_marker', '1', NULL, NULL)",
    );
    await writer.stop();
    expect(readdirSync(dirname(path))).toContain(`${basename(path)}.wal`);
    const before = { hash: sha256(path), files: listing(dirname(path)) };

    const driver = await openDuckdb({ path });
    try {
      expect(await driver.query("SELECT value FROM ducklake_metadata WHERE key = 'crash_marker'")).toEqual([
        { value: '1' },
      ]);
    } finally {
      await driver.close();
    }
    expect(sha256(path)).toBe(before.hash);
    expect(listing(dirname(path))).toEqual(before.files);
  });
});

describe.skipIf(unavailable)('duckdb driver on unusable files', () => {
  it('reports a missing file or an unreadable path as FILE_NOT_FOUND, not LOCKED', async () => {
    const path = join(tempDir(), 'missing.duckdb');
    await expect(openDuckdb({ path })).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
      userMessage: expect.stringContaining(path) as unknown,
      cause: expect.any(Error) as unknown,
    });
    await expect(openDuckdb({ path: join(tempDir(), 'nul\0byte.duckdb') })).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
  });

  it('reports a text file, an empty file and a SQLite database as CONNECTION_FAILED', async () => {
    const contents = {
      'a text file': Buffer.from('this is plain text, definitely not a database file '.repeat(20)),
      'an empty file': Buffer.alloc(0),
      'a SQLite database': readFileSync(fixturePath('ducklake.sqlite')),
    };
    for (const [name, content] of Object.entries(contents)) {
      const path = join(tempDir(), 'other.duckdb');
      writeFileSync(path, content);
      await expect(openDuckdb({ path }), name).rejects.toMatchObject({
        code: 'CONNECTION_FAILED',
        userMessage: expect.stringContaining(path) as unknown,
        cause: expect.any(Error) as unknown,
      });
    }
  });

  it('reports a truncated or corrupt DuckDB file with the message of the engine', async () => {
    const original = readFileSync(fixturePath('ducklake.duckdb'));
    const damaged = {
      truncated: original.subarray(0, 8192),
      corrupt: Buffer.concat([original.subarray(0, 4096), Buffer.alloc(4096, 0xab), original.subarray(8192)]),
    };
    for (const [kind, content] of Object.entries(damaged)) {
      const path = join(tempDir(), 'damaged.duckdb');
      writeFileSync(path, content);
      const error = (await openDuckdb({ path }).catch((e: unknown) => e)) as AantjeError;
      expect(error, kind).toBeInstanceOf(AantjeError);
      expect(error.code, kind).toBe('CONNECTION_FAILED');
      expect(error.userMessage, kind).toContain(path);
      expect(error.cause, kind).toBeInstanceOf(Error);
      if (kind === 'corrupt') expect(error.userMessage).toContain('Corrupt database file');
    }
  });
});

describe('duckdb driver without the native engine', () => {
  it('stays importable and reports CONNECTION_FAILED when the binding cannot be loaded', async () => {
    vi.resetModules();
    vi.doMock('@duckdb/node-api', () => {
      throw new Error('Cannot find module @duckdb/node-bindings-linux-x64/duckdb.node');
    });
    try {
      const { openDuckdb: openWithoutEngine } = await import('../../src/catalog/drivers/duckdb');
      await expect(openWithoutEngine({ path: fixturePath('ducklake.duckdb') })).rejects.toMatchObject({
        code: 'CONNECTION_FAILED',
        cause: expect.any(Error) as unknown,
      });
    } finally {
      vi.doUnmock('@duckdb/node-api');
      vi.resetModules();
    }
  });
});
