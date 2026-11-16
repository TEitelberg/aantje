// Lints deploy/aws/template.yaml with cfn-lint and checks that CloudFormation takes it as a TemplateBody (at most
// 51,200 bytes). The lint is skipped (exit 0) where cfn-lint is not installed; CI installs it. `npm run check:aws-template`.
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = join(root, 'deploy/aws/template.yaml');
const MAX_BODY = 51_200;

const size = statSync(template).size;
if (size > MAX_BODY) {
  console.error(
    `deploy/aws/template.yaml has ${size} bytes; CloudFormation takes at most ${MAX_BODY} as a TemplateBody.`,
  );
  process.exit(1);
}

const run = spawnSync('cfn-lint', [template], { encoding: 'utf8' });
if (run.error || /not recognized|not found/i.test(run.stderr ?? '')) {
  console.log('cfn-lint not found: deploy/aws/template.yaml was not linted.');
} else if (run.status !== 0) {
  console.error(run.stdout, run.stderr);
  process.exit(1);
} else {
  console.log(`deploy/aws/template.yaml passes cfn-lint (${size} bytes).`);
}
