import { randomBytes } from 'node:crypto';
import { connect, createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { TLSSocket } from 'node:tls';
import { inspect } from 'node:util';
import { Client, types as pgTypes } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { Driver, Row } from '../../src/catalog/drivers/driver';
import { openPostgres } from '../../src/catalog/drivers/postgres';
import type { PostgresOptions } from '../../src/catalog/drivers/postgres';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { ID, SPEC_VERSION } from '../support/expected';
import { fixturePath, wasmPath } from '../support/fixtures';
import { SELF_SIGNED_CERT, SELF_SIGNED_KEY } from '../support/tls-fixture';
import type { PostgresFixture } from '../support/global-setup';
import { postgresSource } from '../support/sources/postgres';

const skipReason = postgresSource.skipReason();
if (skipReason !== undefined) {
  console.info(`The Postgres driver tests are skipped: ${skipReason}.`);
}

const containing = (text: string): unknown => expect.stringContaining(text);
const unique = (prefix: string): string => `${prefix}_${randomBytes(4).toString('hex')}`;

function fixture(): PostgresFixture {
  const connection = inject('postgres');
  if (!connection) {
    throw new Error('The Postgres fixture is not running.');
  }
  return connection;
}

/** Runs `use` while an environment variable of this process has the given value. */
async function withEnv<T>(name: string, value: string, use: () => Promise<T>): Promise<T> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await use();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

/** A local port that nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A server that accepts the PostgreSQL SSLRequest and then presents a self-signed certificate. */
async function selfSignedTlsServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.once('data', () => {
      socket.write('S');
      const secure = new TLSSocket(socket, { isServer: true, key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT });
      sockets.add(secure);
      secure.on('error', () => undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A TCP proxy to the fixture server that holds back every connection except the first by `delayMs`. */
async function proxyThatDelaysReconnects(
  delayMs: number,
): Promise<{ port: number; close: () => Promise<void> }> {
  const target = fixture();
  const sockets = new Set<Socket>();
  const track = (socket: Socket): Socket => {
    socket.on('error', () => undefined);
    sockets.add(socket);
    return socket;
  };
  let connections = 0;
  const server = createServer((client) => {
    track(client);
    setTimeout(
      () => {
        const upstream = track(connect(target.port, target.host));
        client.pipe(upstream).pipe(client);
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
      },
      connections++ === 0 ? 0 : delayMs,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Polls until the value is reached: the server needs a moment to notice a closed connection. */
async function eventually<T>(read: () => Promise<T> | T, expected: T): Promise<void> {
  const deadline = Date.now() + 3_000;
  let actual = await read();
  while (actual !== expected && Date.now() < deadline) {
    await sleep(50);
    actual = await read();
  }
  expect(actual).toBe(expected);
}

/** SQLite keeps booleans as 0/1; the logical content is what has to be equal. */
function comparable(rows: Row[]): unknown[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, typeof value === 'boolean' ? Number(value) : value]),
    ),
  );
}

describe.skipIf(skipReason !== undefined)(
  skipReason === undefined ? 'postgres driver' : `postgres driver (skipped: ${skipReason})`,
  () => {
    const opened: Driver[] = [];
    let admin: Client;

    async function open(overrides: Partial<PostgresOptions> = {}): Promise<Driver> {
      const driver = await openPostgres({ ...fixture(), ...overrides });
      opened.push(driver);
      return driver;
    }

    /** Facts about the catalog that a write would change. Read over a plain connection, not the driver under test. */
    async function fingerprint(): Promise<unknown> {
      const { rows } = await admin.query(`SELECT
        (SELECT count(*) FROM ducklake_metadata) AS metadata_rows,
        (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public') AS tables`);
      return rows;
    }

    async function sessionsOf(role: string): Promise<number> {
      const { rows } = await admin.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1',
        [role],
      );
      return rows[0]?.n ?? -1;
    }

    /** A login role that is dropped after `use` returns. `limit` caps its simultaneous connections. */
    async function withRole<T>(use: (role: string, password: string) => Promise<T>, limit = -1): Promise<T> {
      const role = unique('aantje_role');
      const password = randomBytes(12).toString('hex');
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' CONNECTION LIMIT ${limit}`);
      try {
        return await use(role, password);
      } finally {
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1', [
          role,
        ]);
        await admin.query(`DROP ROLE ${role}`);
      }
    }

    beforeAll(async () => {
      admin = new Client(fixture());
      await admin.connect();
    });
    afterEach(async () => {
      await Promise.all(opened.splice(0).map((driver) => driver.close()));
    });
    afterAll(async () => {
      await admin.end();
    });

    describe('catalog content', () => {
      it('reads the DuckLake specification version and the column tree of sales.orders with exact values', async () => {
        const driver = await open();
        expect(await driver.query("SELECT value FROM ducklake_metadata WHERE key = 'version'")).toEqual([
          { value: SPEC_VERSION },
        ]);
        const rows = await driver.query(
          `SELECT column_id, column_name, column_type, parent_column, nulls_allowed
           FROM ducklake_column WHERE table_id = ? AND end_snapshot IS NULL ORDER BY column_order`,
          [ID.orders],
        );
        const column = (
          column_id: number,
          column_name: string,
          column_type: string,
          parent_column: number | null,
          nulls_allowed = true,
        ): Row => ({ column_id, column_name, column_type, parent_column, nulls_allowed });
        expect(rows).toEqual([
          column(1, 'id', 'int32', null, false),
          column(2, 'customer', 'struct', null),
          column(3, 'name', 'varchar', 2),
          column(4, 'tags', 'list', 2),
          column(5, 'element', 'varchar', 4),
          column(6, 'attrs', 'map', null),
          column(7, 'key', 'varchar', 6),
          column(8, 'value', 'int32', 6),
          column(9, 'amount', 'decimal(10,2)', null),
          column(10, 'created', 'timestamp', null),
        ]);
      });

      // Table by table, so that a failure names the table whose content differs.
      const tables = {
        snapshots:
          'SELECT snapshot_id, schema_version, next_catalog_id, next_file_id FROM ducklake_snapshot ORDER BY snapshot_id',
        'snapshot changes':
          'SELECT snapshot_id, changes_made FROM ducklake_snapshot_changes ORDER BY snapshot_id',
        schemas:
          'SELECT schema_id, schema_name, begin_snapshot, end_snapshot, path FROM ducklake_schema ORDER BY schema_id',
        tables:
          'SELECT table_id, schema_id, table_name, begin_snapshot, end_snapshot, path FROM ducklake_table ORDER BY table_id',
        columns: `SELECT table_id, column_id, column_order, column_name, column_type, begin_snapshot, end_snapshot,
          nulls_allowed, parent_column, default_value, default_value_type
          FROM ducklake_column ORDER BY table_id, column_id, begin_snapshot`,
        views: `SELECT view_id, schema_id, view_name, dialect, sql, column_aliases, begin_snapshot, end_snapshot
          FROM ducklake_view ORDER BY view_id`,
        tags: 'SELECT object_id, key, value, begin_snapshot, end_snapshot FROM ducklake_tag ORDER BY object_id, begin_snapshot',
        'column tags': `SELECT table_id, column_id, key, value, begin_snapshot, end_snapshot
          FROM ducklake_column_tag ORDER BY table_id, column_id, begin_snapshot`,
        'data files':
          'SELECT data_file_id, table_id, begin_snapshot, end_snapshot, path_is_relative, record_count, file_size_bytes FROM ducklake_data_file ORDER BY data_file_id',
        'delete files': `SELECT delete_file_id, table_id, data_file_id, begin_snapshot, end_snapshot, path_is_relative,
          delete_count, file_size_bytes FROM ducklake_delete_file ORDER BY delete_file_id`,
      };
      it('holds the same content in every catalog table as the SQLite fixture', async () => {
        const postgres = await open();
        const sqlite = await openSqlite({ path: fixturePath('ducklake.sqlite'), wasmPath });
        try {
          for (const [name, sql] of Object.entries(tables)) {
            const expected = comparable(await sqlite.query(sql));
            expect(expected.length, name).toBeGreaterThan(0);
            expect(comparable(await postgres.query(sql)), name).toEqual(expected);
          }
        } finally {
          await sqlite.close();
        }
      });
    });

    describe('values', () => {
      it('normalises BIGINT, NUMERIC, booleans, NULL, infinite timestamps and column names, and leaves the pg type parsers alone', async () => {
        const driver = await open();
        expect(
          await driver.query(
            'SELECT count(*) AS files, sum(record_count) AS total_rows, max(begin_snapshot) AS last FROM ducklake_data_file',
          ),
        ).toEqual([{ files: 2, total_rows: 4, last: 5 }]);
        // Whole numbers beyond 2^53 and fractional NUMERIC stay exact instead of being rounded.
        expect(
          await driver.query(
            'SELECT 9007199254740993::bigint AS huge, 1.50::numeric(10,2) AS amount, 1.0000000000000000001::numeric AS tiny, 2.00::numeric(10,2) AS whole',
          ),
        ).toEqual([{ huge: '9007199254740993', amount: '1.50', tiny: '1.0000000000000000001', whole: 2 }]);
        expect(
          await driver.query(
            `SELECT nulls_allowed, parent_column, true AS yes, false AS no, NULL::text AS nothing
             FROM ducklake_column WHERE table_id = ? AND column_id = ?`,
            [ID.orders, 1],
          ),
        ).toEqual([{ nulls_allowed: false, parent_column: null, yes: true, no: false, nothing: null }]);
        expect(
          await driver.query("SELECT 'infinity'::timestamptz AS later, '-infinity'::timestamp AS earlier"),
        ).toEqual([{ later: 'infinity', earlier: '-infinity' }]);
        expect(await driver.query('SELECT 1 AS "MixedCase", 2 AS plain')).toEqual([
          { mixedcase: 1, plain: 2 },
        ]);
        const globalParser = (oid: number): ((text: string) => unknown) =>
          pgTypes.getTypeParser(oid) as (text: string) => unknown;
        expect(globalParser(pgTypes.builtins.INT8)('42')).toBe('42');
        expect(globalParser(pgTypes.builtins.TIMESTAMPTZ)('2026-01-02 03:04:05+00')).toBeInstanceOf(Date);
      });

      it('returns timestamps as ISO 8601 UTC whatever the time zone of the session or the machine is', async () => {
        const driver = await open();
        await driver.query("SET TIME ZONE 'Asia/Kolkata'");
        const rows = await driver.query(
          `SELECT '2026-01-02 03:04:05.678901+02'::timestamptz AS moment, snapshot_time,
                  to_char(snapshot_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS from_server
           FROM ducklake_snapshot WHERE snapshot_id = ?`,
          [ID.mainSchema],
        );
        expect(rows[0]?.moment).toBe('2026-01-02T01:04:05.678Z');
        expect(rows[0]?.snapshot_time).toBe(rows[0]?.from_server);

        const other = await open();
        await withEnv('TZ', 'Pacific/Auckland', async () => {
          // Guard: if the zone did not change, the assertion below could not fail.
          expect(new Date(2026, 0, 2).getTimezoneOffset()).toBe(-780);
          expect(await other.query("SELECT '2026-01-02 03:04:05'::timestamp AS moment")).toEqual([
            { moment: '2026-01-02T03:04:05.000Z' },
          ]);
        });
      });
    });

    describe('parameters', () => {
      it('binds ? placeholders in order, treats a parameter as data and never as SQL', async () => {
        const driver = await open();
        expect(
          await driver.query(
            'SELECT column_name FROM ducklake_column WHERE table_id = ? AND column_id = ? AND end_snapshot IS NULL',
            [ID.orders, 9],
          ),
        ).toEqual([{ column_name: 'amount' }]);
        expect(
          await driver.query('SELECT ?::boolean AS yes, ?::boolean AS no, ?::bigint AS nothing', [
            true,
            false,
            null,
          ]),
        ).toEqual([{ yes: true, no: false, nothing: null }]);
        const before = await fingerprint();
        const attack = "x'); DROP TABLE ducklake_metadata; --";
        expect(await driver.query('SELECT ?::text AS echoed', [attack])).toEqual([{ echoed: attack }]);
        expect(await fingerprint()).toEqual(before);
      });

      it('runs queries that are issued at the same time one after the other, each with its own result', async () => {
        const driver = await open();
        const results = await Promise.all(
          [3, 1, 2].map((n) => driver.query('SELECT ?::bigint AS n FROM pg_sleep(?)', [n, n / 10])),
        );
        expect(results).toEqual([[{ n: 3 }], [{ n: 1 }], [{ n: 2 }]]);
      });
    });

    describe('read-only', () => {
      it('refuses every statement that changes the catalog and leaves the catalog unchanged', async () => {
        const driver = await open();
        const before = await fingerprint();
        for (const statement of [
          "INSERT INTO ducklake_metadata (key, value) VALUES ('hacked', '1')",
          "UPDATE ducklake_metadata SET value = '9.9' WHERE key = 'version'",
          "DELETE FROM ducklake_metadata WHERE key = 'version'",
          'DROP TABLE ducklake_snapshot_changes',
          'CREATE TABLE ducklake_stray (x int)',
        ]) {
          await expect(driver.query(statement), statement).rejects.toMatchObject({ code: 'QUERY_FAILED' });
          expect(await fingerprint(), statement).toEqual(before);
        }
        expect(await driver.query("SELECT value FROM ducklake_metadata WHERE key = 'version'")).toEqual([
          { value: SPEC_VERSION },
        ]);
      });
    });

    describe('time limit and abort', () => {
      it('stops a query that runs longer than statementTimeoutMs with TIMEOUT and stays usable', async () => {
        const driver = await open({ statementTimeoutMs: 300 });
        const started = Date.now();
        await expect(driver.query('SELECT pg_sleep(30)')).rejects.toMatchObject({ code: 'TIMEOUT' });
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(await driver.query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      });

      it('cancels the running statement on the server when the signal aborts, ignores a late signal and an aborted one runs nothing', async () => {
        const driver = await open();
        const marker = unique('abort');
        const controller = new AbortController();
        const started = Date.now();
        const pending = driver.query(`SELECT pg_sleep(60) /* ${marker} */`, [], {
          signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 150);

        await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
        expect(Date.now() - started).toBeLessThan(5_000);
        const { rows } = await admin.query(
          "SELECT pid FROM pg_stat_activity WHERE state = 'active' AND pid <> pg_backend_pid() AND query LIKE $1",
          [`%${marker}%`],
        );
        expect(rows).toEqual([]);
        expect(await driver.query('SELECT 1 AS one')).toEqual([{ one: 1 }]);

        // A signal that aborts after its query has finished does not touch the next one.
        const late = new AbortController();
        expect(await driver.query('SELECT 1 AS one', [], { signal: late.signal })).toEqual([{ one: 1 }]);
        const later = driver.query('SELECT 5 AS five FROM pg_sleep(0.6)');
        setTimeout(() => late.abort(), 150);
        await expect(later).resolves.toEqual([{ five: 5 }]);

        await expect(driver.query('SELECT 1', [], { signal: AbortSignal.abort() })).rejects.toMatchObject({
          code: 'ABORTED',
        });
      });

      it('closes the connection that carried a cancel request', async () => {
        // The role may open two connections: the driver and, briefly, the one that cancels.
        await withRole(async (user, password) => {
          const driver = await open({ user, password });
          for (let round = 0; round < 3; round++) {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 100);
            await expect(
              driver.query('SELECT pg_sleep(30)', [], { signal: controller.signal }),
            ).rejects.toMatchObject({ code: 'ABORTED' });
          }
          await eventually(() => sessionsOf(user), 1);
          expect(await driver.query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
          await driver.close();
          await eventually(() => sessionsOf(user), 0);
        }, 2);
      });

      it('does not cancel the running statement when a query that waits behind it is aborted', async () => {
        const driver = await open();
        const controller = new AbortController();
        const running = driver.query('SELECT 7 AS seven FROM pg_sleep(0.8)');
        const waiting = driver.query('SELECT 1', [], { signal: controller.signal });
        controller.abort();

        await expect(waiting).rejects.toMatchObject({ code: 'ABORTED' });
        await expect(running).resolves.toEqual([{ seven: 7 }]);
      });

      it('does not let a cancel request that arrives late hit the next statement', async () => {
        // Abort and restart: the first query ends long before its cancel request (a new connection, held back
        // by the proxy) reaches the server. The next query must not start before that request has been handled.
        const proxy = await proxyThatDelaysReconnects(300);
        try {
          const driver = await open({ host: '127.0.0.1', port: proxy.port });
          const controller = new AbortController();
          const first = driver.query('SELECT 1 FROM pg_sleep(0.05)', [], { signal: controller.signal });
          const second = driver.query('SELECT 8 AS eight FROM pg_sleep(0.6)');
          setTimeout(() => controller.abort(), 10);

          await first.catch(() => undefined);
          await expect(second).resolves.toEqual([{ eight: 8 }]);
          await driver.close();
        } finally {
          await proxy.close();
        }
      });

      it('gives up the connection when the cancel request cannot be delivered, so that the abort still returns', async () => {
        // The role may open one connection only, so the second connection for the cancel request is refused.
        await withRole(async (user, password) => {
          const driver = await open({ user, password });
          const controller = new AbortController();
          setTimeout(() => controller.abort(), 150);
          const started = Date.now();

          await expect(
            driver.query('SELECT pg_sleep(5)', [], { signal: controller.signal }),
          ).rejects.toMatchObject({ code: 'ABORTED' });
          expect(Date.now() - started).toBeLessThan(4_000);
          await expect(driver.query('SELECT 1')).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
        }, 1);
      });
    });

    describe('failures while connecting', () => {
      it('maps wrong credentials to AUTH_FAILED and an unreachable server to CONNECTION_FAILED naming what was asked for', async () => {
        const port = await closedPort();
        const cases: [string, Partial<PostgresOptions>, string, string?][] = [
          ['a wrong password', { password: 'not-the-password' }, 'AUTH_FAILED'],
          ['a missing password', { password: undefined }, 'AUTH_FAILED'],
          [
            'a database that does not exist',
            { database: 'no_such_database' },
            'CONNECTION_FAILED',
            'no_such_database',
          ],
          ['a closed port', { host: '127.0.0.1', port }, 'CONNECTION_FAILED', `127.0.0.1:${port}`],
          // Node tries IPv4 and IPv6 on localhost.
          [
            'a closed port on localhost',
            { host: 'localhost', port },
            'CONNECTION_FAILED',
            `localhost:${port}`,
          ],
          [
            'an unknown host',
            { host: 'aantje-test.invalid', port: 5432 },
            'CONNECTION_FAILED',
            'aantje-test.invalid:5432',
          ],
        ];
        for (const [name, overrides, code, datum] of cases) {
          await expect(openPostgres({ ...fixture(), ...overrides }), name).rejects.toMatchObject({
            code,
            ...(datum === undefined ? {} : { userMessage: containing(datum) }),
          });
        }
        // A missing password is not taken from PGPASSWORD.
        await withEnv('PGPASSWORD', fixture().password, async () => {
          await expect(openPostgres({ ...fixture(), password: undefined })).rejects.toMatchObject({
            code: 'AUTH_FAILED',
          });
        });
        const role = unique('aantje_nologin');
        await admin.query(`CREATE ROLE ${role} NOLOGIN PASSWORD 'pw'`);
        try {
          await expect(openPostgres({ ...fixture(), user: role, password: 'pw' })).rejects.toMatchObject({
            code: 'AUTH_FAILED',
          });
        } finally {
          await admin.query(`DROP ROLE ${role}`);
        }
      });

      it('gives up after connectTimeoutMs, and after 10 s by default, when the server accepts the connection but never answers', async () => {
        const sockets = new Set<Socket>();
        const silent = createServer((socket) => sockets.add(socket));
        await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
        const { port } = silent.address() as AddressInfo;
        try {
          const started = Date.now();
          await expect(
            openPostgres({ ...fixture(), host: '127.0.0.1', port, connectTimeoutMs: 300 }),
          ).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
          expect(Date.now() - started).toBeLessThan(3_000);

          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
          try {
            let outcome = 'pending';
            const attempt = openPostgres({ ...fixture(), host: '127.0.0.1', port }).then(
              () => (outcome = 'opened'),
              (error: unknown) => (outcome = (error as { code: string }).code),
            );
            await vi.advanceTimersByTimeAsync(9_900);
            expect(outcome).toBe('pending');
            await vi.advanceTimersByTimeAsync(200);
            await Promise.race([attempt, sleep(2_000)]);
            expect(outcome).toBe('CONNECTION_FAILED');
          } finally {
            vi.useRealTimers();
          }
        } finally {
          sockets.forEach((socket) => socket.destroy());
          await new Promise((resolve) => silent.close(resolve));
        }
      });

      it('never falls back to an unencrypted connection and refuses a certificate that is not trusted', async () => {
        // The fixture server has no TLS.
        await expect(openPostgres({ ...fixture(), ssl: true })).rejects.toMatchObject({
          code: 'CONNECTION_FAILED',
          userMessage: containing('SSL'),
        });

        async function expectRefused(): Promise<void> {
          const server = await selfSignedTlsServer();
          try {
            await expect(
              openPostgres({ ...fixture(), host: '127.0.0.1', port: server.port, ssl: true }),
            ).rejects.toMatchObject({
              code: 'CONNECTION_FAILED',
              userMessage: containing('self-signed certificate'),
            });
          } finally {
            await server.close();
          }
        }
        await expectRefused();
        await withEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0', expectRefused);
      });

      it('identifies itself as application_name aantje, ignores PGSSLMODE and names the table of a failed query', async () => {
        const driver = await open();
        expect(
          await driver.query('SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()'),
        ).toEqual([{ application_name: 'aantje' }]);
        await expect(driver.query('SELECT * FROM no_such_table')).rejects.toMatchObject({
          code: 'QUERY_FAILED',
          userMessage: containing('no_such_table'),
        });
        await withEnv('PGSSLMODE', 'require', async () => {
          // The fixture server has no TLS, so this connection would fail if PGSSLMODE were honoured.
          const plain = await open();
          expect(await plain.query('SELECT 1 AS one')).toEqual([{ one: 1 }]);
        });
      });

      it('never puts a password into an error of a running session', async () => {
        const { password } = fixture();
        const failures: unknown[] = [];
        const collect = (error: unknown): number => failures.push(error);

        const terminated = await open();
        const [session] = await terminated.query('SELECT pg_backend_pid() AS pid');
        const running = terminated.query('SELECT pg_sleep(30)').catch(collect);
        await sleep(100);
        await admin.query('SELECT pg_terminate_backend($1)', [session?.pid]);
        await running;

        await (await open({ statementTimeoutMs: 300 })).query('SELECT pg_sleep(30)').catch(collect);

        const cancelled = await open();
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        await cancelled.query('SELECT pg_sleep(30)', [], { signal: controller.signal }).catch(collect);

        const closed = await open();
        await closed.close();
        await closed.query('SELECT 1').catch(collect);

        expect(failures.map((error) => (error as { code?: string }).code)).toEqual([
          'CONNECTION_FAILED',
          'TIMEOUT',
          'ABORTED',
          'CONNECTION_FAILED',
        ]);
        for (const error of failures) {
          expect(inspect(error, { depth: null, showHidden: true })).not.toContain(password);
        }
      });

      it('never puts a password into an error of a failed connection', async () => {
        const secret = `s3cr3t-${randomBytes(6).toString('hex')}`;
        const port = await closedPort();
        const failures: unknown[] = [];
        const attempt = async (overrides: Partial<PostgresOptions>): Promise<void> => {
          await openPostgres({ ...fixture(), ...overrides }).catch((error: unknown) => failures.push(error));
        };
        await attempt({ password: secret });
        await attempt({ database: 'no_such_database' });
        await attempt({ host: '127.0.0.1', port, password: secret });
        await attempt({ host: 'aantje-test.invalid', password: secret });
        await attempt({ ssl: true });
        await attempt({ metadataSchema: 'not a plain identifier' });
        await (await open()).query('SELEC nothing').catch((error: unknown) => failures.push(error));

        expect(failures).toHaveLength(7);
        for (const error of failures) {
          const text = inspect(error, { depth: null, showHidden: true });
          expect(text).not.toContain(secret);
          expect(text).not.toContain(fixture().password);
        }
      });
    });

    describe('metadata schema', () => {
      const schemas: string[] = [];
      /** A schema with a copy of ducklake_metadata whose version differs, so that reading it is recognisable. */
      async function createMetadataSchema(name: string, version: string): Promise<void> {
        const quoted = `"${name}"`;
        schemas.push(quoted);
        await admin.query(`CREATE SCHEMA ${quoted}`);
        await admin.query(`CREATE TABLE ${quoted}.ducklake_metadata AS TABLE public.ducklake_metadata`);
        await admin.query(`UPDATE ${quoted}.ducklake_metadata SET value = $1 WHERE key = 'version'`, [
          version,
        ]);
      }
      afterAll(async () => {
        for (const schema of schemas) {
          await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        }
      });
      const readVersion = async (driver: Driver): Promise<Row[]> =>
        driver.query("SELECT value FROM ducklake_metadata WHERE key = 'version'");

      it('resolves ducklake_* tables in the given schema only, keeping its case, and treats an empty name like none', async () => {
        const name = unique('lake_copy');
        await createMetadataSchema(name, '9.9');
        expect(await readVersion(await open({ metadataSchema: name }))).toEqual([{ value: '9.9' }]);
        expect(await readVersion(await open())).toEqual([{ value: SPEC_VERSION }]);
        expect(await readVersion(await open({ metadataSchema: '' }))).toEqual([{ value: SPEC_VERSION }]);

        // The case of the name is kept; "$" and letters beyond ASCII are accepted.
        for (const prefix of ['Lake$Copy', 'Schéma_Ü']) {
          const odd = `${prefix}${randomBytes(3).toString('hex')}`;
          await createMetadataSchema(odd, '8.8');
          expect(await readVersion(await open({ metadataSchema: odd })), prefix).toEqual([{ value: '8.8' }]);
        }

        // No fallback to another schema, for tables the given schema lacks or when it does not exist.
        const partial = unique('lake_partial');
        await createMetadataSchema(partial, '9.9');
        await expect(
          (await open({ metadataSchema: partial })).query('SELECT count(*) FROM ducklake_snapshot'),
        ).rejects.toMatchObject({ code: 'QUERY_FAILED' });
        await expect(
          readVersion(await open({ metadataSchema: unique('lake_missing') })),
        ).rejects.toMatchObject({
          code: 'QUERY_FAILED',
        });
      });

      it('rejects a schema name that is not a plain identifier', async () => {
        const before = await fingerprint();
        for (const name of [
          'public; DROP TABLE ducklake_metadata',
          'public -c default_transaction_read_only=off',
          'x", "public',
          "public'; --",
          'two words',
          '1_starts_with_a_digit',
          'back\\slash',
          'new\nline',
        ]) {
          await expect(openPostgres({ ...fixture(), metadataSchema: name }), name).rejects.toMatchObject({
            code: 'INVALID_PROFILE',
          });
        }
        expect(await fingerprint()).toEqual(before);
      });
    });

    describe('connection lifecycle', () => {
      it('releases the server connection on close, also after many open/close cycles', async () => {
        await withRole(async (user, password) => {
          for (let cycle = 0; cycle < 20; cycle++) {
            const driver = await openPostgres({ ...fixture(), user, password });
            await driver.query('SELECT 1');
            await driver.close();
          }
          await eventually(() => sessionsOf(user), 0);
        });
      });

      it('does not keep a socket open after a failed connection attempt', async () => {
        const sockets = (): number =>
          process.getActiveResourcesInfo().filter((r) => r === 'TCPSocketWrap').length;
        const before = sockets();
        for (let attempt = 0; attempt < 5; attempt++) {
          await expect(openPostgres({ ...fixture(), password: undefined })).rejects.toMatchObject({
            code: 'AUTH_FAILED',
          });
          await expect(openPostgres({ ...fixture(), password: 'wrong' })).rejects.toMatchObject({
            code: 'AUTH_FAILED',
          });
        }
        await eventually(sockets, before);
      });

      it('can be closed twice, refuses queries afterwards and cuts off a running statement on close()', async () => {
        const driver = await open();
        await driver.close();
        await driver.close();
        await expect(driver.query('SELECT 1')).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });

        const busy = await open();
        const running = busy.query('SELECT pg_sleep(5)').then(
          () => 'finished',
          (error: unknown) => error,
        );
        await sleep(100);
        const started = Date.now();
        await busy.close();

        expect(await running).toMatchObject({ code: 'CONNECTION_FAILED' });
        expect(Date.now() - started).toBeLessThan(2_000);
      });

      it('reports a connection that the server terminates, while a query runs or while idle, as CONNECTION_FAILED without crashing the process', async () => {
        const driver = await open();
        const [session] = await driver.query('SELECT pg_backend_pid() AS pid');
        const running = driver.query('SELECT pg_sleep(30)');
        await sleep(100);
        await admin.query('SELECT pg_terminate_backend($1)', [session?.pid]);
        await expect(running).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });

        const idle = await open();
        const [idleSession] = await idle.query('SELECT pg_backend_pid() AS pid');
        // The broken connection emits an 'error' event while idle; nobody listening means an uncaught exception.
        const uncaught: unknown[] = [];
        const record = (error: unknown): number => uncaught.push(error);
        process.on('uncaughtException', record);
        try {
          await admin.query('SELECT pg_terminate_backend($1)', [idleSession?.pid]);
          await eventually(async () => {
            const { rows } = await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [
              idleSession?.pid,
            ]);
            return rows.length;
          }, 0);
          await sleep(200);
        } finally {
          process.off('uncaughtException', record);
        }

        expect(uncaught).toEqual([]);
        await expect(idle.query('SELECT 1')).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
      });
    });
  },
);
