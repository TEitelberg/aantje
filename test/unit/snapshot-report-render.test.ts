import { describe, expect, it } from 'vitest';
import { columnAt } from '../../src/snapshot-report/render';
import type { SnapshotReportView } from '../../src/snapshot-report/model';

const view = {
  lanes: [],
  omittedLanes: 0,
  points: [],
  transactions: [],
  columns: [
    { id: 4, time: '2026-01-01T00:00:00Z' },
    { id: 7, time: '2026-01-02T00:00:00Z' },
    { id: 9, time: '2026-01-10T00:00:00Z' },
  ],
} satisfies SnapshotReportView;

describe('columnAt', () => {
  it('rounds an x on the order axis to the nearest column and clamps it to the ends', () => {
    expect(columnAt(view, 'order', 0.4)).toBe(4);
    expect(columnAt(view, 'order', 0.6)).toBe(7);
    expect(columnAt(view, 'order', 5)).toBe(9);
    expect(columnAt(view, 'order', -3)).toBe(4);
  });

  it('picks the column with the nearest time on the time axis', () => {
    expect(columnAt(view, 'time', Date.parse('2026-01-03T00:00:00Z'))).toBe(7);
    expect(columnAt(view, 'time', Date.parse('2026-01-08T00:00:00Z'))).toBe(9);
    expect(columnAt(view, 'time', Date.parse('2025-12-01T00:00:00Z'))).toBe(4);
  });

  it('finds no column in an empty view', () => {
    expect(columnAt({ ...view, columns: [] }, 'order', 1)).toBeUndefined();
    expect(columnAt({ ...view, columns: [] }, 'time', 1)).toBeUndefined();
  });
});
