import { describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogProperties } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { propertiesMarkdown } from '../../src/properties';
import { HISTORY_DATA_PATH } from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { historyFixture } from '../support/sources/history';

describe('the Properties document of a connection', () => {
  it('lists the facts of the history fixture and every row of ducklake_metadata with its scope', async () => {
    const reader = createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
    let markdown: string;
    let createdBy: string | null;
    try {
      const properties = await reader.properties();
      createdBy = properties.createdBy;
      markdown = propertiesMarkdown('History lake', properties);
    } finally {
      await reader.close();
    }

    const lines = markdown.split('\n');
    expect(lines.slice(0, 5)).toEqual([
      '# Properties of History lake',
      '',
      '| Property | Value |',
      '| --- | --- |',
      '| DuckLake version | `1.1` |',
    ]);
    expect(lines.slice(5, 10)).toEqual([
      `| Created by | \`${createdBy ?? ''}\` |`,
      `| Data path | \`${HISTORY_DATA_PATH.sqlite}\` |`,
      '| Encrypted | no |',
      '| Snapshots | 57 |',
      expect.stringMatching(/^\| First snapshot \| \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC \|$/),
    ]);
    expect(lines[10]).toMatch(/^\| Latest snapshot \| \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC \|$/);
    const metadata = lines.slice(lines.indexOf('## Metadata') + 2);
    expect(metadata.slice(0, 2)).toEqual(['| Key | Value | Scope |', '| --- | --- | --- |']);
    expect(metadata.filter((line) => line.startsWith('| `'))).toEqual([
      `| \`created_by\` | \`${createdBy ?? ''}\` | global |`,
      `| \`data_path\` | \`${HISTORY_DATA_PATH.sqlite}\` | global |`,
      '| `encrypted` | `false` | global |',
      '| `version` | `1.1` | global |',
      '| `data_inlining_row_limit` | `10` | `table 10` |',
    ]);
  });

  it('shows catalog text literally: no Markdown, no extra table cell, no line break', () => {
    const hostile: CatalogProperties = {
      specVersion: '1.1',
      createdBy: 'x | y\n# h',
      dataPath: '`/p|a`th',
      encrypted: false,
      metadata: [
        { key: 'a|b', value: 'v\n\n| x |', scope: 't`', scopeId: null },
        { key: 'k', value: '', scope: null, scopeId: null },
        { key: 'n', value: '[l](http://evil)', scope: 'table', scopeId: 3 },
      ],
      snapshotCount: 2,
      firstSnapshotTime: '2026-01-02T03:04:05.678Z',
      latestSnapshotTime: null,
    };

    expect(propertiesMarkdown('My *lake*\nx', hostile)).toBe(
      [
        String.raw`# Properties of My \*lake\* x`,
        '',
        '| Property | Value |',
        '| --- | --- |',
        '| DuckLake version | `1.1` |',
        String.raw`| Created by | ` + '`x \\| y # h`' + ' |',
        String.raw`| Data path | ` + '`` `/p\\|a`th `` |',
        '| Encrypted | no |',
        '| Snapshots | 2 |',
        '| First snapshot | 2026-01-02 03:04:05 UTC |',
        '| Latest snapshot | none |',
        '',
        '## Metadata',
        '',
        '| Key | Value | Scope |',
        '| --- | --- | --- |',
        '| `a\\|b` | `v \\| x \\|` | `` t` `` |',
        '| `k` |  | global |',
        '| `n` | `[l](http://evil)` | `table 3` |',
        '',
      ].join('\n'),
    );
  });

  it('says so when the catalog does not name its creator or its data path, and has no snapshot', () => {
    const empty: CatalogProperties = {
      specVersion: '1.0',
      createdBy: null,
      dataPath: null,
      encrypted: true,
      metadata: [],
      snapshotCount: 0,
      firstSnapshotTime: null,
      latestSnapshotTime: null,
    };

    const lines = propertiesMarkdown('Lake', empty).split('\n');

    expect(lines).toContain('| Created by | not set |');
    expect(lines).toContain('| Data path | not set |');
    expect(lines).toContain('| Encrypted | yes |');
    expect(lines).toContain('| First snapshot | none |');
    expect(lines.slice(-5)).toEqual([
      '## Metadata',
      '',
      '| Key | Value | Scope |',
      '| --- | --- | --- |',
      '',
    ]);
  });
});
