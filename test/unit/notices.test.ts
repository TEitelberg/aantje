import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { describePackage, packageDirs, renderNotices, writeNotices } from '../../scripts/notices.mjs';

const root = resolve(import.meta.dirname, '../..');

describe('packageDirs', () => {
  const base = resolve('/project/dist');
  const at = (path: string): string => resolve(path).split('\\').join('/');

  it('maps the files of a source map to one directory per npm package', () => {
    const dirs = packageDirs(
      [
        '../node_modules/pg/lib/client.js',
        '../node_modules/pg/lib/index.js',
        '../node_modules/pg-protocol/dist/parser.js',
        '../src/extension.ts',
      ],
      base,
    );
    expect(dirs).toEqual([at('/project/node_modules/pg'), at('/project/node_modules/pg-protocol')]);
  });

  it('keeps the scope of a scoped package and the location of a nested install', () => {
    const dirs = packageDirs(
      ['../node_modules/@scope/tool/index.js', '../node_modules/outer/node_modules/inner/index.js'],
      base,
    );
    expect(dirs).toEqual([
      at('/project/node_modules/@scope/tool'),
      at('/project/node_modules/outer/node_modules/inner'),
    ]);
  });

  it('reads Windows style separators the same way', () => {
    expect(packageDirs(['..\\node_modules\\pg\\lib\\client.js'], base)).toEqual([
      at('/project/node_modules/pg'),
    ]);
  });
});

describe('describePackage on a real installed package', () => {
  it('reads name, version, licence and the licence text of pg', () => {
    const pkg = describePackage(join(root, 'node_modules/pg'));
    expect(pkg).toMatchObject({ name: 'pg', license: 'MIT' });
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pkg.text).toContain('Permission is hereby granted');
  });
});

describe('renderNotices', () => {
  it('reads the NOTICE file that Apache-2.0 asks for after the licence text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aantje-notice-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'apache-thing', version: '2.0.0', license: 'Apache-2.0' }),
      );
      writeFileSync(join(dir, 'LICENSE'), 'Apache License text\n');
      writeFileSync(join(dir, 'NOTICE'), 'Apache Thing\nCopyright the Foundation\n');
      expect(describePackage(dir).text).toBe('Apache License text\n\nApache Thing\nCopyright the Foundation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the licences of embedded code from the licenses directory of a package, after the NOTICE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aantje-embedded-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'host', version: '1.0.0', license: 'MIT' }),
      );
      writeFileSync(join(dir, 'LICENSE'), 'Host licence\n');
      mkdirSync(join(dir, 'licenses'));
      writeFileSync(join(dir, 'licenses', 'LICENSE-b'), 'Licence of b\n');
      writeFileSync(join(dir, 'licenses', 'LICENSE-a'), 'Licence of a\n');
      mkdirSync(join(dir, 'licenses', 'nested'));
      expect(describePackage(dir).text).toBe(
        'Host licence\n\nlicenses/LICENSE-a\n\nLicence of a\n\nlicenses/LICENSE-b\n\nLicence of b',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists the packages sorted by name with their licence text', () => {
    const text = renderNotices([
      { name: 'zeta', version: '2.0.0', license: 'ISC', source: '', text: 'ISC text' },
      {
        name: 'alpha',
        version: '1.0.0',
        license: 'MIT',
        source: 'git://example.test/alpha.git',
        text: undefined,
      },
    ]);
    // The introduction is prose; the packages after it are values: name, version, licence, source and text.
    expect(text.startsWith('# Third-party notices\n')).toBe(true);
    expect(text.slice(text.indexOf('## alpha'))).toBe(
      [
        '## alpha 1.0.0',
        '',
        '- Licence: MIT',
        '- Source: git://example.test/alpha.git',
        '',
        '```text',
        'The package ships no licence file; its package.json declares the licence above.',
        '```',
        '',
        '## zeta 2.0.0',
        '',
        '- Licence: ISC',
        '',
        '```text',
        'ISC text',
        '```',
        '',
      ].join('\n'),
    );
  });
});

describe('renderNotices with a package that is installed twice', () => {
  it('lists a name and version once, and two versions of a name twice', () => {
    const notice = (version: string) => ({
      name: 'tslib',
      version,
      license: '0BSD',
      source: '',
      text: 'text',
    });
    const headings = [
      ...renderNotices([notice('2.3.0'), notice('2.3.0'), notice('2.8.1')]).matchAll(/^## (.+)$/gm),
    ];
    expect(headings.map((match) => match[1])).toEqual(['tslib 2.3.0', 'tslib 2.8.1']);
  });
});

describe('THIRD-PARTY-NOTICES.md as the build writes it', () => {
  it('names DuckDB and the extensions that are downloaded at runtime', () => {
    const notices = readFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8');
    expect(notices).toContain('@duckdb/node-api');
    // Every extension that the engine installs is named; the sentence around them is free.
    for (const extension of ['ducklake', 'postgres', 'sqlite', 'httpfs', 'quack', 'azure']) {
      expect(notices, extension).toContain('`' + extension + '`');
    }
  });

  it('names ECharts and zrender with their licences, which only the source map of the report script knows', () => {
    const notices = readFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8');
    expect(notices).toMatch(/^## echarts \d+\.\d+\.\d+$/m);
    expect(notices).toContain('- Licence: Apache-2.0');
    expect(notices).toMatch(/^## zrender \d+\.\d+\.\d+$/m);
    expect(notices).toContain('- Licence: BSD-3-Clause');
    // the NOTICE file of ECharts
    expect(notices).toContain('This product includes software developed at');
  });

  it('carries the BSD licence of the d3 code that ECharts embeds, which its NOTICE file names', () => {
    const notices = readFileSync(join(root, 'THIRD-PARTY-NOTICES.md'), 'utf8');
    expect(notices).toContain('licenses/LICENSE-d3');
    expect(notices).toContain('Copyright 2010-2016 Mike Bostock');
    expect(notices).toContain('Redistributions of source code must retain the above copyright notice');
  });
});

describe('writeNotices', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aantje-notices-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the notices of the packages named in a source map', () => {
    const pkgDir = join(dir, 'node_modules', 'left-pad');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'left-pad', version: '1.3.0', license: 'WTFPL' }),
    );
    writeFileSync(join(pkgDir, 'LICENSE'), 'Do what you want.\n');
    mkdirSync(join(dir, 'dist'));
    const mapFile = join(dir, 'dist', 'extension.js.map');
    writeFileSync(
      mapFile,
      JSON.stringify({ sources: ['../node_modules/left-pad/index.js', '../src/extension.ts'] }),
    );

    const outFile = join(dir, 'THIRD-PARTY-NOTICES.md');
    writeNotices({ mapFiles: [mapFile], outFile });

    const text = readFileSync(outFile, 'utf8');
    expect(text).toContain('## left-pad 1.3.0');
    expect(text).toContain('- Licence: WTFPL');
    expect(text).toContain('Do what you want.');
    expect(text).not.toContain('extension.ts');
  });

  it('joins the packages of several source maps and lists a package of both once', () => {
    for (const name of ['right-pad', 'shared']) {
      const pkgDir = join(dir, 'node_modules', name);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version: '1.0.0', license: 'MIT' }));
    }
    const maps = [
      ['one.js.map', ['../node_modules/shared/a.js']],
      ['two.js.map', ['../node_modules/right-pad/a.js', '../node_modules/shared/b.js']],
    ] as const;
    for (const [file, sources] of maps) {
      writeFileSync(join(dir, 'dist', file), JSON.stringify({ sources }));
    }
    const outFile = join(dir, 'JOINED.md');
    writeNotices({ mapFiles: maps.map(([file]) => join(dir, 'dist', file)), outFile });
    const headings = [...readFileSync(outFile, 'utf8').matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual(['right-pad 1.0.0', 'shared 1.0.0']);
  });
});
