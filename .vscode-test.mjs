// Configuration of the extension-host tests (`npm run test:integration`), see docs/en/integration-tests.md.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';
import * as esbuild from 'esbuild';

const root = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// The oldest VS Code that the manifest allows ("^1.140.0" -> 1.140.0): what works there works in newer ones.
const minimumVersion = /\d+\.\d+\.\d+/.exec(manifest.engines.vscode)[0];

// The tests run in a VS Code with a profile of its own: none of the settings, extensions and state of the
// developer's VS Code leaks in, and nothing of the run stays behind.
const prefix = 'aantje-vsc-';
removeStaleSandboxes();
const sandbox = mkdtempSync(join(tmpdir(), prefix));
// A run that is started in the terminal of a VS Code would hand the state variables of that VS Code on (its IPC
// socket, its cache directory, ...).
const inherited = Object.fromEntries(
  Object.keys(process.env)
    .filter((name) => name.startsWith('VSCODE_'))
    .map((name) => [name, undefined]),
);
const userDataDir = join(sandbox, 'user-data');
const extensionsDir = join(sandbox, 'extensions');
mkdirSync(join(userDataDir, 'User'), { recursive: true });
mkdirSync(extensionsDir);
writeFileSync(
  join(userDataDir, 'User', 'settings.json'),
  JSON.stringify({
    'telemetry.telemetryLevel': 'off',
    'security.workspace.trust.enabled': false,
    'update.mode': 'none',
    'extensions.autoUpdate': false,
    'extensions.autoCheckUpdates': false,
    'workbench.startupEditor': 'none',
    'workbench.enableExperiments': false,
    'chat.disableAIFeatures': true,
    'git.enabled': false,
  }),
);
process.on('exit', () => {
  try {
    // Windows may still hold files of the Electron processes that are shutting down.
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (error) {
    console.warn(`Could not remove ${sandbox}: ${error.message}`);
  }
});

// The tests are TypeScript: bundle them on every run, so that `vscode-test` alone is always up to date.
// `vscode` is provided by the extension host.
await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['test/integration/index.ts'],
  outfile: 'out/integration.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  logLevel: 'warning',
});

export default defineConfig({
  label: 'integration',
  version: minimumVersion,
  files: 'out/integration.js',
  workspaceFolder: 'test/integration/workspace',
  launchArgs: [
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extensionsDir}`,
    '--disable-extensions',
    '--disable-telemetry',
  ],
  env: { ...inherited, AANTJE_TEST_SANDBOX: sandbox },
  mocha: { ui: 'bdd', timeout: 30_000 },
});

/** A run that was killed cannot clean up after itself; the next run removes what is more than a day old. */
function removeStaleSandboxes() {
  for (const name of readdirSync(tmpdir())) {
    const path = join(tmpdir(), name);
    try {
      if (name.startsWith(prefix) && Date.now() - statSync(path).mtimeMs > 24 * 3_600_000) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Still in use or already gone: not worth failing the run.
    }
  }
}
