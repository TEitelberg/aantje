import { describe, expect, it } from 'vitest';
import { SIZE_BINS } from '../../src/catalog/queries/statistics';
import {
  comparePartitionValues,
  evenness,
  foldRange,
  growth,
  sizeHistogram,
} from '../../src/catalog/statistics';
import type { GrowthDelta } from '../../src/catalog/statistics';

describe('evenness', () => {
  it('is zero for equal partitions, follows the closed forms for uneven ones, and does not depend on the order', () => {
    expect(evenness([500, 500, 500, 500])).toEqual({ coefficientOfVariation: 0, gini: 0 });
    // 1, 1, 1, 97: mean 25, deviations -24, -24, -24, 72 -> variance 1728, CV = sqrt(1728) / 25
    const result = evenness([1, 1, 1, 97]);
    expect(result?.coefficientOfVariation).toBeCloseTo(Math.sqrt(1728) / 25, 12);
    // Gini = 2 * (1 + 2 + 3 + 4 * 97) / (4 * 100) - 5 / 4
    expect(result?.gini).toBeCloseTo((2 * 394) / 400 - 1.25, 12);
    expect(evenness([97, 1, 1, 1])).toEqual(result);
  });

  it('has nothing to compare with fewer than two partitions or without any bytes', () => {
    expect(evenness([])).toBeNull();
    expect(evenness([42])).toBeNull();
    expect(evenness([0, 0, 0])).toBeNull();
  });
});

describe('sizeHistogram', () => {
  it('fills in the empty bins, makes the bin edges halves of the largest file and rounds an edge up to its first whole byte', () => {
    expect(sizeHistogram(0, [])).toEqual([]);
    const bins = sizeHistogram(1024, [
      { bin: 1, files: 2, sizeBytes: 20 },
      { bin: SIZE_BINS - 1, files: 1, sizeBytes: 1024 },
    ]);
    expect(bins.map((bin) => bin.fromBytes)).toEqual([0, 8, 16, 32, 64, 128, 256, 512]);
    expect(bins.map((bin) => bin.toBytes)).toEqual([8, 16, 32, 64, 128, 256, 512, 1024]);
    expect(bins.map((bin) => bin.files)).toEqual([0, 2, 0, 0, 0, 0, 0, 1]);
    expect(bins[1]?.sizeBytes).toBe(20);
    expect(sizeHistogram(1000, [{ bin: 7, files: 1, sizeBytes: 1000 }]).map((bin) => bin.fromBytes)).toEqual([
      0, 8, 16, 32, 63, 125, 250, 500,
    ]);
  });
});

describe('growth', () => {
  const delta = (snapshot: number, files: number, sizeBytes: number, compaction = false): GrowthDelta => ({
    snapshot,
    time: `2026-01-${String(snapshot).padStart(2, '0')}T00:00:00.000Z`,
    files,
    sizeBytes,
    compaction,
  });

  it('adds up what each snapshot did, also when files leave', () => {
    const { points, merged } = growth([
      delta(1, 2, 200),
      delta(3, 1, 100),
      delta(4, -2, -150, true),
      delta(7, 1, 50),
    ]);
    expect(points.map((point) => [point.snapshot, point.files, point.sizeBytes, point.compaction])).toEqual([
      [1, 2, 200, false],
      [3, 3, 300, false],
      [4, 1, 150, true],
      [7, 2, 200, false],
    ]);
    expect(merged).toBe(false);
  });

  it('keeps every point up to the limit (500 by default), merges runs above it ending with the last snapshot, and keeps the mark of a merged compaction', () => {
    const ten = Array.from({ length: 10 }, (_, index) => delta(index + 1, 1, 10));
    expect(growth(ten, 10)).toMatchObject({ merged: false });
    expect(growth(ten, 10).points).toHaveLength(10);
    // Runs of two: the state after the last snapshot of each run.
    const merged = growth(ten, 9);
    expect(merged.merged).toBe(true);
    expect(merged.points.map((point) => [point.snapshot, point.files])).toEqual([
      [2, 2],
      [4, 4],
      [6, 6],
      [8, 8],
      [10, 10],
    ]);

    const long = Array.from({ length: 1001 }, (_, index) => delta(index + 1, 1, 10));
    expect(growth(long)).toMatchObject({ merged: true });
    expect(growth(long).points).toHaveLength(334);
    expect(growth(long).points.at(-1)).toMatchObject({ snapshot: 1001, files: 1001 });
    expect(growth(long.slice(0, 500)).merged).toBe(false);

    const compacted = [delta(1, 1, 1), delta(2, 0, 0, true), delta(3, 1, 1), delta(4, 1, 1)];
    expect(growth(compacted, 2).points.map((point) => [point.snapshot, point.compaction])).toEqual([
      [2, true],
      [4, false],
    ]);
  });
});

describe('comparePartitionValues', () => {
  it('orders by the first key, then by the second, puts NULL after every text and calls equal values equal', () => {
    const rows: (string | null)[][] = [
      [null, '1'],
      ['b', '0'],
      ['a', '2'],
      ['a', null],
      ['a', '1'],
    ];
    expect(rows.toSorted(comparePartitionValues)).toEqual([
      ['a', '1'],
      ['a', '2'],
      ['a', null],
      ['b', '0'],
      [null, '1'],
    ]);
    expect(comparePartitionValues(['a', null], ['a', null])).toBe(0);
  });
});

describe('foldRange', () => {
  it('orders the values of every type by its own rules, not as text, and has no order for the types without one', () => {
    // [type, a, b, sign of a compared with b]
    const orders: readonly [string, string, string, number][] = [
      ['int32', '9', '10', -1],
      ['int64', '-5', '3', -1],
      ['uint8', '9', '10', -1],
      ['uint16', '65535', '256', 1],
      ['uint32', '4294967295', '4294967294', 1],
      ['uint64', '18446744073709551615', '18446744073709551614', 1],
      ['int128', '170141183460469231731687303715884105727', '170141183460469231731687303715884105726', 1],
      ['float64', '10', '9.5', 1],
      ['float32', 'inf', '1e30', 1],
      ['float64', '-inf', '-1e300', -1],
      ['float64', 'infinity', '1e300', 1],
      ['float64', '-infinity', '-1e300', -1],
      ['decimal(10,2)', '10.25', '9.50', 1],
      ['decimal(10,2)', '-3.10', '-3.09', -1],
      ['decimal(18,4)', '1.5', '1.50', 0],
      ['date', '2025-12-31', '2026-01-01', -1],
      ['date', 'infinity', '2026-01-01', 1],
      ['date', '-infinity', '0001-01-01', -1],
      ['time', '09:59:59', '10:00:00', -1],
      ['timestamp', '2026-01-01 10:00:00', '2026-01-01 10:00:00.5', -1],
      ['timestamp', '-infinity', '2026-01-01 10:00:00', -1],
      ['timestamp', 'infinity', '2026-01-01 10:00:00', 1],
      ['timestamp_ns', '2026-01-01 10:00:00.000000001', '2026-01-01 10:00:00.000000002', -1],
      ['timestamptz', '2026-01-01 11:00:00+02', '2026-01-01 10:00:00+00', -1],
      ['timestamptz', 'infinity', '2026-01-01 10:00:00+00', 1],
      ['timestamptz', '-infinity', '2026-01-01 10:00:00+00', -1],
      ['timestamptz', 'infinity', 'infinity', 0],
      ['varchar', 'Z', 'a', -1],
      ['varchar', '😀', '～', 1],
      ['boolean', 'false', 'true', -1],
      ['boolean', '0', '1', -1],
      ['uuid', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', -1],
      ['json', '{"a":2}', '{"a":10}', 1],
    ];
    for (const [type, a, b, expected] of orders) {
      const range = foldRange(type, [
        { min: a, max: a },
        { min: b, max: b },
      ]);
      // The first of two equal values stays.
      expect(range, `${type}: ${a} vs ${b}`).toEqual(
        expected < 0 ? { min: a, max: b } : expected > 0 ? { min: b, max: a } : { min: a, max: a },
      );
    }
    for (const type of ['blob', 'interval', 'struct', 'list', 'map', 'geometry', 'something_new']) {
      expect(foldRange(type, [{ min: 'a', max: 'b' }]), type).toEqual({ min: null, max: null });
    }
  });

  it('takes the smallest minimum and the largest maximum of the files and ignores files without a value', () => {
    expect(
      foldRange('int64', [
        { min: '9', max: '9' },
        { min: '10', max: '100' },
        { min: '2', max: '30' },
      ]),
    ).toEqual({ min: '2', max: '100' });
    expect(
      foldRange('int32', [
        { min: null, max: null },
        { min: '4', max: '7' },
      ]),
    ).toEqual({ min: '4', max: '7' });
    expect(foldRange('int32', [{ min: null, max: null }])).toEqual({ min: null, max: null });
    expect(foldRange('int32', [])).toEqual({ min: null, max: null });
  });

  it('skips a value that is no number or NaN instead of failing the table, and lets an infinite timestamp end the range', () => {
    expect(
      foldRange('int32', [
        { min: 'oops', max: '3' },
        { min: '5', max: '1.5e3' },
      ]),
    ).toEqual({ min: '5', max: '3' });
    expect(
      foldRange('timestamptz', [
        { min: 'not a time', max: 'not a time' },
        { min: '2026-01-01 10:00:00+00', max: '2026-01-01 10:00:00+00' },
      ]),
    ).toEqual({ min: '2026-01-01 10:00:00+00', max: '2026-01-01 10:00:00+00' });
    expect(
      foldRange('float64', [
        { min: 'nan', max: 'nan' },
        { min: '-2.5', max: 'inf' },
      ]),
    ).toEqual({ min: '-2.5', max: 'inf' });
    expect(
      foldRange('timestamptz', [
        { min: '2026-01-01 10:00:00+00', max: '2026-01-02 10:00:00+00' },
        { min: '-infinity', max: 'infinity' },
      ]),
    ).toEqual({ min: '-infinity', max: 'infinity' });
  });
});
