import { describe, expect, it } from 'vitest';
import { boundsOf, restoredRange } from '../../src/shell/range-state';

describe('the range of an earlier page for the snapshots read now', () => {
  const was = { first: 10, last: 50 };

  it('moves an end that sat at the end of the earlier snapshots with the new snapshots', () => {
    expect(restoredRange({ from: 10, to: 50 }, was, { first: 4, last: 57 })).toEqual({ from: 4, to: 57 });
  });

  it('keeps an end that the user moved, inside the snapshots', () => {
    expect(restoredRange({ from: 20, to: 40 }, was, { first: 4, last: 57 })).toEqual({ from: 20, to: 40 });
    expect(restoredRange({ from: 20, to: 40 }, was, { first: 30, last: 35 })).toEqual({ from: 30, to: 35 });
  });

  it('treats the two ends on their own', () => {
    expect(restoredRange({ from: 20, to: 50 }, was, { first: 4, last: 57 })).toEqual({ from: 20, to: 57 });
  });

  it('takes the bounds from the first and the last snapshot, or zero when there is none', () => {
    expect(boundsOf([{ id: 3 }, { id: 5 }, { id: 9 }])).toEqual({ first: 3, last: 9 });
    expect(boundsOf([])).toEqual({ first: 0, last: 0 });
  });
});
