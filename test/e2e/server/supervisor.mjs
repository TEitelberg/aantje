// Entry point of the code-server container of the end-to-end harness, run by the Node that ships with code-server.
//
// It sets the container up like a deployment would (default settings, a project folder, the extension from the
// VSIX), starts code-server and keeps it running. A spec lives in another container and cannot restart the server itself, so the supervisor offers a small
// control API on port 8081 (reachable on the Docker network only, never published):
//   GET  /         -> { state }                 whether code-server answers
//   POST /restart  -> { ok }                    stop and start code-server; user data and project stay
//   POST /reset    -> { ok }                    like a new container: user data, project and extension from scratch
//   POST /exec     -> { code, stdout, stderr }  runs { command } with sh as the user coder, for state a spec sets up
// Operations run one at a time; a request that arrives meanwhile gets status 409.
//
// The supervisor writes Machine/settings.json only when it seeds the user data; a restart keeps the file as it is.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HOME = '/home/coder';
// The user data directory of code-server; the volume of the harness is mounted here.
const DATA = `${HOME}/.local/share/code-server`;
const EXTENSIONS = `${HOME}/extensions`;
const PROJECT = `${HOME}/project`;
const FIXTURES = '/e2e/fixtures';
// The default settings of the harness; test/e2e/server is mounted at /e2e/server.
const IMAGE_SETTINGS = [
  ['/e2e/server/settings.json', `${DATA}/User/settings.json`],
  ['/e2e/server/machine-settings.json', `${DATA}/Machine/settings.json`],
];
const VSIX = process.env.E2E_VSIX;
const EXTENSION_ID = process.env.E2E_EXTENSION_ID;

function log(message) {
  console.log(`[e2e] ${message}`);
}

function codeServer(args) {
  return spawnSync('code-server', args, { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
}

/** Installs the VSIX with the CLI of code-server, using a throw-away user data dir. */
function installExtension() {
  rmSync(EXTENSIONS, { recursive: true, force: true });
  mkdirSync(EXTENSIONS, { recursive: true });
  const scratch = mkdtempSync('/tmp/e2e-install-');
  const options = [
    '--config',
    `${scratch}/config.yaml`,
    '--user-data-dir',
    scratch,
    '--extensions-dir',
    EXTENSIONS,
  ];
  try {
    for (const args of [
      ['--install-extension', VSIX],
      ['--list-extensions', '--show-versions'],
    ]) {
      const result = codeServer([...options, ...args]);
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      if (result.status !== 0) {
        throw new Error(`code-server ${args[0]} failed with exit code ${result.status}`);
      }
      if (
        args[0] === '--list-extensions' &&
        !result.stdout.toLowerCase().includes(`${EXTENSION_ID.toLowerCase()}@`)
      ) {
        throw new Error(`${EXTENSION_ID} is not installed after installing ${VSIX}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function emptyDirectory(path) {
  mkdirSync(path, { recursive: true });
  for (const entry of readdirSync(path)) {
    rmSync(join(path, entry), { recursive: true, force: true });
  }
}

function seedProject() {
  rmSync(PROJECT, { recursive: true, force: true });
  mkdirSync(`${PROJECT}/fixtures`, { recursive: true });
  for (const file of readdirSync(FIXTURES).filter((name) => /\.(sqlite|duckdb|sql)$/.test(name))) {
    copyFileSync(join(FIXTURES, file), `${PROJECT}/fixtures/${file}`);
  }
}

function seedUserData() {
  emptyDirectory(DATA);
  for (const [source, target] of IMAGE_SETTINGS) {
    if (existsSync(source)) {
      mkdirSync(join(target, '..'), { recursive: true });
      copyFileSync(source, target);
    }
  }
}

/** A volume that survives the container is kept as it is; a new container with a new volume starts from scratch. */
function prepare({ fresh }) {
  if (fresh || !existsSync(PROJECT)) {
    seedProject();
  }
  if (fresh || readdirSync(DATA).length === 0) {
    seedUserData();
  }
  if (fresh || !existsSync(EXTENSIONS)) {
    log(`installing ${VSIX}`);
    installExtension();
  }
}

let child;
let stopping = false;

function start() {
  stopping = false;
  child = spawn(
    'dumb-init',
    [
      ...['--', 'code-server', '--bind-addr', '0.0.0.0:8080', '--auth', 'none'],
      ...['--disable-telemetry', '--disable-update-check', '--disable-workspace-trust'],
      ...['--user-data-dir', DATA, '--extensions-dir', EXTENSIONS, PROJECT],
    ],
    { stdio: 'inherit' },
  );
  child.once('exit', (code, signal) => {
    if (!stopping) {
      log(`code-server exited unexpectedly (${signal ?? code})`);
      process.exit(code ?? 1);
    }
  });
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  stopping = true;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  if ((await Promise.race([exited, sleep(15_000, 'timeout')])) === 'timeout') {
    child.kill('SIGKILL');
    await exited;
  }
}

async function healthy() {
  try {
    return (await globalThis.fetch('http://127.0.0.1:8080/healthz', { signal: AbortSignal.timeout(2_000) }))
      .ok;
  } catch {
    return false;
  }
}

async function waitUntilHealthy() {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (await healthy()) {
      return;
    }
    await sleep(250);
  }
  throw new Error('code-server did not become healthy within 60 s');
}

async function restart({ fresh }) {
  await stop();
  prepare({ fresh });
  start();
  await waitUntilHealthy();
}

function exec(command) {
  return new Promise((resolve) => {
    const shell = spawn('sh', ['-c', command], { cwd: HOME, timeout: 30_000, killSignal: 'SIGKILL' });
    let stdout = '';
    let stderr = '';
    shell.stdout.on('data', (chunk) => (stdout += chunk));
    shell.stderr.on('data', (chunk) => (stderr += chunk));
    shell.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function body(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
  }
  return text ? JSON.parse(text) : {};
}

let busy = false;

async function handle(request) {
  const route = `${request.method} ${request.url}`;
  if (route === 'GET /') {
    return { state: (await healthy()) ? 'ready' : 'starting' };
  }
  if (route === 'POST /exec') {
    return exec((await body(request)).command);
  }
  if (route === 'POST /restart' || route === 'POST /reset') {
    await restart({ fresh: route === 'POST /reset' });
    return { ok: true };
  }
  return undefined;
}

function serve() {
  createServer((request, response) => {
    const send = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (busy) {
      send(409, { error: 'another operation is running' });
      return;
    }
    busy = true;
    handle(request)
      .then((result) => (result ? send(200, result) : send(404, { error: 'unknown route' })))
      .catch((error) => send(500, { error: String(error) }))
      .finally(() => {
        busy = false;
      });
  }).listen(8081, '0.0.0.0');
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    stop().finally(() => process.exit(0));
  });
}

prepare({ fresh: false });
start();
await waitUntilHealthy();
serve();
log('ready');
