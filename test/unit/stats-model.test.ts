import { describe, expect, it } from 'vitest';
import type { PartitionStatistics, TableStatistics } from '../../src/catalog/model';
import {
  statisticsColumnRows,
  evennessSeverity,
  evennessText,
  growthLabel,
  growthNotes,
  growthTime,
  overviewCards,
  partitionLabel,
  partitioningNotes,
  partitioningText,
} from '../../src/stats/model';
import { historyStatistics } from './stats-support';

const all = await historyStatistics();

const column = (nullRatio: number | null, type = 'varchar', min: string | null = null, max = min) => ({
  id: 1,
  path: ['c'],
  type,
  nullable: true,
  nullRatio,
  min,
  max,
});

const figures = (stats: TableStatistics) =>
  overviewCards(stats).map(({ value, severity }) => [value, severity]);

describe('the statistics of a table', () => {
  it('judges the null share of a column: ok below 50 %, a warning from 50 %, an error when all are NULL', () => {
    const cases: [number | null, string][] = [
      [null, 'ok'],
      [0, 'ok'],
      [0.49, 'ok'],
      [0.5, 'warning'],
      [0.99, 'warning'],
      [1, 'error'],
    ];
    for (const [ratio, severity] of cases) {
      expect(statisticsColumnRows([column(ratio)])[0]?.severity, String(ratio)).toBe(severity);
    }
    expect(statisticsColumnRows([column(0.125)])[0]?.nullText).toContain('12.5');
    expect(statisticsColumnRows([column(1 / 3)])[0]?.nullText).toContain('33.3');
  });

  it('gives the key figures: counts, sizes, the delete files, an approximate row count, and dashes without files', () => {
    expect(figures(all.events)).toEqual([
      ['9', 'ok'],
      ['6.2 KB', 'ok'],
      ['52', 'ok'],
      ['0', 'ok'],
      ['705.4 B', 'ok'],
      ['100 %', 'warning'],
    ]);
    const customers = overviewCards(all.customers);
    expect(customers[3]?.value).toBe('1');
    expect(customers[1]).toMatchObject({ value: '2.9 KB', detail: '2 KB data, 954 B delete files' });
    // the average counts the data files only: 2006 bytes over 4 files, not the 2960 of data and delete files
    expect(customers[4]?.value).toBe('501.5 B');
    expect(overviewCards(all.logMerged)[2]?.value).toBe('~4');
    expect(figures(all.notes)).toEqual([
      ['0', 'ok'],
      ['0 B', 'ok'],
      ['0', 'ok'],
      ['0', 'ok'],
      ['–', 'ok'],
      ['–', 'ok'],
    ]);
  });

  it('warns about small files from half of at least five files', () => {
    const cases: [number, number, string][] = [
      [4, 4, 'ok'],
      [5, 5, 'warning'],
      [10, 4, 'ok'],
      [10, 5, 'warning'],
      [100, 0, 'ok'],
      [0, 0, 'ok'],
    ];
    for (const [files, smallFiles, severity] of cases) {
      const card = overviewCards({ ...all.events, files, smallFiles }).at(-1);
      expect(card?.severity, `${files}/${smallFiles}`).toBe(severity);
    }
  });

  it('shows the whole path of a nested column, a dash for nothing, "" for empty text and true/false for 0/1 booleans', () => {
    const rows = statisticsColumnRows([
      {
        id: 1,
        path: ['customer', 'name'],
        type: 'varchar',
        nullable: true,
        nullRatio: 1 / 3,
        min: 'a',
        max: null,
      },
      { id: 2, path: ['id'], type: 'int32', nullable: false, nullRatio: null, min: null, max: null },
    ]);
    expect(rows.map((row) => [row.name, row.nullable, row.nullRatio, row.min, row.max])).toEqual([
      ['customer.name', 'yes', 1 / 3, 'a', '–'],
      ['id', 'no', null, '–', '–'],
    ]);
    const typed = statisticsColumnRows([
      column(0, 'varchar', '', 'b'),
      column(0, 'boolean', '0', '1'),
      column(0, 'boolean', 'true', 'false'),
      column(0, 'int32', '0', '1'),
    ]);
    expect(typed.map((row) => [row.min, row.max])).toEqual([
      ['""', 'b'],
      ['false', 'true'],
      ['true', 'false'],
      ['0', '1'],
    ]);
  });

  it('names partition keys with their transform, judges evenness from a Gini of 0.5, and counts what is not shown', () => {
    const partitioning = all.events.partitioning as PartitionStatistics;
    expect(partitioningText(partitioning)).toBe('kind, month(ts)');
    const withKey = (transform: string): PartitionStatistics => ({
      ...partitioning,
      partitioning: {
        ...partitioning.partitioning,
        columns: [{ columnId: 1, path: ['a', 'b'], transform }],
      },
    });
    expect(partitioningText(withKey('bucket(4)'))).toBe('bucket(4)(a.b)');
    expect(partitioningText(withKey('identity'))).toBe('a.b');
    expect(partitionLabel(['click', '3'])).toBe('click / 3');
    expect(partitionLabel([null])).toBe('NULL');

    const at = (gini: number): PartitionStatistics => ({
      ...partitioning,
      evenness: { coefficientOfVariation: 2, gini },
    });
    expect(evennessSeverity(partitioning)).toBe('ok');
    expect(evennessSeverity(at(0.49))).toBe('ok');
    expect(evennessSeverity(at(0.5))).toBe('warning');
    expect(evennessText(at(0.8))).toContain('0.80');
    expect(evennessText({ ...partitioning, evenness: null })).toBeUndefined();
    expect(evennessSeverity({ ...partitioning, evenness: null })).toBe('ok');

    expect(partitioningNotes(partitioning)).toHaveLength(1);
    expect(partitioningNotes(partitioning)[0]).toContain('5');
    const rest = { partitions: 10, files: 12, sizeBytes: 2048, rows: 7 };
    expect(partitioningNotes({ ...partitioning, earlierFiles: 0, rest, partial: true })).toHaveLength(2);
    expect(partitioningNotes({ ...partitioning, earlierFiles: 0 })).toEqual([]);
  });

  it('labels a growth point by its snapshot with its time, notes a merged history, and knows an expired time', () => {
    const [point] = all.log.growth;
    expect(point && growthLabel(point)).toBe('@51');
    expect(point && growthTime(point)).toBe('2026-10-30 12:43:34 UTC');
    expect(point && growthTime({ ...point, time: null })).not.toBe(point && growthTime(point));
    expect(growthNotes({ ...all.log, growthMerged: true })).toHaveLength(growthNotes(all.log).length + 1);
  });
});
