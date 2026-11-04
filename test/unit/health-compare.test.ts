import { describe, expect, it } from 'vitest';
import type { StoredFile } from '../../src/catalog/model';
import { compareStorage } from '../../src/health/storage-checks';

const NOW = new Date('2026-10-31T12:00:00.000Z');
const OLD = NOW.getTime() - 3 * 86_400_000;

const stored = (id: number, location: string, extra: Partial<StoredFile> = {}): StoredFile => ({
  kind: 'data',
  id,
  tableId: 1,
  schema: 'main',
  table: 't',
  beginSnapshot: 1,
  endSnapshot: null,
  location,
  sizeBytes: 10,
  records: 1,
  encrypted: false,
  format: 'parquet',
  ...extra,
});

const listed = (key: string, size = 10): { key: string; size: number; modified: number } => ({
  key,
  size,
  modified: OLD,
});

const compare = (input: {
  files: StoredFile[];
  listing: { key: string; size: number; modified: number }[];
  caseInsensitive?: boolean;
  cutAfter?: string;
  shared?: string[];
  scheduled?: string[];
  directory?: string;
}) =>
  compareStorage({
    scheduled: [],
    shared: [],
    directory: '/lake/',
    scope: { kind: 'lake' },
    names: new Map(),
    latest: 9,
    now: NOW,
    limit: 50,
    caseInsensitive: false,
    ...input,
  });

const ids = (result: ReturnType<typeof compare>): string[] => result.findings.map((item) => item.id);

describe('comparing the files of the catalog with the listing of the store', () => {
  it('tells keys apart by case when the store does', () => {
    const result = compare({
      files: [stored(1, '/lake/main/t/A.parquet')],
      listing: [listed('/lake/main/t/a.parquet')],
    });

    expect(ids(result)).toEqual([
      'storage.file-missing:data:1',
      'storage.file-orphaned:/lake/main/t/a.parquet',
    ]);
  });

  it('does not tell keys apart by case on a file system that does not, and not by slash or leading ./', () => {
    const result = compare({
      files: [stored(1, '/lake/main/t/A.parquet'), stored(2, '/lake/main\\t\\b.parquet')],
      listing: [listed('/lake/main/t/a.parquet'), listed('/lake/main/t/B.parquet')],
      caseInsensitive: true,
    });

    expect(result.findings).toEqual([]);
    expect(result.notChecked).toBe(0);
  });

  it('finds the files of an Azure DuckLake, which DuckDB lists with the container behind the account', () => {
    // As an Azure DuckLake showed it: the catalog has container@account, the listing account/container.
    const account = 'ducklakeb3d72ea1bd464.dfs.core.windows.net';
    const written = (name: string) => `abfss://lake@${account}/data/gold/fact_sales/${name}`;
    const result = compare({
      files: [stored(1, written('a.parquet')), stored(2, written('b.parquet'))],
      listing: [
        listed(`abfss://${account}/lake/data/gold/fact_sales/a.parquet`),
        listed(`abfss://${account}/lake/data/gold/fact_sales/b.parquet`),
        listed(`abfss://${account}/lake/data/gold/fact_sales/c.parquet`),
      ],
      directory: `abfss://lake@${account}/data/gold/fact_sales/`,
    });

    // The two files of the catalog are found; only the third, which no row names, is left over.
    expect(ids(result)).toEqual([
      `storage.file-orphaned:abfss://${account}/lake/data/gold/fact_sales/c.parquet`,
    ]);
    expect(result.notChecked).toBe(0);
  });

  it('says that the store holds nothing when the catalog needs files and the listing is empty', () => {
    const result = compare({ files: [stored(1, '/lake/main/t/a.parquet')], listing: [] });

    expect(ids(result)).toEqual(['storage.file-missing:data:1', 'storage.nothing-found']);
  });

  it('does not say that the store holds nothing when only files of older snapshots are gone', () => {
    const result = compare({
      files: [stored(1, '/lake/main/t/a.parquet', { endSnapshot: 5 })],
      listing: [],
    });

    expect(result.findings.map((item) => [item.id, item.severity])).toEqual([
      ['storage.file-missing:data:1', 'warning'],
    ]);
  });

  it('compares the file at the last key of a cut listing and counts the files behind it', () => {
    const result = compare({
      files: [
        stored(1, '/lake/main/t/a.parquet'),
        stored(2, '/lake/main/t/b.parquet'),
        stored(3, '/lake/main/t/c.parquet'),
      ],
      listing: [listed('/lake/main/t/a.parquet')],
      cutAfter: '/lake/main/t/b.parquet',
    });

    // a is in the listing; b is the last key that the listing reaches and is not in it; c is behind the cut.
    expect(ids(result)).toEqual(['storage.file-missing:data:2']);
    expect(result.notChecked).toBe(1);
  });

  it('knows the files of other tables in the directory (a dropped table of the same name): they are no orphans', () => {
    const result = compare({
      files: [stored(1, '/lake/main/t/new.parquet')],
      listing: [
        listed('/lake/main/t/new.parquet'),
        listed('/lake/main/t/dropped.parquet'),
        listed('/lake/main/t/stray.parquet'),
      ],
      shared: ['/lake/main/t/dropped.parquet'],
      directory: '/lake/main/t',
    });

    expect(ids(result)).toEqual(['storage.file-orphaned:/lake/main/t/stray.parquet']);
  });

  it('knows the files that are scheduled for deletion: they are no orphans', () => {
    const result = compare({
      files: [],
      listing: [listed('/lake/main/t/replaced.parquet'), listed('/lake/main/t/stray.parquet')],
      scheduled: ['/lake/main/t/replaced.parquet'],
    });

    expect(ids(result)).toEqual(['storage.file-orphaned:/lake/main/t/stray.parquet']);
  });

  it('counts a file outside the listed directory as not checked', () => {
    const result = compare({
      files: [stored(1, '/elsewhere/a.parquet')],
      listing: [listed('/lake/x.parquet')],
    });

    expect(result.notChecked).toBe(1);
    expect(ids(result)).toEqual(['storage.file-orphaned:/lake/x.parquet']);
  });
});
