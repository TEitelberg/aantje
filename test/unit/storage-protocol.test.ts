import { describe, expect, it } from 'vitest';
import { planStorageAction } from '../../src/storage-report/actions';
import { storageKind } from '../../src/storage-report/kind';
import type { StorageData } from '../../src/storage-report/model';
import { isStorageAction, isStorageMessage, isStorageView } from '../../src/storage-report/protocol';
import type { StorageAction } from '../../src/storage-report/protocol';
import { scriptTarget } from '../../src/script-target';
import { maintenanceOf } from '../../src/maintenance';
import { isShellRequest } from '../../src/shell/protocol';
import { historyStorage, sampleStorage } from './storage-support';

/** What the page and the extension accept from each other, after the trip through JSON that a webview message makes. */
const message = (data: unknown): unknown => JSON.parse(JSON.stringify({ type: 'storage', data }));

describe('the data that the Storage page accepts', () => {
  it('accepts the storage of a real catalog and a made-up one', async () => {
    expect(isStorageMessage(message(await historyStorage()))).toBe(true);
    expect(isStorageMessage(message(sampleStorage()))).toBe(true);
    expect(isStorageMessage(message(sampleStorage({ growthMerged: true, tables: [], tableCount: 0 })))).toBe(
      true,
    );
    const base = sampleStorage();
    const withoutPath = {
      ...base,
      storage: {
        ...base.storage,
        dataPath: null,
        scheduledForDeletion: { count: 0, oldestScheduledAt: null, split: null },
      },
      growth: [{ ...base.growth[0], time: null }],
    };
    // A catalog without a data path, without scheduled files and with a growth point of an expired snapshot.
    expect(isStorageMessage(message(withoutPath))).toBe(true);
  });

  it('rejects malformed storage, a message of another type and what is no message', () => {
    const rows: [string, (data: StorageData) => unknown][] = [
      ['a missing connection', ({ connection: _c, ...rest }) => rest],
      ['a snapshot as text', (data) => ({ ...data, snapshot: '12' })],
      ['a negative number of rows', (data) => ({ ...data, rows: -1 })],
      ['no time of the read', ({ readAt: _r, ...rest }) => rest],
      ['approximate as false', (data) => ({ ...data, approximate: false })],
      ['tables that are no list', (data) => ({ ...data, tables: 'events' })],
      [
        'a table without its schema',
        (data) => ({ ...data, tables: [{ ...data.tables[0], schema: undefined }] }),
      ],
      [
        'a table with files as a fraction',
        (data) => ({ ...data, tables: [{ ...data.tables[0], files: 1.5 }] }),
      ],
      [
        'a growth point without files',
        (data) => ({ ...data, growth: [{ ...data.growth[0], files: undefined }] }),
      ],
      [
        'storage without the totals of the delete files',
        (data) => ({ ...data, storage: { ...data.storage, deleteFiles: 3 } }),
      ],
      ['a data path as a number', (data) => ({ ...data, storage: { ...data.storage, dataPath: 7 } })],
      [
        'a scheduled count as text',
        (data) => ({
          ...data,
          storage: { ...data.storage, scheduledForDeletion: { count: '2', oldestScheduledAt: null } },
        }),
      ],
      ['the size of small files as text', (data) => ({ ...data, smallFileBytes: '16' })],
      [
        'a time of the oldest scheduled file as a number',
        (data) => ({
          ...data,
          storage: { ...data.storage, scheduledForDeletion: { count: 2, oldestScheduledAt: 5 } },
        }),
      ],
    ];
    for (const [name, change] of rows) {
      expect(isStorageMessage(message(change(sampleStorage()))), name).toBe(false);
    }
    // A message counts only when its type is storage.
    expect(isStorageMessage({ type: 'properties', data: sampleStorage() })).toBe(false);
    expect(isStorageMessage({ data: sampleStorage() })).toBe(false);
    for (const value of [
      null,
      undefined,
      'storage',
      7,
      [],
      {},
      { type: 'snapshotReport', data: {} },
      { type: 'storage' },
    ]) {
      expect(isStorageMessage(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('the requests that the extension accepts from the Storage page', () => {
  it('takes the declared actions with exactly their fields, and rejects the rest', () => {
    for (const request of [
      { type: 'action', action: 'showStatistics', table: 3 },
      { type: 'action', action: 'revealTable', table: 0 },
      { type: 'action', action: 'scriptMerge', table: 3 },
      { type: 'action', action: 'scriptRewrite', table: 3 },
      { type: 'action', action: 'scriptCleanup' },
      { type: 'action', action: 'scriptExpire' },
      { type: 'action', action: 'showProperties' },
    ]) {
      expect(isStorageAction(request), JSON.stringify(request)).toBe(true);
    }
    const rows: [string, unknown][] = [
      ['an action of a table without the table', { type: 'action', action: 'scriptMerge' }],
      ['a table as text', { type: 'action', action: 'scriptMerge', table: '3' }],
      ['a negative table', { type: 'action', action: 'showStatistics', table: -1 }],
      ['a table as a fraction', { type: 'action', action: 'revealTable', table: 1.5 }],
      ['a table on an action of the lake', { type: 'action', action: 'scriptCleanup', table: 3 }],
      ['a table on the expiry script', { type: 'action', action: 'scriptExpire', table: 3 }],
      ['a table on the Properties action', { type: 'action', action: 'showProperties', table: 3 }],
      [
        'a field that nobody declared',
        { type: 'action', action: 'scriptMerge', table: 3, sql: 'DROP TABLE x' },
      ],
      ['a command id as the action', { type: 'action', action: 'aantje.removeConnection' }],
      ['an action of another report', { type: 'action', action: 'showCatalog', snapshot: 3 }],
      ['an action that is inherited', { type: 'action', action: 'toString' }],
      ['a refresh', { type: 'refresh' }],
      ['free text', 'scriptCleanup'],
    ];
    for (const [name, request] of rows) {
      expect(isStorageAction(request), name).toBe(false);
    }
  });

  it('takes the filter as the view of Open as Markdown, and ignores a view of another shape', () => {
    expect(isStorageView({ filter: '' })).toBe(true);
    expect(isStorageView({ filter: 'events' })).toBe(true);
    expect(isStorageView({ filter: 4 })).toBe(false);
    expect(isStorageView({})).toBe(false);
    expect(isStorageView(null)).toBe(false);
    expect(isStorageView({ filter: 'events', sql: 'DROP TABLE x' })).toBe(false);
    expect(isShellRequest({ type: 'markdown', view: { filter: 'a', extra: 1 } }, isStorageView)).toBe(false);
    expect(isShellRequest({ type: 'markdown', view: { filter: 'a' } }, isStorageView)).toBe(true);
    expect(isShellRequest({ type: 'markdown', view: { filter: 4 } }, isStorageView)).toBe(false);
  });

  it('builds the message of its kind from the data, and writes its document from the data and the view', () => {
    const data = sampleStorage();

    expect(storageKind.viewType).toBe('aantje.storage');
    expect(storageKind.message(data)).toEqual({ type: 'storage', data });
    expect(storageKind.toMarkdown(data, { filter: 'customers' })).not.toEqual(
      storageKind.toMarkdown(data, undefined),
    );
  });
});

describe('what an action does', () => {
  const data = sampleStorage();
  const request = (action: string, table?: number) =>
    ({ type: 'action', action, ...(table === undefined ? {} : { table }) }) as StorageAction;

  it('names the table of the data for the actions of a table', () => {
    expect(planStorageAction(data, request('showStatistics', 2))).toEqual({
      action: 'showStatistics',
      table: data.tables[1],
    });
    expect(planStorageAction(data, request('revealTable', 1))).toEqual({
      action: 'revealTable',
      table: data.tables[0],
    });
    expect(planStorageAction(data, request('scriptMerge', 3))).toEqual({
      action: 'script',
      kind: 'merge',
      table: data.tables[2],
    });
    expect(planStorageAction(data, request('scriptRewrite', 1))).toEqual({
      action: 'script',
      kind: 'rewrite',
      table: data.tables[0],
    });
  });

  it('refuses a table that the data did not hold, also one that only the lake has', () => {
    expect(planStorageAction(data, request('showStatistics', 99))).toBeUndefined();
    expect(planStorageAction(data, request('scriptMerge', 99))).toBeUndefined();
    expect(
      planStorageAction({ ...data, tables: [], tableCount: 40 }, request('revealTable', 1)),
    ).toBeUndefined();
    expect(planStorageAction(data, request('scriptRewrite'))).toBeUndefined();
  });

  it('plans the actions of the lake without a table', () => {
    expect(planStorageAction(data, request('scriptCleanup'))).toEqual({ action: 'script', kind: 'cleanup' });
    expect(planStorageAction(data, request('scriptExpire'))).toEqual({ action: 'script', kind: 'expire' });
    expect(planStorageAction(data, request('showProperties'))).toEqual({ action: 'showProperties' });
  });

  describe('the maintenance scripts', () => {
    const tree = { state: () => ({ snapshot: 'latest' as const }) } as unknown as Parameters<
      typeof maintenanceOf
    >[0];
    const script = (plan: ReturnType<typeof planStorageAction>) => {
      if (plan?.action !== 'script') throw new Error('not a script');
      const { kind, ref } = scriptTarget('lake-1', plan);
      return maintenanceOf(tree, kind, ref)?.split('\n');
    };

    it('are the scripts of the Maintenance menu, for the table of the report', () => {
      const merge = script(planStorageAction(data, request('scriptMerge', 1)));
      const rewrite = script(planStorageAction(data, request('scriptRewrite', 1)));

      expect(merge?.filter((line) => line.startsWith('CALL '))).toEqual([
        "CALL ducklake_merge_adjacent_files('lake', 'events', schema => 'shop');",
      ]);
      expect(rewrite?.filter((line) => line.startsWith('CALL '))).toEqual([
        "CALL ducklake_rewrite_data_files('lake', 'events', schema => 'shop');",
      ]);
    });

    it('quote a name with a quote, so that the name cannot leave the string', () => {
      const odd = sampleStorage({
        tables: [{ ...sampleStorage().tables[0]!, id: 7, schema: "my'schema", name: "ev'ents" }],
      });

      expect(
        script(planStorageAction(odd, request('scriptMerge', 7)))?.filter((line) => line.startsWith('CALL ')),
      ).toEqual(["CALL ducklake_merge_adjacent_files('lake', 'ev''ents', schema => 'my''schema');"]);
    });

    it('start with a dry run for the lake, and keep the real call commented out', () => {
      const cleanup = script(planStorageAction(data, request('scriptCleanup')));
      const expire = script(planStorageAction(data, request('scriptExpire')));

      expect(cleanup?.filter((line) => line.includes('CALL '))).toEqual([
        "CALL ducklake_cleanup_old_files('lake', dry_run => true);",
        "-- CALL ducklake_cleanup_old_files('lake');",
        "-- CALL ducklake_cleanup_old_files('lake', cleanup_all => true);",
      ]);
      expect(expire?.filter((line) => line.includes('CALL '))).toEqual([
        "CALL ducklake_expire_snapshots('lake', older_than => now() - INTERVAL 30 DAY, dry_run => true);",
        "-- CALL ducklake_expire_snapshots('lake', older_than => now() - INTERVAL 30 DAY);",
      ]);
    });
  });
});
