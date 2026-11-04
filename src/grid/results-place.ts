interface LayoutGroup {
  readonly groups?: readonly LayoutGroup[];
}

/** The editor layout; `orientation` is the top-level direction (0: side by side, 1: stacked), each level turns it. */
export interface EditorLayout extends LayoutGroup {
  readonly orientation: 0 | 1;
}

/** Into the group of this column (1-based), or into a new group below it. */
export type ResultsPlace = { readonly kind: 'column'; readonly column: number } | { readonly kind: 'below' };

const STACKED = 1;

/** Reads what `vscode.getEditorLayout` returned, or nothing when it is not a layout. */
export function parseLayout(value: unknown): EditorLayout | undefined {
  const isGroup = (candidate: unknown): boolean => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const { groups } = candidate as LayoutGroup;
    return groups === undefined || (Array.isArray(groups) && groups.length > 0 && groups.every(isGroup));
  };
  const { orientation } = (value ?? {}) as Partial<EditorLayout>;
  const group = isGroup(value) && (value as LayoutGroup).groups !== undefined;
  return group && (orientation === 0 || orientation === 1) ? (value as EditorLayout) : undefined;
}

function leaves(group: LayoutGroup): number {
  return group.groups?.reduce((sum, child) => sum + leaves(child), 0) ?? 1;
}

/** How many editor groups the layout has. */
export const groupCount = (layout: EditorLayout): number => leaves(layout);

// The first group of the next sibling in the nearest stack that holds `column`. `first` is the first column of `group`.
function columnBelow(
  group: LayoutGroup,
  stacked: boolean,
  first: number,
  column: number,
): number | undefined {
  const children = group.groups ?? [];
  let start = first;
  for (const [index, child] of children.entries()) {
    const count = leaves(child);
    if (column < start + count) {
      const inside = columnBelow(child, !stacked, start, column);
      return inside ?? (stacked && index + 1 < children.length ? start + count : undefined);
    }
    start += count;
  }
  return undefined;
}

/** Where the results of the document in `column` (1-based) go: the group below it, else a new group below. */
export function resultsPlace(layout: EditorLayout, column: number): ResultsPlace | undefined {
  if (!Number.isInteger(column) || column < 1 || column > leaves(layout)) return undefined;
  const below = columnBelow(layout, layout.orientation === STACKED, 1, column);
  return below === undefined ? { kind: 'below' } : { kind: 'column', column: below };
}
