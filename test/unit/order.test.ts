import { describe, expect, it } from 'vitest';
import { collator, compareText } from '../../src/order';

describe('the order of text and names', () => {
  it('compareText is the code-unit order: capitals first, a prefix before its extension, digits not read as numbers', () => {
    expect([compareText('a', 'b'), compareText('b', 'a'), compareText('a', 'a')]).toEqual([-1, 1, 0]);
    expect(['b', 'B', 'a', 'ab', 'A', ''].toSorted(compareText)).toEqual(['', 'A', 'B', 'a', 'ab', 'b']);
    expect(['table9', 'table10'].toSorted(compareText)).toEqual(['table10', 'table9']);
  });

  it('the collator for names ignores case and compares numbers by value', () => {
    expect(['table10', 'Table2', 'table1', 'TABLE3'].toSorted(collator.compare)).toEqual([
      'table1',
      'Table2',
      'TABLE3',
      'table10',
    ]);
    expect(collator.compare('Orders', 'orders')).toBe(0);
  });
});
