import { describe, expect, it } from 'vitest';
import type { GridColumn, GridValue } from '../../src/data/types';
import { sortRows } from '../../src/grid/model';

// aantje.sql.maxRows may be raised to 1,000,000 rows, and the sort runs in the webview. It must read each value once,
// not once per comparison: that took 5 s for a million integers and 8 s for decimals. Counting the reads keeps the
// test independent of the speed of the machine.
describe('sorting a large result', () => {
  it('reads every value of the sorted column once, not once per comparison, and orders them by value', () => {
    const rows = 5000;
    let reads = 0;
    // A value that counts how often the sort turns it into text or a number.
    const counted = (n: number): GridValue =>
      ({
        toString: () => {
          reads++;
          return `${n}.250`;
        },
        valueOf: () => {
          reads++;
          return n + 0.25;
        },
      }) as unknown as GridValue;
    const input = Array.from({ length: rows }, (_, index) => [counted((index * 7919) % rows)]);
    const column = { name: 'c', type: 'DECIMAL(18,3)', kind: 'number' } as GridColumn;

    const sorted = sortRows(input, [column], { column: 0, direction: 'asc' });

    // One text and one number per row; per comparison it would be about 2 × 5000 × log2(5000) ≈ 120,000.
    expect(reads).toBeLessThanOrEqual(2 * rows);
    expect(sorted.map((row) => String(row[0]))).toEqual(Array.from({ length: rows }, (_, n) => `${n}.250`));
  });
});
