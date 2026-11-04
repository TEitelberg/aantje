import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogProperties, MetadataEntry } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { propertiesKind } from '../../src/properties-report/kind';
import {
  METADATA_ROWS,
  matchingMetadata,
  propertiesCards,
  scopeText,
} from '../../src/properties-report/model';
import type { PropertiesData } from '../../src/properties-report/model';
import {
  isPropertiesAction,
  isPropertiesMessage,
  isPropertiesView,
} from '../../src/properties-report/protocol';
import { propertiesMarkdown } from '../../src/properties';
import { formatUtc } from '../../src/shell/model';
import { wasmPath } from '../support/fixtures';
import { historyFixture } from '../support/sources/history';

let properties: CatalogProperties;
const reader = createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
beforeAll(async () => {
  properties = await reader.properties();
});
afterAll(() => reader.close());

const dataOf = (actions: PropertiesData['actions'] = []): PropertiesData => ({
  connection: 'History',
  properties,
  actions,
});

describe('the Properties report model', () => {
  it('shows the facts of the history fixture, and "not set" / "none" for a bare catalog', () => {
    expect(propertiesCards(properties).map((card) => card.value)).toEqual([
      '1.1',
      properties.createdBy ?? 'not set',
      'no',
      '57',
      formatUtc(properties.firstSnapshotTime ?? ''),
      formatUtc(properties.latestSnapshotTime ?? ''),
    ]);
    const bare: CatalogProperties = {
      specVersion: '1.0',
      createdBy: null,
      dataPath: null,
      encrypted: true,
      metadata: [],
      snapshotCount: 0,
      firstSnapshotTime: null,
      latestSnapshotTime: null,
    };
    expect(propertiesCards(bare).map((card) => card.value)).toEqual([
      '1.0',
      'not set',
      'yes',
      '0',
      'none',
      'none',
    ]);
  });

  it('lists the metadata with its scope and filters it as case-insensitive text, not as a pattern', () => {
    expect(properties.metadata.map((entry) => [entry.key, scopeText(entry)])).toEqual([
      ['created_by', 'global'],
      ['data_path', 'global'],
      ['encrypted', 'global'],
      ['version', 'global'],
      ['data_inlining_row_limit', 'table 10'],
    ]);
    const keys = (filter: string): string[] =>
      matchingMetadata(properties.metadata, filter).map((e) => e.key);
    expect(keys('   ')).toHaveLength(5);
    expect(keys('table 10')).toEqual(['data_inlining_row_limit']);
    expect(keys(' global ')).toEqual(['created_by', 'data_path', 'encrypted', 'version']);
    expect(keys('sqlite-files')).toEqual(['data_path']);
    expect(keys('no such entry')).toEqual([]);

    const entries: MetadataEntry[] = [
      { key: 'Data_Path', value: '/Lake/Files', scope: null, scopeId: null },
      { key: 'a.b', value: '(x)', scope: 'Table', scopeId: 7 },
      { key: 'axb', value: '', scope: null, scopeId: null },
    ];
    const found = (filter: string): string[] => matchingMetadata(entries, filter).map((e) => e.key);
    expect(found('DATA_PATH')).toEqual(['Data_Path']);
    expect(found('lake/files')).toEqual(['Data_Path']);
    expect(found('table 7')).toEqual(['a.b']);
    expect(found('a.b')).toEqual(['a.b']);
    expect(found('.*')).toEqual([]);
  });
});

describe('the Properties report as a Markdown document', () => {
  it('has the whole document once, filtered to the matching entries, and escapes the filter', () => {
    expect(propertiesKind.toMarkdown(dataOf(), undefined)).toBe(propertiesMarkdown('History', properties));
    expect(propertiesKind.toMarkdown(dataOf(), { filter: '' })).toBe(
      propertiesMarkdown('History', properties),
    );
    expect(propertiesMarkdown('Lake', properties, '   ')).toBe(propertiesMarkdown('Lake', properties));

    const lines = propertiesKind.toMarkdown(dataOf(), { filter: 'inlining' }).split('\n');
    expect(lines[0]).toBe('# Properties of History');
    expect(lines).toContain('| Snapshots | 57 |');
    expect(lines.slice(lines.indexOf('## Metadata') + 1)).toEqual([
      '',
      'Filter: `inlining`. 1 of 5 entries match.',
      '',
      '| Key | Value | Scope |',
      '| --- | --- | --- |',
      '| `data_inlining_row_limit` | `10` | `table 10` |',
      '',
    ]);

    const nothing = propertiesKind.toMarkdown(dataOf(), { filter: 'zzz' }).split('\n');
    expect(nothing.slice(-4)).toEqual(['', '| Key | Value | Scope |', '| --- | --- | --- |', '']);

    const hostile = propertiesMarkdown('Lake', properties, 'a | b\n# `c`').split('\n');
    expect(hostile).toContain('Filter: `` a \\| b # `c` ``. 0 of 5 entries match.');
    expect(hostile.filter((line) => line.startsWith('#'))).toEqual(['# Properties of Lake', '## Metadata']);
  });

  it('cuts a long table at the limit, counts what was left out and lets a filter reach behind the cut', () => {
    const many: CatalogProperties = {
      ...properties,
      metadata: Array.from({ length: METADATA_ROWS + 120 }, (_, index) => ({
        key: 'data_inlining_row_limit',
        value: String(index),
        scope: 'table',
        scopeId: index,
      })),
    };
    const lines = propertiesMarkdown('Big', many).split('\n');
    expect(lines.filter((line) => line.startsWith('| `data_inlining_row_limit`'))).toHaveLength(500);
    expect(lines).toContain('… 120 more omitted (limit: 500).');
    expect(lines).toContain('| `data_inlining_row_limit` | `499` | `table 499` |');
    expect(lines).not.toContain('| `data_inlining_row_limit` | `500` | `table 500` |');
    const found = propertiesMarkdown('Big', many, 'table 600').split('\n');
    expect(found).toContain('| `data_inlining_row_limit` | `600` | `table 600` |');
    expect(found).not.toContain('… 120 more omitted (limit: 500).');
    expect(propertiesMarkdown('Big', many, 'table').split('\n')).toContain(
      'Filter: `table`. 620 of 620 entries match.',
    );
  });
});

describe('what the Properties page and the extension accept from each other', () => {
  const message = (data: unknown): unknown => JSON.parse(JSON.stringify({ type: 'properties', data }));
  const withProperties = (change: object): PropertiesData => ({
    ...dataOf(),
    properties: { ...properties, ...change },
  });

  it('accepts a real catalog after a trip through JSON and rejects malformed messages', () => {
    expect(isPropertiesMessage(message(dataOf()))).toBe(true);
    expect(isPropertiesMessage(message(dataOf(['showStorage'])))).toBe(true);
    expect(
      isPropertiesMessage(
        message(
          withProperties({
            createdBy: null,
            dataPath: null,
            firstSnapshotTime: null,
            latestSnapshotTime: null,
            metadata: [{ key: 'a', value: 'b', scope: null, scopeId: null }],
          }),
        ),
      ),
    ).toBe(true);

    const { connection: _c, ...noConnection } = dataOf();
    const { actions: _a, ...noActions } = dataOf();
    const rejected: [string, unknown][] = [
      ['missing connection', message(noConnection)],
      ['unknown action', message({ ...dataOf(), actions: ['quit'] })],
      ['actions no list', message({ ...dataOf(), actions: 'showStorage' })],
      ['no actions', message(noActions)],
      ['no metadata', message(withProperties({ metadata: undefined }))],
      [
        'scope id as text',
        message(withProperties({ metadata: [{ key: 'a', value: 'b', scope: 'table', scopeId: '3' }] })),
      ],
      ['negative snapshot count', message(withProperties({ snapshotCount: -1 }))],
      ['encrypted as text', message(withProperties({ encrypted: 'no' }))],
      ['wrong type', { type: 'storage', data: dataOf() }],
      ['no type', { data: dataOf() }],
      ['no data', { type: 'properties' }],
      ['null', null],
      ['undefined', undefined],
      ['string', 'properties'],
      ['array', []],
    ];
    for (const [label, value] of rejected) expect(isPropertiesMessage(value), label).toBe(false);
  });

  it('takes the one action it knows with nothing besides it, and a view with the text of the filter', () => {
    expect(isPropertiesAction({ type: 'action', action: 'showStorage' })).toBe(true);
    expect(isPropertiesAction({ type: 'action', action: 'showStorage', connection: 'x' })).toBe(false);
    expect(isPropertiesAction({ type: 'action', action: 'aantje.removeConnection' })).toBe(false);
    expect(isPropertiesAction({ type: 'refresh' })).toBe(false);
    expect(isPropertiesView({ filter: '' })).toBe(true);
    expect(isPropertiesView({ filter: 'text' })).toBe(true);
    for (const bad of [{ filter: 4 }, {}, null, { filter: 'text', command: 'quit' }]) {
      expect(isPropertiesView(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(propertiesKind.message(dataOf())).toEqual({ type: 'properties', data: dataOf() });
  });
});
