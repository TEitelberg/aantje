import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupStatements } from '../../src/data/attach';
import { describeRelation, previewTable } from '../../src/data/engine';
import { AantjeError } from '../../src/errors';
import { accessFor, copyDataFixture, createLake, engineSkipReason, extensionDirectory } from './data-support';
import type { DataFixture, Lake } from './data-support';
import type { FileProfile } from '../../src/connections/profile';
import type { DataAccess } from '../../src/data/types';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Data engine tests are skipped: ${skipReason}`);
}

const orders = { schema: 'sales', table: 'orders' };

const ORDERS_COLUMNS = [
  { name: 'id', type: 'INTEGER', kind: 'number' },
  { name: 'customer', type: 'STRUCT("name" VARCHAR, "tags" VARCHAR[])', kind: 'nested' },
  { name: 'attrs', type: 'MAP(VARCHAR, INTEGER)', kind: 'nested' },
  { name: 'amount', type: 'DECIMAL(10,2)', kind: 'number' },
  { name: 'created', type: 'TIMESTAMP', kind: 'text' },
];
const ORDERS_RELATION_COLUMNS = [
  { name: 'id', type: 'INTEGER', nullable: false },
  { name: 'customer', type: 'STRUCT("name" VARCHAR, "tags" VARCHAR[])', nullable: true },
  { name: 'attrs', type: 'MAP(VARCHAR, INTEGER)', nullable: true },
  { name: 'amount', type: 'DECIMAL(10,2)', nullable: true },
  { name: 'created', type: 'TIMESTAMP', nullable: true },
];
const ORDER_1 = [1, '{"name":"a","tags":["x"]}', '[{"key":"k","value":1}]', '1.50', '2026-01-01 00:00:00'];
const ORDER_2 = [2, '{"name":"b","tags":[]}', '[]', '2.50', '2026-01-02 00:00:00'];
const ORDER_3 = [3, null, null, '3.00', '2026-01-03 00:00:00'];

async function failure(promise: Promise<unknown>): Promise<AantjeError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AantjeError);
  return error as AantjeError;
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Counts what the engine does to the real DuckDB classes, to prove that nothing is left open or running. */
function watchEngine(): {
  counts: () => Record<'instances' | 'instanceCloses' | 'connections' | 'connectionCloses', number>;
  interrupts: () => number;
  closed: (timeoutMs?: number) => Promise<void>;
} {
  const instances = vi.spyOn(DuckDBInstance, 'create');
  const instanceCloses = vi.spyOn(DuckDBInstance.prototype, 'closeSync');
  const connections = vi.spyOn(DuckDBInstance.prototype, 'connect');
  const connectionCloses = vi.spyOn(DuckDBConnection.prototype, 'closeSync');
  const interrupts = vi.spyOn(DuckDBConnection.prototype, 'interrupt');
  const counts = () => ({
    instances: instances.mock.calls.length,
    instanceCloses: instanceCloses.mock.calls.length,
    connections: connections.mock.calls.length,
    connectionCloses: connectionCloses.mock.calls.length,
  });
  return {
    counts,
    interrupts: () => interrupts.mock.calls.length,
    closed: (timeout = 15_000) =>
      vi.waitFor(
        () =>
          expect(counts()).toEqual({ instances: 1, instanceCloses: 1, connections: 1, connectionCloses: 1 }),
        {
          timeout,
          interval: 50,
        },
      ),
  };
}

/** Runs `use` on a temporary DuckLake that is removed afterwards. */
async function withLake<T>(
  statements: string[],
  use: (lake: Lake) => Promise<T>,
  inlining = false,
): Promise<T> {
  const lake = await createLake(statements, inlining);
  try {
    return await use(lake);
  } finally {
    await lake.remove();
  }
}

describe.skipIf(skipReason)('previewTable on the data fixtures', () => {
  const fixtures = new Map<'sqlite' | 'duckdb', DataFixture>();

  beforeAll(async () => {
    for (const kind of ['sqlite', 'duckdb'] as const) {
      fixtures.set(kind, await copyDataFixture(kind));
    }
  });
  afterAll(async () => {
    await Promise.all([...fixtures.values()].map((fixture) => fixture.remove()));
  });

  describe.each(['sqlite', 'duckdb'] as const)('%s metadata', (kind) => {
    const fixture = (): DataFixture => fixtures.get(kind) as DataFixture;

    it('shows sales.orders and the view at the latest snapshot and at earlier ones, with exact rows and columns', async () => {
      const data = await previewTable(accessFor(fixture()), orders);
      expect(data).toEqual({
        table: orders,
        columns: ORDERS_COLUMNS,
        rows: [ORDER_1, ORDER_3],
        limit: 1000,
        truncated: false,
        elapsedMs: expect.any(Number) as number,
      });
      expect(Number.isInteger(data.elapsedMs) && data.elapsedMs >= 0).toBe(true);

      // Time travel: snapshot 5 still has the 3 rows, snapshot 6 (the delete) has 2, snapshot 3 has none.
      expect((await previewTable(accessFor(fixture(), { snapshot: 5 }), orders)).rows).toEqual([
        ORDER_1,
        ORDER_2,
        ORDER_3,
      ]);
      expect((await previewTable(accessFor(fixture(), { snapshot: 6 }), orders)).rows).toEqual([
        ORDER_1,
        ORDER_3,
      ]);
      const empty = await previewTable(accessFor(fixture(), { snapshot: 3 }), orders);
      expect(empty.columns).toEqual(ORDERS_COLUMNS);
      expect(empty.rows).toEqual([]);

      // A snapshot in which the table does not exist yet, and one that does not exist at all.
      const early = await failure(previewTable(accessFor(fixture(), { snapshot: 1 }), orders));
      expect(early.code).toBe('QUERY_FAILED');
      expect(early.userMessage).toContain('"sales.orders"');
      const missing = await failure(previewTable(accessFor(fixture(), { snapshot: 999 }), orders));
      expect(missing.code).toBe('CONNECTION_FAILED');
      expect(missing.userMessage).toContain('999');

      // The view has the names, types and nullability of the table, and does not exist before it was created.
      const view = { schema: 'sales', table: 'big_orders' };
      expect(await describeRelation(accessFor(fixture()), view)).toEqual(ORDERS_RELATION_COLUMNS);
      expect(await describeRelation(accessFor(fixture()), orders)).toEqual(ORDERS_RELATION_COLUMNS);
      const before = await failure(describeRelation(accessFor(fixture(), { snapshot: 6 }), view));
      expect(before.code).toBe('QUERY_FAILED');
      expect(before.userMessage).toContain('"sales.big_orders"');
    });

    it('cannot write: the attached lake and the configuration are locked', async () => {
      const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
      const connection = await instance.connect();
      try {
        for (const sql of setupStatements(accessFor(fixture()))) {
          await connection.run(sql);
        }
        const attempts = [
          "INSERT INTO lake.sales.orders VALUES (9, NULL, NULL, 9.00, TIMESTAMP '2026-02-01 00:00:00')",
          'DELETE FROM lake.sales.orders',
          'DROP TABLE lake.sales.orders',
          'CREATE TABLE lake.main.intruder (x INTEGER)',
          'SET enable_external_access = false',
        ];
        for (const sql of attempts) {
          await expect(connection.run(sql), sql).rejects.toThrow(/read-only mode|has been locked/);
        }
      } finally {
        connection.closeSync();
        instance.closeSync();
      }

      expect((await previewTable(accessFor(fixture()), orders)).rows).toEqual([ORDER_1, ORDER_3]);
    });
  });

  it('reads odd names, maps DuckDB types to the grid kinds and values, and shows UNION and inlined rows', async () => {
    const plain = { s3: {}, extensionDirectory };
    await withLake(
      [
        'CREATE SCHEMA "we""ird"',
        `CREATE TABLE "we""ird"."a b""; DROP TABLE x; --" ("it's" VARCHAR)`,
        'INSERT INTO "we""ird"."a b""; DROP TABLE x; --" VALUES (\'ok\')',
      ],
      async (lake) => {
        const data = await previewTable(
          { profile: lake.profile, ...plain },
          { schema: 'we"ird', table: 'a b"; DROP TABLE x; --' },
        );
        expect(data.columns).toEqual([{ name: "it's", type: 'VARCHAR', kind: 'text' }]);
        expect(data.rows).toEqual([['ok']]);
      },
    );

    await withLake(
      [
        'CREATE TABLE types (a BIGINT, b UBIGINT, c DOUBLE, d DATE, e BOOLEAN, f VARCHAR, g VARCHAR[], h TINYINT, i STRUCT(x INTEGER, y STRUCT(z VARCHAR[])), j TIME, k SMALLINT, l HUGEINT, m FLOAT, o DECIMAL(18,3)[], p INTERVAL)',
        "INSERT INTO types VALUES (9007199254740993, 18446744073709551615, 1.5, DATE '2026-01-02', true, 'Zoë \"q\" ''s''', ['a', 'b'], -5, {'x': 1, 'y': {'z': ['p']}}, TIME '01:02:03', 7, 18446744073709551616, 1.5, [1.25], INTERVAL 3 DAY)",
        "INSERT INTO types VALUES (NULL, NULL, NULL, NULL, false, '', [], NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
      ],
      async (lake) => {
        const data = await previewTable(
          { profile: lake.profile, ...plain },
          { schema: 'main', table: 'types' },
        );
        expect(data.columns.map(({ type, kind }) => `${type}:${kind}`)).toEqual([
          'BIGINT:number',
          'UBIGINT:number',
          'DOUBLE:number',
          'DATE:text',
          'BOOLEAN:boolean',
          'VARCHAR:text',
          'VARCHAR[]:nested',
          'TINYINT:number',
          'STRUCT("x" INTEGER, "y" STRUCT("z" VARCHAR[])):nested',
          'TIME:text',
          'SMALLINT:number',
          'HUGEINT:number',
          'FLOAT:number',
          'DECIMAL(18,3)[]:nested',
          'INTERVAL:nested',
        ]);
        // Big integers stay exact because they arrive as text; nested values are compact JSON.
        expect(data.rows).toEqual([
          [
            '9007199254740993',
            '18446744073709551615',
            1.5,
            '2026-01-02',
            true,
            'Zoë "q" \'s\'',
            '["a","b"]',
            -5,
            '{"x":1,"y":{"z":["p"]}}',
            '01:02:03',
            7,
            '18446744073709551616',
            1.5,
            '["1.250"]',
            '{"months":0,"days":3,"micros":"0"}',
          ],
          [null, null, null, null, false, '', '[]', null, null, null, null, null, null, null, null],
        ]);
      },
    );

    // DuckLake stores no UNION column, so only a view can return one.
    await withLake(['CREATE VIEW u AS SELECT union_value(num := 5) AS n'], async (lake) => {
      const data = await previewTable(
        { profile: lake.profile, ...plain, viewsTrusted: true },
        { schema: 'main', table: 'u' },
      );
      expect(data.columns).toEqual([{ name: 'n', type: 'UNION("num" INTEGER)', kind: 'nested' }]);
      expect(data.rows).toEqual([['{"tag":"num","value":5}']]);
    });

    // Rows that DuckLake keeps inlined in the catalog instead of in a Parquet file.
    await withLake(
      ['CREATE TABLE small (n INTEGER)', 'INSERT INTO small VALUES (1), (2), (3)'],
      async (lake) => {
        const data = await previewTable(
          { profile: lake.profile, ...plain },
          { schema: 'main', table: 'small' },
        );
        expect(data.rows).toEqual([[1], [2], [3]]);
      },
      true,
    );
  });

  describe('describeRelation on views created in a temporary DuckLake', () => {
    const access = (lake: { profile: FileProfile }, extra: Partial<DataAccess> = {}): DataAccess => ({
      profile: lake.profile,
      s3: {},
      extensionDirectory,
      // These tests resolve view columns of a trusted connection; the trust gate has its own tests.
      viewsTrusted: true,
      ...extra,
    });

    it('writes the type of a view column like the grid header and resolves views of views, aliases and expressions', async () => {
      await withLake(
        [
          'CREATE TABLE base (id INTEGER NOT NULL, c STRUCT("name" VARCHAR, tags VARCHAR[], "my field" INTEGER), m MAP(VARCHAR, INTEGER), d DECIMAL(10,2), l STRUCT(a INTEGER)[])',
          'CREATE VIEW v AS SELECT * FROM base',
          'CREATE TABLE base2 (a INTEGER NOT NULL, b VARCHAR)',
          'CREATE VIEW inner_view AS SELECT a, b FROM base2',
          'CREATE VIEW outer_view (x, y, z) AS SELECT a + 1, upper(b), [a] FROM inner_view',
        ],
        async (lake) => {
          const view = { schema: 'main', table: 'v' };
          const columns = await describeRelation(access(lake), view);
          expect(columns).toEqual([
            { name: 'id', type: 'INTEGER', nullable: false },
            {
              name: 'c',
              type: 'STRUCT("name" VARCHAR, "tags" VARCHAR[], "my field" INTEGER)',
              nullable: true,
            },
            { name: 'm', type: 'MAP(VARCHAR, INTEGER)', nullable: true },
            { name: 'd', type: 'DECIMAL(10,2)', nullable: true },
            { name: 'l', type: 'STRUCT("a" INTEGER)[]', nullable: true },
          ]);
          const grid = await previewTable(access(lake), view);
          expect(columns.map(({ type }) => type)).toEqual(grid.columns.map(({ type }) => type));

          expect(await describeRelation(access(lake), { schema: 'main', table: 'outer_view' })).toEqual([
            { name: 'x', type: 'INTEGER', nullable: true },
            { name: 'y', type: 'VARCHAR', nullable: true },
            { name: 'z', type: 'INTEGER[]', nullable: true },
          ]);
        },
      );
    });

    it('names the cause when a view cannot be bound and scrubs a secret that the engine quotes, honouring the time limit and the abort signal', async () => {
      await withLake(
        ['CREATE TABLE base (a INTEGER)', 'CREATE VIEW fine AS SELECT a FROM base'],
        async (lake) => {
          const fine = { schema: 'main', table: 'fine' };
          const timedOut = await failure(describeRelation(access(lake, { timeoutMs: 1 }), fine));
          const aborted = await failure(describeRelation(access(lake), fine, AbortSignal.abort()));
          expect(timedOut.code).toBe('TIMEOUT');
          expect(aborted.code).toBe('ABORTED');
          expect(await describeRelation(access(lake, { timeoutMs: 60_000 }), fine)).toEqual([
            { name: 'a', type: 'INTEGER', nullable: true },
          ]);
        },
      );
      await withLake(
        ['CREATE TABLE base (a INTEGER)', 'CREATE VIEW broken AS SELECT a FROM base', 'DROP TABLE base'],
        async (lake) => {
          const view = { schema: 'main', table: 'broken' };
          const error = await failure(describeRelation(access(lake), view));
          expect(error.code).toBe('QUERY_FAILED');
          expect(error.userMessage).toContain('"main.broken"');
          expect(error.userMessage).toMatch(/Table with name base does not exist/);

          const scrubbed = await failure(
            describeRelation(
              access(lake, { s3Credentials: { keyId: 'base', secretKey: 'does not exist' } }),
              view,
            ),
          );
          expect(scrubbed.userMessage).not.toContain('base');
          expect(scrubbed.userMessage).toContain('***');
        },
      );
    });

    it('binds the SQL of the view, which is why the user has to trust the connection first: a view over a local file shows its header', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'aantje-csv-'));
      const csv = join(directory, 'secret.csv').replaceAll('\\', '/');
      await writeFile(csv, 'first_secret_column,second_secret_column\n1,2\n');
      try {
        await withLake([`CREATE VIEW peek AS SELECT * FROM read_csv('${csv}')`], async (lake) => {
          const columns = await describeRelation(access(lake), { schema: 'main', table: 'peek' });
          expect(columns.map(({ name }) => name)).toEqual(['first_secret_column', 'second_secret_column']);
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });

  it('cuts a table at 1000 rows and says so, but not at exactly 1000', async () => {
    const rowsOf = (count: number): Promise<{ rows: number; truncated: boolean }> =>
      withLake(
        ['CREATE TABLE big (n INTEGER)', `INSERT INTO big SELECT range FROM range(${count})`],
        async (lake) => {
          const data = await previewTable(
            { profile: lake.profile, s3: {}, extensionDirectory },
            { schema: 'main', table: 'big' },
          );
          return { rows: data.rows.length, truncated: data.truncated };
        },
      );

    expect(await rowsOf(1500)).toEqual({ rows: 1000, truncated: true });
    expect(await rowsOf(1000)).toEqual({ rows: 1000, truncated: false });
    expect(await rowsOf(1001)).toEqual({ rows: 1000, truncated: true });
  });

  describe('cancellation', () => {
    const sqlite = (extra: Partial<DataAccess> = {}): DataAccess =>
      accessFor(fixtures.get('sqlite') as DataFixture, extra);

    it('rejects with TIMEOUT when the time limit is exceeded and stays prompt, and with ABORTED, never TIMEOUT, for a user abort', async () => {
      const started = performance.now();
      const timeout = await failure(previewTable(sqlite({ timeoutMs: 1 }), orders));
      expect(timeout.code).toBe('TIMEOUT');
      expect(timeout.userMessage).toContain('0.001 s');
      expect(performance.now() - started).toBeLessThan(5000);

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 1);
      const during = await failure(previewTable(sqlite({ timeoutMs: 60_000 }), orders, controller.signal));
      expect(during.code).toBe('ABORTED');

      // An aborted signal opens nothing.
      vi.restoreAllMocks();
      const watch = watchEngine();
      const before = await failure(previewTable(sqlite({ timeoutMs: 60_000 }), orders, AbortSignal.abort()));
      expect(before.code).toBe('ABORTED');
      expect(before.userMessage).toContain('sales.orders');
      expect(watch.counts()).toEqual({
        instances: 0,
        instanceCloses: 0,
        connections: 0,
        connectionCloses: 0,
      });
    });

    it('succeeds with a generous limit, also one beyond what a timer can hold', async () => {
      expect((await previewTable(sqlite({ timeoutMs: 60_000 }), orders)).rows).toHaveLength(2);
      expect((await previewTable(sqlite({ timeoutMs: 5_000_000_000 }), orders)).rows).toHaveLength(2);
    });
  });

  // This test comes first: the blocked reads of the two blocks below are given up and close their engine later, which would count as closes here.
  it('closes the instance and the connection after a read, a failed query, a failed setup and a failed connect, and opens nothing for an aborted signal', async () => {
    const fixture = fixtures.get('sqlite') as DataFixture;
    const once = { instances: 1, instanceCloses: 1, connections: 1, connectionCloses: 1 };
    const scenario = async (run: () => Promise<unknown>, expected = once): Promise<void> => {
      vi.restoreAllMocks();
      const watch = watchEngine();
      await run().catch(() => undefined);
      expect(watch.counts()).toEqual(expected);
    };

    await scenario(() => previewTable(accessFor(fixture), orders));
    await scenario(() => previewTable(accessFor(fixture, { snapshot: 1 }), orders));
    await scenario(() =>
      previewTable(
        {
          ...accessFor(fixture),
          profile: { ...fixture.profile, path: join(fixture.directory, 'nope.sqlite') },
        },
        orders,
      ),
    );
    await scenario(
      () => {
        vi.spyOn(DuckDBInstance.prototype, 'connect').mockRejectedValueOnce(new Error('no connection'));
        return previewTable(accessFor(fixture), orders);
      },
      { instances: 1, instanceCloses: 1, connections: 1, connectionCloses: 0 },
    );
  });

  describe('the time limits of the setup and of the query', () => {
    const SLOW = { schema: 'main', table: 'slow' };
    let lake: Lake;
    beforeAll(async () => {
      lake = await createLake(['CREATE VIEW slow AS SELECT count(*) AS n FROM range(100000000000)']);
    });
    afterAll(async () => {
      await lake.remove();
    });

    /** Makes every statement that starts with `prefix` take `ms` longer, whatever the network. */
    function slowStatement(prefix: string, ms: number): void {
      const run = Object.getOwnPropertyDescriptor(DuckDBConnection.prototype, 'run')
        ?.value as DuckDBConnection['run'];
      vi.spyOn(DuckDBConnection.prototype, 'run').mockImplementation(async function (
        this: DuckDBConnection,
        sql,
        ...rest
      ) {
        if (sql.startsWith(prefix)) {
          await new Promise((resolve) => setTimeout(resolve, ms));
        }
        return run.call(this, sql, ...rest);
      });
    }
    /** The installation of an extension takes `ms`, as a slow first download does. */
    const slowInstall = (ms: number): void => slowStatement('INSTALL ', ms);
    const sqlite = (extra: Partial<DataAccess> = {}): DataAccess =>
      accessFor(fixtures.get('sqlite') as DataFixture, extra);

    it('does not count the installation of the extensions against queryTimeoutSeconds, and starts the limit of the query when they are loaded', async () => {
      slowInstall(2500);
      expect((await previewTable(sqlite({ timeoutMs: 1500 }), orders)).rows).toHaveLength(2);

      vi.restoreAllMocks();
      slowInstall(1500);
      const started = performance.now();
      const error = await failure(
        previewTable(
          { profile: lake.profile, s3: {}, extensionDirectory, timeoutMs: 1500, viewsTrusted: true },
          SLOW,
        ),
      );
      expect(error.code).toBe('TIMEOUT');
      expect(error.userMessage).toContain('main.slow');
      // The installation (1.5 s) and the limit of the query (1.5 s) add up.
      expect(performance.now() - started).toBeGreaterThan(2900);
    }, 60_000);

    it('gives the installation a limit of its own, lets the user cancel during it and still closes the engine', async () => {
      slowInstall(2500);
      const watch = watchEngine();
      const started = performance.now();
      const error = await failure(
        previewTable(sqlite({ timeoutMs: 60_000, extensionTimeoutMs: 300 }), orders),
      );
      expect(error.code).toBe('TIMEOUT');
      expect(error.userMessage).toContain('aantje.duckdb.extensionDirectory');
      expect(performance.now() - started).toBeLessThan(2000);
      await watch.closed();

      vi.restoreAllMocks();
      slowInstall(2500);
      const second = watchEngine();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const cancelStarted = performance.now();
      const aborted = await failure(previewTable(sqlite(), orders, controller.signal));
      expect(aborted.code).toBe('ABORTED');
      expect(performance.now() - cancelStarted).toBeLessThan(2000);
      await second.closed();
    }, 60_000);

    it('stops the clock of the installation when the setup starts, and limits the installation to five minutes by default', async () => {
      // Without a limit for the query nothing may end the call: the clock of the installation must not run on.
      slowStatement('ATTACH ', 3500);
      const data = await previewTable(sqlite({ extensionTimeoutMs: 1500 }), orders);
      expect(data.rows).toHaveLength(2);

      vi.restoreAllMocks();
      const timers = vi.spyOn(globalThis, 'setTimeout');
      await previewTable(sqlite(), orders);
      expect(timers.mock.calls.map(([, delay]) => delay)).toContain(300_000);
    }, 60_000);

    it('describes a view without running it and reports how long the statement took', async () => {
      const started = performance.now();
      const columns = await describeRelation(
        { profile: lake.profile, s3: {}, extensionDirectory, timeoutMs: 20_000, viewsTrusted: true },
        SLOW,
      );
      expect(columns.map(({ name }) => name)).toEqual(['n']);
      expect(performance.now() - started).toBeLessThan(10_000);

      const readAll = Object.getOwnPropertyDescriptor(DuckDBConnection.prototype, 'runAndReadAll')
        ?.value as DuckDBConnection['runAndReadAll'];
      vi.spyOn(DuckDBConnection.prototype, 'runAndReadAll').mockImplementation(async function (
        this: DuckDBConnection,
        sql,
        ...rest
      ) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return readAll.call(this, sql, ...rest);
      });
      expect((await previewTable(sqlite(), orders)).elapsedMs).toBeGreaterThanOrEqual(100);
    }, 60_000);
  });

  describe('a statement that is already running, and a network that never answers', () => {
    const SLOW = { schema: 'main', table: 'slow' };
    let lake: Lake;
    let server: Server;
    const sockets = new Set<Socket>();
    beforeAll(async () => {
      lake = await createLake(['CREATE VIEW slow AS SELECT count(*) AS n FROM range(100000000000)']);
      server = createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => undefined);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    });
    afterAll(async () => {
      await lake.remove();
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    });
    const slowAccess = (extra: Partial<DataAccess> = {}): DataAccess => ({
      profile: lake.profile,
      s3: {},
      extensionDirectory,
      viewsTrusted: true,
      ...extra,
    });

    it('interrupts a running statement at the time limit or when the signal fires and closes the engine', async () => {
      const watch = watchEngine();
      const started = performance.now();
      const error = await failure(previewTable(slowAccess({ timeoutMs: 1500 }), SLOW));
      expect(error.code).toBe('TIMEOUT');
      expect(performance.now() - started).toBeLessThan(8000);
      // The interrupt is repeated until the engine gives up the statement: that is quick, not a matter of seconds.
      const rejected = performance.now();
      await watch.closed();
      expect(performance.now() - rejected).toBeLessThan(2500);
      const interrupts = watch.interrupts();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(watch.interrupts()).toBe(interrupts);

      vi.restoreAllMocks();
      const second = watchEngine();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 1500);
      const abortStarted = performance.now();
      const aborted = await failure(previewTable(slowAccess(), SLOW, controller.signal));
      expect(aborted.code).toBe('ABORTED');
      expect(performance.now() - abortStarted).toBeLessThan(8000);
      await second.closed();
    }, 60_000);

    it('still ends with TIMEOUT at the time limit although a blocked network read cannot be interrupted', async () => {
      const copy = await copyDataFixture('duckdb', 's3://aantje-test/');
      try {
        const port = (server.address() as { port: number }).port;
        const started = performance.now();
        const error = await failure(
          previewTable(
            accessFor(copy, {
              s3: { endpoint: `http://127.0.0.1:${port}`, urlStyle: 'path' },
              timeoutMs: 1500,
            }),
            orders,
          ),
        );

        expect(error.code).toBe('TIMEOUT');
        expect(performance.now() - started).toBeLessThan(8000);
      } finally {
        await copy.remove();
      }
    }, 30_000);
  });

  describe('failures', () => {
    it('reports a missing Parquet file of a local lake as missing from this machine, with no advice for S3, and scrubs the S3 secret', async () => {
      const copy = await copyDataFixture('sqlite');
      try {
        const files = join(copy.directory, 'sqlite-files', 'sales', 'orders');
        for (const name of await readdir(files)) {
          await rm(join(files, name));
        }
        const error = await failure(previewTable(accessFor(copy), orders));
        expect(error.code).toBe('QUERY_FAILED');
        expect(error.userMessage).toContain('"sales.orders"');
        expect(error.userMessage).toMatch(/\.parquet/);
        expect(error.userMessage).not.toMatch(/S3/);

        // The missing-file message quotes the path of the file; a key id that is part of that path is the
        // simplest way to make a real engine error contain a secret.
        const keyId = basename(copy.directory);
        expect(error.userMessage).toContain(keyId);
        const scrubbed = await failure(
          previewTable(accessFor(copy, { s3Credentials: { keyId, secretKey: 'sales' } }), orders),
        );
        for (const text of [scrubbed.userMessage, (scrubbed.cause as Error).message]) {
          expect(text).not.toContain(keyId);
          expect(text).toContain('***');
        }
      } finally {
        await copy.remove();
      }
    });

    it('reports a missing catalog file, a rejected secret and unusable extension directory with the right code and setting', async () => {
      const fixture = fixtures.get('sqlite') as DataFixture;
      const missing = await failure(
        previewTable(
          {
            ...accessFor(fixture),
            profile: { ...fixture.profile, path: join(fixture.directory, 'nope.sqlite') },
          },
          orders,
        ),
      );
      expect(missing.code).toBe('CONNECTION_FAILED');
      expect(missing.userMessage).toContain('nope.sqlite');

      // A secret that DuckDB rejects is a failed setup, not a missing extension.
      const secret = await failure(
        previewTable(
          accessFor(fixture, { s3: { endpoint: 'http://127.0.0.1:1', urlStyle: 'bogus' as 'path' } }),
          orders,
        ),
      );
      expect(secret.code).toBe('CONNECTION_FAILED');
      expect(secret.userMessage).toContain("URL style 'bogus'");
      expect(secret.userMessage).not.toContain('extension');

      const directory = await mkdtemp(join(tmpdir(), 'aantje-ext-'));
      try {
        // A file where the extension directory should be: DuckDB cannot install into it, with or without network.
        const blocker = join(directory, 'not-a-directory');
        await writeFile(blocker, '');
        const error = await failure(
          previewTable(accessFor(fixture, { extensionDirectory: blocker }), orders),
        );
        expect(error.code).toBe('CONNECTION_FAILED');
        expect(error.userMessage).toContain('aantje.duckdb.extensionDirectory');
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});

describe('previewTable where the native engine is missing', () => {
  it('reports CONNECTION_FAILED with the platform instead of crashing', async () => {
    vi.resetModules();
    vi.doMock('@duckdb/node-api', () => {
      throw new Error('no native binding');
    });
    try {
      const { previewTable: preview } = await import('../../src/data/engine');
      const error = await preview(
        { profile: { id: 'a', name: 'a', kind: 'sqlite', path: 'x' }, s3: {} },
        orders,
      ).then(
        () => undefined,
        (e: unknown) => e as { code?: string; userMessage?: string },
      );

      expect(error?.code).toBe('CONNECTION_FAILED');
      expect(error?.userMessage).toContain(`${process.platform}-${process.arch}`);
    } finally {
      vi.doUnmock('@duckdb/node-api');
      vi.resetModules();
    }
  });
});
