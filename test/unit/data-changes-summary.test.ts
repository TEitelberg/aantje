import { describe, expect, it } from 'vitest';
import { rowKindOf, summariseChanges, summaryLine } from '../../src/data/changes';
import type { ChangeGroup } from '../../src/data/changes';

const group = (snapshot: number, changeType: string, rows: number): ChangeGroup => ({
  snapshot,
  changeType,
  rows,
});

describe('rowKindOf', () => {
  it('names the four rows of table_changes, the pre-image before and the post-image after, and has no kind for an unknown type', () => {
    expect(['insert', 'delete', 'update_preimage', 'update_postimage'].map(rowKindOf)).toEqual([
      'insert',
      'delete',
      'update-before',
      'update-after',
    ]);
    for (const unknown of ['upsert', '', null, 3]) {
      expect(rowKindOf(unknown), JSON.stringify(unknown)).toBeUndefined();
    }
  });
});

describe('summariseChanges', () => {
  it('counts an update once (its post-image), adds the types of one snapshot, sorts the snapshots and takes range and flag as given', () => {
    const summary = summariseChanges(
      [
        group(18, 'delete', 1),
        group(17, 'update_postimage', 2),
        group(16, 'insert', 4),
        group(17, 'update_preimage', 2),
        group(18, 'insert', 3),
      ],
      { from: 15, to: 18 },
      true,
    );

    expect(summary).toEqual({
      from: 15,
      to: 18,
      counts: { insert: 7, update: 2, delete: 1 },
      total: 10,
      unknown: 0,
      snapshots: [
        { snapshot: 16, insert: 4, update: 0, delete: 0 },
        { snapshot: 17, insert: 0, update: 2, delete: 0 },
        { snapshot: 18, insert: 3, update: 0, delete: 1 },
      ],
      truncated: true,
    });
  });

  it('is empty for no changes, and counts the rows of an unknown change type (a newer DuckLake) apart, outside the total and the snapshots', () => {
    expect(summariseChanges([], { from: 1, to: 2 }, false)).toEqual({
      from: 1,
      to: 2,
      counts: { insert: 0, update: 0, delete: 0 },
      total: 0,
      unknown: 0,
      snapshots: [],
      truncated: false,
    });
    expect(
      summariseChanges(
        [group(16, 'insert', 2), group(16, 'upsert', 3), group(17, 'merge', 1)],
        { from: 15, to: 17 },
        false,
      ),
    ).toEqual({
      from: 15,
      to: 17,
      counts: { insert: 2, update: 0, delete: 0 },
      total: 2,
      unknown: 4,
      snapshots: [{ snapshot: 16, insert: 2, update: 0, delete: 0 }],
      truncated: false,
    });
  });
});

describe('summaryLine', () => {
  const line = (groups: ChangeGroup[], from: number, to: number, truncated = false, shown = 0): string =>
    summaryLine(summariseChanges(groups, { from, to }, truncated), shown);

  it('names the counts, the total and the snapshots in the order insert, update, delete, an update as one change, a single change in the singular', () => {
    expect(
      line(
        [group(16, 'insert', 4), group(17, 'update_preimage', 1), group(17, 'update_postimage', 1)],
        15,
        17,
      ),
    ).toBe('4 inserted, 1 updated (5 changes) after @15 until @17 · @16 +4 · @17 ~1');
    expect(line([group(18, 'delete', 1)], 17, 18)).toBe('1 deleted (1 change) after @17 until @18 · @18 −1');
    expect(
      line(
        [
          group(5, 'delete', 1),
          group(5, 'update_postimage', 1),
          group(5, 'update_preimage', 1),
          group(5, 'insert', 1),
        ],
        4,
        5,
      ),
    ).toBe('1 inserted, 1 updated, 1 deleted (3 changes) after @4 until @5 · @5 +1 ~1 −1');
    expect(line([], 18, 22)).toBe('No changes after @18 until @22.');
  });

  it('names at most eight snapshots and counts the rest, says how many unknown rows were left out and how many rows are shown when the grid is cut (an update is two rows)', () => {
    const groups = Array.from({ length: 11 }, (_, i) => group(i + 1, 'insert', 1));
    expect(line(groups, 0, 11)).toBe(
      '11 inserted (11 changes) after @0 until @11 · @1 +1 · @2 +1 · @3 +1 · @4 +1 · @5 +1 · @6 +1 · @7 +1 · @8 +1 · and 3 more snapshots',
    );
    expect(line(groups.slice(0, 9), 0, 9)).toMatch(/and 1 more snapshot$/);

    expect(line([group(16, 'insert', 4), group(16, 'upsert', 1)], 15, 16)).toBe(
      '4 inserted (4 changes) after @15 until @16 · @16 +4 · 1 row of an unknown change type left out',
    );
    expect(line([group(16, 'upsert', 2)], 15, 16)).toBe(
      'No known changes after @15 until @16 · 2 rows of an unknown change type left out',
    );

    expect(
      line(
        [group(2, 'insert', 1000), group(3, 'update_preimage', 300), group(3, 'update_postimage', 300)],
        1,
        3,
        true,
        1000,
      ),
    ).toBe(
      '1000 inserted, 300 updated (1300 changes) after @1 until @3 · @2 +1000 · @3 ~300 · showing the first 1000 of 1600 rows',
    );
  });
});
