// The graph of the Dependencies page in its column mode: each object of the picture is a box of its columns, and lines
// run from a source column to the view column built from it. The boxes keep the places of the object mode.
import { groupBy } from '../order';
import type { NodeKind } from './graph';
import type { ColumnUse } from './lineage-scope';
import { nameAt } from './model';
import type { DependenciesData } from './model';
import { picture } from './picture';
import type { PictureInput } from './picture';

/** A row of a box: the head with the name of the object, or one of its columns. */
export interface ColumnItem {
  readonly node: number;
  readonly kind: NodeKind;
  /** An index into the columns of the lineage; undefined for the head. */
  readonly column: number | undefined;
  readonly name: string;
  /** The column of the layout, along the data flow. */
  readonly x: number;
  /** In rows, centred on 0 in the column of the layout. */
  readonly y: number;
  readonly faint: boolean;
}

/** The data flows from the column `from` into the view column `to`; indexes into `items`. */
export interface ColumnLink {
  readonly from: number;
  readonly to: number;
  readonly use: ColumnUse;
}

export interface ColumnPicture {
  readonly items: readonly ColumnItem[];
  readonly links: readonly ColumnLink[];
}

// The rows between two boxes.
const GAP = 1;

/** The boxes of the objects of the picture with the columns that the lineage of the report holds. */
export function columnPicture(data: DependenciesData, input: PictureInput): ColumnPicture {
  const lineage = data.lineage;
  if (!lineage) return { items: [], links: [] };
  const columnsOf = groupBy(
    lineage.columns.map((column, index) => ({ node: column.node, index })),
    ({ node }) => node,
    ({ index }) => index,
  );
  const boxes = picture(data, input).items.flatMap((item) =>
    item.node === undefined ? [] : [{ ...item, node: item.node, columns: columnsOf.get(item.node) ?? [] }],
  );
  const items: ColumnItem[] = [];
  const itemOf = new Map<number, number>();
  for (const stack of groupBy(boxes, ({ column }) => column).values()) {
    const ordered = stack.toSorted((a, b) => a.row - b.row);
    const height = ordered.reduce((sum, box) => sum + 1 + box.columns.length, 0) + GAP * (ordered.length - 1);
    let y = -(height - 1) / 2;
    for (const box of ordered) {
      const kind = data.nodes[box.node]?.kind ?? 'table';
      const base = { node: box.node, kind, x: box.column, faint: box.faint };
      items.push({ ...base, column: undefined, name: nameAt(data, box.node), y });
      for (const column of box.columns) {
        y++;
        itemOf.set(column, items.length);
        items.push({ ...base, column, name: lineage.columns[column]?.name ?? '', y });
      }
      y += 1 + GAP;
    }
  }
  const links = lineage.edges.flatMap(({ from, to, use }) => {
    const [user, source] = [itemOf.get(from), itemOf.get(to)];
    return user === undefined || source === undefined ? [] : [{ from: source, to: user, use }];
  });
  return { items, links };
}
