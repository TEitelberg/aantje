// Builds THIRD-PARTY-NOTICES.md from the npm packages that esbuild bundled into the extension and the report client
// script: the licences of MIT/ISC/BSD/Apache packages require that their notice travels with every copy.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const LICENSE_FILE = /^(licen[sc]e|copying)([.-].*)?$/i;
/** Apache-2.0 asks that the NOTICE file of a package travels with it too. */
const NOTICE_FILE = /^notice([.-].*)?$/i;

/** Directories of the npm packages behind the `sources` of a source map (relative to `baseDir`), sorted. */
export function packageDirs(sources, baseDir) {
  const marker = '/node_modules/';
  const dirs = new Set();
  for (const source of sources) {
    const path = resolve(baseDir, source.replaceAll('\\', '/')).split(sep).join('/');
    // The last node_modules is the one that holds the package, also for nested installs.
    const at = path.lastIndexOf(marker);
    if (at < 0) {
      continue;
    }
    const [first, second] = path.slice(at + marker.length).split('/');
    dirs.add(path.slice(0, at + marker.length) + (first.startsWith('@') ? `${first}/${second}` : first));
  }
  return [...dirs].sort();
}

/**
 * Name, version, licence and licence text of the package in `dir`: its licence file, its NOTICE file and the files in
 * its `licenses` directory, where a package keeps the licences of the code it embeds (ECharts: d3, BSD-3-Clause).
 */
export function describePackage(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const names = readdirSync(dir);
  const file = names.find((name) => LICENSE_FILE.test(name));
  const notice = names.find((name) => NOTICE_FILE.test(name));
  const embedded = names.includes('licenses')
    ? readdirSync(join(dir, 'licenses'), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
    : [];
  const text = [
    ...[file, notice].flatMap((name) => (name ? [readFileSync(join(dir, name), 'utf8').trim()] : [])),
    ...embedded.map(
      (name) => `licenses/${name}\n\n${readFileSync(join(dir, 'licenses', name), 'utf8').trim()}`,
    ),
  ];
  return {
    name: pkg.name,
    version: pkg.version,
    license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'unknown'),
    source: typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? ''),
    text: text.length > 0 ? text.join('\n\n') : undefined,
  };
}

export function renderNotices(packages) {
  // A package that is installed twice (nested) appears once.
  const unique = [...new Map(packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg])).values()];
  const sorted = unique.toSorted((a, b) => a.name.localeCompare(b.name));
  return [
    '# Third-party notices',
    '',
    'aantje bundles the following open-source packages into `dist/extension.js` and `dist/report-client.js`.',
    'Their licence notices are reproduced below.',
    '',
    'DuckDB is not bundled; it ships in the package as its own files: `@duckdb/node-api`, `@duckdb/node-bindings`',
    'and the binding of the platform (`@duckdb/node-bindings-<platform>`), all MIT licensed, with their own licence',
    'files in `node_modules/@duckdb`. The DuckDB extensions (`ducklake`, `postgres`, `sqlite`, `httpfs`, `quack` and',
    '`azure`, as the catalog needs them) are not part of the package: DuckDB downloads them at runtime from',
    '`extensions.duckdb.org`, under their own licences.',
    ...sorted.flatMap((pkg) => [
      '',
      `## ${pkg.name} ${pkg.version}`,
      '',
      `- Licence: ${pkg.license}`,
      ...(pkg.source ? [`- Source: ${pkg.source}`] : []),
      '',
      '```text',
      pkg.text ?? 'The package ships no licence file; its package.json declares the licence above.',
      '```',
    ]),
    '',
  ].join('\n');
}

/** Reads the bundled packages from the source maps and writes the notices file. */
export function writeNotices({ mapFiles, outFile }) {
  const dirs = new Set(
    mapFiles.flatMap((mapFile) =>
      packageDirs(JSON.parse(readFileSync(mapFile, 'utf8')).sources, resolve(mapFile, '..')),
    ),
  );
  writeFileSync(outFile, renderNotices([...dirs].sort().map(describePackage)));
}
