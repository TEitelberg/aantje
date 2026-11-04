import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/** A Quack server on 127.0.0.1 of this machine that serves a copy of a fixture catalog. */
export interface QuackFixture {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

export interface QuackFixtures {
  /** test/fixtures/ducklake.duckdb over plain HTTP. */
  readonly catalog: QuackFixture;
  /** test/fixtures/history/history.duckdb over plain HTTP. */
  readonly history: QuackFixture;
  /** test/fixtures/data/data-catalog.duckdb over plain HTTP; its data path is `directory`, a copy of the Parquet files. */
  readonly data: QuackFixture & { readonly directory: string };
  /** The catalog fixture behind the stock serve.py of the image: TLS with the certificate the server makes itself. */
  readonly tls: QuackFixture;
}

type Docker = (args: string[], env?: NodeJS.ProcessEnv, cwd?: string) => Promise<string>;

const IMAGE = 'aantje-test-quack:local';
/** Only containers with this prefix are ever touched. */
export const QUACK_PREFIX = 'aantje-test-quack-';
const fixture = (path: string): string => fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url));
const SERVE_SCRIPT = fileURLToPath(new URL('./quack-serve.py', import.meta.url));
const STACK = fileURLToPath(new URL('../../docker/', import.meta.url));

const containers: string[] = [];
let dataDirectory: string | undefined;

/**
 * Starts one container per fixture from the image of docker/images/quack, built once as `aantje-test-quack:local`
 * (delete the image to build it again). A catalog is copied in with `docker cp` before the start, so nothing of the
 * checkout is mounted, and the server copies it to its own volume, where it may write.
 */
export async function startQuack(docker: Docker): Promise<QuackFixtures> {
  if (!(await docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE]).then(Boolean, () => false))) {
    await docker(['build', '-f', 'images/quack/Dockerfile', '-t', IMAGE, '.'], undefined, STACK);
  }
  const token = randomBytes(16).toString('hex');
  dataDirectory = await mkdtemp(join(tmpdir(), 'aantje-quack-data-'));
  const files = join(dataDirectory, 'duckdb-files');
  await cp(fixture('data/duckdb-files'), files, { recursive: true });
  const [catalog, history, data, tls] = await Promise.all([
    serve(docker, fixture('ducklake.duckdb'), token),
    serve(docker, fixture('history/history.duckdb'), token),
    serve(docker, fixture('data/data-catalog.duckdb'), token, `${files.replaceAll('\\', '/')}/`),
    serve(docker, fixture('ducklake.duckdb'), token, undefined, true),
  ]);
  return { catalog, history, data: { ...data, directory: dataDirectory }, tls };
}

/** Removes the containers of this run by name and the copied data files. */
export async function stopQuack(docker: Docker): Promise<void> {
  await Promise.all(containers.splice(0).map((name) => docker(['rm', '-f', name]).catch(() => undefined)));
  if (dataDirectory) {
    await rm(dataDirectory, { recursive: true, force: true });
    dataDirectory = undefined;
  }
}

async function serve(
  docker: Docker,
  catalog: string,
  token: string,
  dataPath?: string,
  tls = false,
): Promise<QuackFixture> {
  const name = `${QUACK_PREFIX}${randomBytes(4).toString('hex')}`;
  containers.push(name);
  // The token is passed by name, so that it does not show up in the process list.
  const variable = tls ? 'OOG_QUACK_TOKEN' : 'AANTJE_QUACK_TOKEN';
  const server = tls ? '/usr/local/bin/oog-quack' : '/tmp/quack-serve.py';
  await docker(
    [
      ...['create', '--name', name, '-p', '127.0.0.1::9494', '-e', variable],
      ...(dataPath ? ['-e', `AANTJE_DATA_PATH=${dataPath}`] : []),
      ...[
        '--entrypoint',
        'sh',
        IMAGE,
        '-c',
        `cp /tmp/fixture.duckdb /data/catalog.duckdb && exec python ${server}`,
      ],
    ],
    { [variable]: token },
  );
  await docker(['cp', catalog, `${name}:/tmp/fixture.duckdb`]);
  if (!tls) {
    await docker(['cp', SERVE_SCRIPT, `${name}:/tmp/quack-serve.py`]);
  }
  await docker(['start', name]);
  await untilServing(docker, name, token);
  const mapping = (await docker(['port', name, '9494/tcp'])).split(/\r?\n/)[0] ?? '';
  return { host: '127.0.0.1', port: Number(mapping.slice(mapping.lastIndexOf(':') + 1)), token };
}

// Both serve scripts print a line with "serving" once `quack_serve` listens.
async function untilServing(docker: Docker, name: string, token: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const logs = await docker(['logs', name]);
    if (/serving/.test(logs)) return;
    const running = await docker(['inspect', '--format', '{{.State.Running}}', name]);
    if (running !== 'true' || Date.now() > deadline) {
      throw new Error(
        `The Quack container ${name} did not start serving: ${logs.replaceAll(token, '***') || '(no output)'}`,
      );
    }
    await sleep(250);
  }
}
