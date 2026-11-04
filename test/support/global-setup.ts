import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';
import { QUACK_PREFIX, startQuack, stopQuack } from './quack-fixture';
import type { QuackFixture, QuackFixtures } from './quack-fixture';

/** Connection data of the throw-away Postgres that holds the fixture catalog; null when it is not available. */
export interface PostgresFixture {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    postgres: PostgresFixture | null;
    /** The history fixture (test/fixtures/history) in a second database of the same container. */
    postgresHistory: PostgresFixture | null;
    /** Quack servers of the fixture catalogs, one container each (see quack-fixture.ts). */
    quack: QuackFixture | null;
    quackHistory: QuackFixture | null;
    quackData: QuackFixtures['data'] | null;
    quackTls: QuackFixture | null;
  }
}

const IMAGE = 'postgres:17-alpine';
// Only containers with this prefix are ever touched: many unrelated containers run on the same Docker host.
const NAME_PREFIX = 'aantje-test-pg-';
const STALE_AFTER_MS = 15 * 60_000;
const USER = 'aantje';
const DATABASE = 'ducklake';
const HISTORY_DATABASE = 'history';

const execFileAsync = promisify(execFile);
let container: string | undefined;

/**
 * Starts the fixture databases once per run, PostgreSQL and the Quack servers, but only when `AANTJE_POSTGRES=1`
 * (npm run test:full) and Docker work.
 */
export async function setup(project: TestProject): Promise<void> {
  const none = (): void => {
    for (const key of [
      'postgres',
      'postgresHistory',
      'quack',
      'quackHistory',
      'quackData',
      'quackTls',
    ] as const) {
      project.provide(key, null);
    }
  };
  if (process.env.AANTJE_POSTGRES !== '1') {
    none();
    return;
  }
  try {
    await docker(['version', '--format', '{{.Server.Version}}']);
  } catch {
    console.warn(
      'AANTJE_POSTGRES=1 is set, but Docker is not available: the Postgres and Quack tests are skipped.',
    );
    none();
    return;
  }
  await removeStaleContainers(NAME_PREFIX);
  await removeStaleContainers(QUACK_PREFIX);
  const [postgres, quack] = await Promise.allSettled([startPostgres(), startQuack(docker)]);
  if (postgres.status === 'rejected' || quack.status === 'rejected') {
    await teardown();
    throw postgres.status === 'rejected' ? postgres.reason : (quack as PromiseRejectedResult).reason;
  }
  project.provide('postgres', postgres.value.catalog);
  project.provide('postgresHistory', postgres.value.history);
  project.provide('quack', quack.value.catalog);
  project.provide('quackHistory', quack.value.history);
  project.provide('quackData', quack.value.data);
  project.provide('quackTls', quack.value.tls);
}

export async function teardown(): Promise<void> {
  if (container) {
    await docker(['rm', '-f', container]);
    container = undefined;
  }
  await stopQuack(docker);
}

async function startPostgres(): Promise<{ catalog: PostgresFixture; history: PostgresFixture }> {
  const name = `${NAME_PREFIX}${randomBytes(4).toString('hex')}`;
  const password = randomBytes(16).toString('hex');
  container = name;
  try {
    // The password is passed by name, so that it does not show up in the process list.
    await docker(
      [
        ...['run', '-d', '--name', name, '-p', '127.0.0.1::5432'],
        // The image declares its data directory as a volume; in memory nothing is left behind after `docker rm`.
        ...['--tmpfs', '/var/lib/postgresql/data'],
        ...['-e', 'POSTGRES_PASSWORD', '-e', `POSTGRES_USER=${USER}`, '-e', `POSTGRES_DB=${DATABASE}`],
        IMAGE,
      ],
      { POSTGRES_PASSWORD: password },
    );
    const mapping = (await docker(['port', name, '5432/tcp'])).split(/\r?\n/)[0] ?? '';
    const fixture = {
      host: '127.0.0.1',
      port: Number(mapping.slice(mapping.lastIndexOf(':') + 1)),
      database: DATABASE,
      user: USER,
      password,
    };
    const client = await connectWhenReady(fixture);
    try {
      await client.query(await readFile(new URL('../fixtures/postgres.sql', import.meta.url), 'utf8'));
      await client.query(`CREATE DATABASE ${HISTORY_DATABASE}`);
    } finally {
      await client.end();
    }
    const history = { ...fixture, database: HISTORY_DATABASE };
    const historyClient = await connectWhenReady(history);
    try {
      const dump = new URL('../fixtures/history/history.postgres.sql', import.meta.url);
      await historyClient.query(await readFile(dump, 'utf8'));
    } finally {
      await historyClient.end();
    }
    return { catalog: fixture, history };
  } catch (error) {
    await docker(['rm', '-f', name]).catch(() => undefined);
    container = undefined;
    throw error;
  }
}

/** The image first runs a temporary server that only listens on a socket, so the first attempts fail. */
async function connectWhenReady(fixture: PostgresFixture): Promise<Client> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const client = new Client({ ...fixture, connectionTimeoutMillis: 2_000 });
    client.on('error', () => undefined);
    try {
      await client.connect();
      return client;
    } catch (error) {
      void client.end();
      if (Date.now() > deadline) {
        throw new Error('The Postgres container did not become ready in time.', { cause: error });
      }
      await sleep(250);
    }
  }
}

/** A run that was killed cannot clean up after itself; the next run removes what it left behind. */
async function removeStaleContainers(prefix: string): Promise<void> {
  const names = (await docker(['ps', '-a', '--filter', `name=${prefix}`, '--format', '{{.Names}}']))
    .split(/\r?\n/)
    .filter((name) => name.startsWith(prefix));
  for (const name of names) {
    const created = await docker(['inspect', '--format', '{{.Created}}', name]).catch(() => undefined);
    if (created !== undefined && Date.now() - Date.parse(created) > STALE_AFTER_MS) {
      await docker(['rm', '-f', name]).catch(() => undefined);
    }
  }
}

async function docker(args: string[], env?: NodeJS.ProcessEnv, cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, {
    env: { ...process.env, ...env },
    cwd,
    // An image build prints a lot.
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim();
}
