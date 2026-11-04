// Fails when deploy/azure/azuredeploy.json is not what `az bicep build` makes of deploy/azure/main.bicep.
// Skipped (exit 0) where the Azure CLI is not installed. `npm run check:azure-template`.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'deploy/azure/main.bicep');
const committed = join(root, 'deploy/azure/azuredeploy.json');

const directory = mkdtempSync(join(tmpdir(), 'aantje-bicep-'));
try {
  const built = join(directory, 'azuredeploy.json');
  const run = spawnSync(`az bicep build --file "${source}" --outfile "${built}"`, {
    encoding: 'utf8',
    shell: true,
  });
  if (run.error || /not recognized|not found/i.test(run.stderr)) {
    console.log('Azure CLI not found: the committed template was not compared with a fresh build.');
  } else if (run.status !== 0) {
    console.error(run.stderr);
    process.exit(1);
  } else if (normalized(committed) !== normalized(built)) {
    console.error('deploy/azure/azuredeploy.json is out of date. Run `npm run build:azure-template`.');
    process.exit(1);
  } else {
    console.log('deploy/azure/azuredeploy.json matches main.bicep.');
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

// The generator version and the template hash change with the Bicep release, not with the template.
function normalized(file) {
  const template = JSON.parse(readFileSync(file, 'utf8'));
  delete template.metadata?._generator;
  return JSON.stringify(template);
}
