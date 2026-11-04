import { describe, expect, it } from 'vitest';
import { decide } from '../../src/grid/results-binding';
import type {
  BindingAction,
  BindingEntry,
  BindingGroup,
  BindingSnapshot,
} from '../../src/grid/results-binding';

/** Groups by name; the column is where the group sits now. */
const group = (name: string, column: number, ...keys: string[]): BindingGroup<string> => ({
  group: name,
  column,
  keys,
});

/** The results of `key`, placed for the editor in `editorGroup`, in the panel at `column`. */
const entry = (
  key: string,
  editorGroup: string | undefined,
  column?: number,
  more: Partial<BindingEntry<string>> = {},
) => ({
  key,
  editorGroup,
  column,
  covered: false,
  collapsed: false,
  ...more,
});

const decideFor = (
  groups: BindingGroup<string>[],
  entries: BindingEntry<string>[],
  more: Partial<BindingSnapshot<string>> = {},
): BindingAction<string>[] => decide({ groups, entries, ...more });

describe('the results that follow their editor', () => {
  it('close with the last tab of their document, and stay while any group still shows it', () => {
    const cases: [string, BindingGroup<string>[], BindingAction<string>[]][] = [
      ['the query is closed', [group('top', 1, 'b'), group('below', 2)], [{ kind: 'close', key: 'a' }]],
      ['the query is still in its group', [group('top', 1, 'a'), group('below', 2)], []],
      [
        'the query is in another group now',
        [group('top', 1, 'b'), group('right', 2, 'a'), group('below', 3)],
        [{ kind: 'move', key: 'a', group: 'right' }],
      ],
    ];
    for (const [name, groups, expected] of cases) {
      expect(decideFor(groups, [entry('a', 'top', 2)]), name).toEqual(expected);
    }
    expect(
      decideFor([group('top', 1, 'a', 'b'), group('right', 3, 'a')], [entry('a', 'top', 2)]),
      'a split of the query keeps the results under the editor they were placed for',
    ).toEqual([]);
  });

  it('move below the group that now holds the editor: the active one of several, else the first', () => {
    const moved = [group('right', 1, 'a'), group('below', 2), group('other', 3, 'a')];
    expect(decideFor(moved, [entry('a', 'gone', 2)])).toEqual([{ kind: 'move', key: 'a', group: 'right' }]);
    expect(decideFor(moved, [entry('a', 'gone', 2)], { activeGroup: 'other' })).toEqual([
      { kind: 'move', key: 'a', group: 'other' },
    ]);
    // The columns were counted anew (a group was closed before it): the group is the same, nothing moves.
    expect(decideFor([group('top', 1, 'a'), group('below', 2)], [entry('a', 'top', 2)])).toEqual([]);
  });

  it('come forward when their editor becomes active and the results of another query cover them, never over their own editor', () => {
    const groups = [group('top', 1, 'a', 'b'), group('below', 2)];
    const covered = { covered: true };
    const cases: [string, Partial<BindingSnapshot<string>>, BindingEntry<string>, BindingAction<string>[]][] =
      [
        [
          'covered, its editor became active',
          { activated: 'a' },
          entry('a', 'top', 2, covered),
          [{ kind: 'front', key: 'a' }],
        ],
        ['covered, another editor became active', { activated: 'b' }, entry('a', 'top', 2, covered), []],
        ['covered, no editor changed', {}, entry('a', 'top', 2, covered), []],
        ['in front, or behind something else than results', { activated: 'a' }, entry('a', 'top', 2), []],
        ['in the group of its editor', { activated: 'a' }, entry('a', 'top', 1, covered), []],
      ];
    for (const [name, more, results, expected] of cases) {
      expect(decideFor(groups, [results], more), name).toEqual(expected);
    }
  });

  it('when collapsed or still being made, only close with their document; without an editor they are not bound', () => {
    const away = [group('right', 1, 'a'), group('below', 2)];
    const cases: [string, BindingGroup<string>[], BindingEntry<string>, BindingAction<string>[]][] = [
      ['collapsed, the editor moved', away, entry('a', 'top', undefined, { collapsed: true }), []],
      [
        'collapsed, the query closed',
        [group('top', 1)],
        entry('a', 'top', undefined, { collapsed: true }),
        [{ kind: 'close', key: 'a' }],
      ],
      ['being made, the editor moved', away, entry('a', 'top'), []],
      ['no editor, no tab', [group('top', 1)], entry('a', undefined, 2, { covered: true }), []],
    ];
    for (const [name, groups, results, expected] of cases) {
      expect(decideFor(groups, [results], { activated: 'a' }), name).toEqual(expected);
    }
  });
});
