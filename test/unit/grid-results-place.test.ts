import { describe, expect, it } from 'vitest';
import { parseLayout, resultsPlace } from '../../src/grid/results-place';
import type { EditorLayout, ResultsPlace } from '../../src/grid/results-place';

/** Layouts as VS Code reports them (the presets of "View: Editor Layout" and a layout that was split by hand). */
const SINGLE: EditorLayout = { orientation: 0, groups: [{}] };
const TWO_COLUMNS: EditorLayout = { orientation: 0, groups: [{}, {}] };
const TWO_ROWS: EditorLayout = { orientation: 1, groups: [{}, {}] };
const THREE_ROWS: EditorLayout = { orientation: 1, groups: [{}, {}, {}] };
const TWO_ROWS_RIGHT: EditorLayout = { orientation: 0, groups: [{}, { groups: [{}, {}] }] };
const TWO_ROWS_ABOVE: EditorLayout = { orientation: 1, groups: [{ groups: [{}, {}] }, {}] };
const TWO_STACKS: EditorLayout = { orientation: 0, groups: [{ groups: [{}, {}] }, { groups: [{}, {}] }] };
const NESTED: EditorLayout = { orientation: 1, groups: [{ groups: [{}, { groups: [{}, {}] }] }, {}] };

const BELOW: ResultsPlace = { kind: 'below' };
const column = (value: number): ResultsPlace => ({ kind: 'column', column: value });

describe('where the results of a document go', () => {
  it('reuses the group below, or opens a new one below the lowest group, in every layout', () => {
    const cases: [string, EditorLayout, number, ResultsPlace][] = [
      ['single', SINGLE, 1, BELOW],
      ['side by side, left', TWO_COLUMNS, 1, BELOW],
      ['side by side, right', TWO_COLUMNS, 2, BELOW],
      ['two rows, upper', TWO_ROWS, 1, column(2)],
      ['two rows, lowest', TWO_ROWS, 2, BELOW],
      ['three rows, first', THREE_ROWS, 1, column(2)],
      ['three rows, second', THREE_ROWS, 2, column(3)],
      ['three rows, third', THREE_ROWS, 3, BELOW],
      ['column left of two rows', TWO_ROWS_RIGHT, 1, BELOW],
      ['two rows right, upper', TWO_ROWS_RIGHT, 2, column(3)],
      ['two rows right, lower', TWO_ROWS_RIGHT, 3, BELOW],
      ['two above one wide, left', TWO_ROWS_ABOVE, 1, column(3)],
      ['two above one wide, right', TWO_ROWS_ABOVE, 2, column(3)],
      ['two above one wide, the wide one', TWO_ROWS_ABOVE, 3, BELOW],
      ['two stacks, left upper', TWO_STACKS, 1, column(2)],
      ['two stacks, left lower', TWO_STACKS, 2, BELOW],
      ['two stacks, right upper', TWO_STACKS, 3, column(4)],
      ['two stacks, right lower', TWO_STACKS, 4, BELOW],
      ['nested, right upper', NESTED, 2, column(3)],
      ['nested, right lower', NESTED, 3, column(4)],
      ['nested, top left', NESTED, 1, column(4)],
      ['nested, bottom', NESTED, 4, BELOW],
    ];
    for (const [name, layout, from, expected] of cases) {
      expect(resultsPlace(layout, from), name).toEqual(expected);
    }
    for (const from of [0, -1, 1.5, 3, Number.NaN]) {
      expect(resultsPlace(TWO_COLUMNS, from), `column ${from}`).toBeUndefined();
    }
  });
});

describe('the layout that VS Code reports', () => {
  it('reads the layouts above unchanged and refuses everything else', () => {
    for (const layout of [SINGLE, TWO_COLUMNS, TWO_ROWS, TWO_ROWS_RIGHT, NESTED]) {
      expect(parseLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
    }
    expect(parseLayout({ orientation: 1, groups: [{ size: 0.4 }, { size: 0.6 }] })).toEqual({
      orientation: 1,
      groups: [{ size: 0.4 }, { size: 0.6 }],
    });
    const invalid: unknown[] = [
      undefined,
      null,
      'layout',
      {},
      { orientation: 0 },
      { orientation: 0, groups: [] },
      { orientation: 2, groups: [{}] },
      { orientation: 0, groups: [{}, 'x'] },
      { orientation: 0, groups: 'ab' },
      { orientation: 0, groups: [{ groups: [] }] },
    ];
    for (const value of invalid) {
      expect(parseLayout(value), JSON.stringify(value)).toBeUndefined();
    }
  });
});
