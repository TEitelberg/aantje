// Prints the version of the next release: the newest published version with one part counted up. The newest of the
// `vX.Y.Z` tags and of the version given with `--published` counts, so a release that stopped after the upload does
// not make the next run compute the same version again. Without both, the version of package.json is the first release.
// Usage: node scripts/next-version.mjs [patch|minor|major] [--published X.Y.Z]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BUMPS = ['patch', 'minor', 'major'];
const VERSION = /^\d+\.\d+\.\d+$/;

const parts = (version) => version.split('.').map(Number);

function compare(a, b) {
  const [left, right] = [parts(a), parts(b)];
  const index = left.findIndex((part, position) => part !== right[position]);
  return index === -1 ? 0 : left[index] - right[index];
}

/** The newest of the given versions; undefined when there is none. */
export function newest(versions) {
  return versions.filter((version) => VERSION.test(version ?? '')).sort((a, b) => compare(b, a))[0];
}

/** The version after `latest`; `latest` is undefined before the first release. */
export function nextVersion(latest, bump, first) {
  if (!BUMPS.includes(bump)) {
    throw new Error(`The bump must be one of ${BUMPS.join(', ')}, not "${bump}".`);
  }
  if (latest === undefined) {
    return first;
  }
  const [major, minor, patch] = parts(latest);
  if (bump === 'major') {
    return `${major + 1}.0.0`;
  }
  return bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

function tags() {
  return execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
    .split('\n')
    .map((tag) => tag.replace(/^v/, ''));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--published');
  const published = flag === -1 ? undefined : args[flag + 1];
  const bump = args.find((arg, index) => !arg.startsWith('--') && index !== flag + 1) ?? 'patch';
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const first = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  console.log(nextVersion(newest([...tags(), published]), bump, first));
}
