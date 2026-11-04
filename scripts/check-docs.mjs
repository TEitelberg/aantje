// Fails when the documentation names a file that does not exist or links to a missing page or heading.
// Plain Node.js, no dependency: `npm run check:docs`, or `node scripts/check-docs.mjs <project>` for another tree
// (the docs test runs it on small projects of its own). It is the one link check of the project.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['src', 'test', 'scripts', 'docs', 'media'];
// Created by a run or a build and ignored by Git, so a clean clone does not have them.
const GENERATED = [
  'test/.cache',
  'test/.tmp',
  'test/e2e/.tmp',
  'test/e2e/out',
  'dist',
  'out',
  'artifacts',
  'node_modules',
];

const pages = [
  ...(existsSync(join(root, 'docs/en')) ? readdirSync(join(root, 'docs/en')) : [])
    .filter((name) => name.endsWith('.md'))
    .map((name) => `docs/en/${name}`),
  ...['README.md', 'CONTRIBUTING.md', 'SECURITY.md'].filter((page) => existsSync(join(root, page))),
];

// A checkout without the tests (the test suite is published later) still checks everything else.
const hasTests = existsSync(join(root, 'test'));
const testFiles = new Set(
  hasTests ? listFiles(join(root, 'test')).map((file) => file.slice(file.lastIndexOf('/') + 1)) : [],
);
const problems = [];
const headingCache = new Map();

for (const page of pages) {
  const text = withoutFences(readFileSync(join(root, page), 'utf8'));
  for (const [index, line] of text.split('\n').entries()) {
    const where = `${page}:${index + 1}`;
    for (const [, code] of line.matchAll(/`([^`]+)`/g)) {
      checkPath(code, where);
    }
    // A link inside inline code is an example, not a link.
    for (const [, target] of line.replace(/`[^`]*`/g, '').matchAll(/\]\(([^)\s]+)\)/g)) {
      checkLink(page, target, where);
    }
  }
}

if (problems.length > 0) {
  console.error(`${problems.length} documentation problem(s):\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Documentation checked: ${pages.length} pages, no missing file, link or heading.`);

/** Fenced code blocks hold commands and sample output, not references; the lines stay so that line numbers match. */
// Windows and macOS find `B.md` for `b.md`; a link with the wrong case fails on GitHub and on Linux.
function existsExactCase(path) {
  let current = root;
  for (const segment of path.split(/[\\/]/).filter((part) => part !== '')) {
    if (!existsSync(current) || !statSync(current).isDirectory() || !readdirSync(current).includes(segment)) {
      return false;
    }
    current = join(current, segment);
  }
  return true;
}

function withoutFences(text) {
  let fenced = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return '';
      }
      return fenced ? '' : line;
    })
    .join('\n');
}

function checkPath(code, where) {
  const path = code.replace(/:\d+(-\d+)?$/, '');
  if (/^[\w-]+(\.contract)?\.test\.ts$/.test(path)) {
    if (hasTests && !testFiles.has(path)) {
      problems.push(`${where}: no test file is named \`${path}\``);
    }
    return;
  }
  const top = path.split('/')[0];
  if (
    !ROOTS.includes(top) ||
    !path.includes('/') ||
    /[\s<>${}()]/.test(path) ||
    (top === 'test' && !hasTests)
  ) {
    return;
  }
  if (GENERATED.some((generated) => path === generated || path.startsWith(`${generated}/`))) {
    return;
  }
  if (path.includes('*')) {
    if (!matchesGlob(path)) {
      problems.push(`${where}: no file matches \`${code}\``);
    }
  } else if (!existsSync(join(root, path))) {
    problems.push(`${where}: \`${code}\` does not exist`);
  }
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.name === '.cache' || entry.name === 'node_modules'
      ? []
      : entry.isDirectory()
        ? listFiles(`${directory}/${entry.name}`)
        : [`${directory}/${entry.name}`],
  );
}

/** A pattern with a wildcard in its directory part is only checked up to the first wildcard. */
function matchesGlob(pattern) {
  const slash = pattern.lastIndexOf('/');
  const directoryPart = pattern.slice(0, slash);
  if (directoryPart.includes('*')) {
    return existsSync(join(root, directoryPart.slice(0, directoryPart.indexOf('*'))));
  }
  const directory = join(root, directoryPart);
  if (!existsSync(directory)) {
    return false;
  }
  const expression = new RegExp(
    `^${pattern
      .slice(slash + 1)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('*', '.*')}$`,
  );
  return readdirSync(directory).some((name) => expression.test(name));
}

function checkLink(page, target, where) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return;
  }
  const [file, anchor] = target.split('#');
  const path = file === '' ? join(root, page) : resolve(dirname(join(root, page)), file);
  if (!existsExactCase(relative(root, path))) {
    problems.push(
      `${where}: the link target ${target} does not exist (${relative(root, path).split(sep).join('/')})`,
    );
  } else if (anchor !== undefined && anchor !== '' && statSync(path).isFile() && path.endsWith('.md')) {
    if (!headingsOf(path).has(anchor.toLowerCase())) {
      problems.push(`${where}: ${relative(root, path).replaceAll('\\', '/')} has no heading for #${anchor}`);
    }
  }
}

/** The anchors GitHub generates for the headings of a page, including the numbered ones for repeated headings. */
function headingsOf(path) {
  let anchors = headingCache.get(path);
  if (!anchors) {
    anchors = new Set();
    const seen = new Map();
    for (const line of withoutFences(readFileSync(path, 'utf8')).split('\n')) {
      const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (heading) {
        const slug = heading[1]
          .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/[`*_~]/g, '')
          .toLowerCase()
          .replace(/[^\p{L}\p{N} _-]/gu, '')
          .replaceAll(' ', '-');
        const count = seen.get(slug) ?? 0;
        seen.set(slug, count + 1);
        anchors.add(count === 0 ? slug : `${slug}-${count}`);
      }
    }
    headingCache.set(path, anchors);
  }
  return anchors;
}
