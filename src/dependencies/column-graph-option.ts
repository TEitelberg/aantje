// The ECharts graph of the column mode: a box per object, a row per column, and lines from a source column to the view
// column built from it; the kind of use by the line (direct solid, derived dashed, a decision on rows dotted).
import { tip } from '../shell/chart-option';
import type { ChartOption } from '../shell/chart-option';
import type { Palette } from '../shell/palette';
import type { ColumnItem, ColumnPicture } from './column-picture';
import { frameOf, kindColours } from './graph-option';
import type { ChartSize, FrameFit } from './graph-option';
import type { ColumnUse } from './lineage-scope';
import { USE_LABEL } from './lineage-view';
import { DEPENDENCIES_KIND_LABEL, KIND_SIGN } from './model';

// The room of a column of the layout and of a row, in pixels at zoom 1; a box is narrower than its column.
const COLUMN_GAP = 300;
const ROW_HEIGHT = 22;
const BOX_WIDTH = 200;

const LINE: Readonly<Record<ColumnUse, 'solid' | 'dashed' | 'dotted'>> = {
  direct: 'solid',
  derived: 'dashed',
  filter: 'dotted',
  join: 'dotted',
  group: 'dotted',
};

export interface ColumnOptionInput {
  readonly picture: ColumnPicture;
  readonly target: number | null;
  readonly selected: number | undefined;
  /** Zoom to fit the boxes that are not faint; the zoom stays as it is otherwise. */
  readonly frame: boolean;
  /** The size of the chart, which the zoom of a frame needs. */
  readonly size?: ChartSize | undefined;
}

// A box grows with the zoom: a frame zooms in less than in the graph of the objects.
const FRAME_FIT: FrameFit = { room: [300, 40], max: 1.5 };

/** The pixel height of the graph: a row per column of the fullest stack of boxes, within limits. */
export function columnGraphHeight(picture: ColumnPicture): number {
  const ys = picture.items.map(({ y }) => y);
  const rows = ys.length === 0 ? 0 : Math.max(...ys) - Math.min(...ys) + 1;
  return Math.min(Math.max(240, rows * ROW_HEIGHT + 80), 900);
}

const fullName = (picture: ColumnPicture, item: ColumnItem | undefined): string => {
  if (!item) return '';
  const head = picture.items.find((other) => other.node === item.node && other.column === undefined);
  return item.column === undefined ? item.name : `${head?.name ?? ''}.${item.name}`;
};

/** The graph series of the column mode, at the places of the column picture. */
export function columnGraphOption(input: ColumnOptionInput, palette: Palette): ChartOption {
  const { picture, target, selected, frame, size } = input;
  const colour = kindColours(palette);
  const at = (item: ColumnItem): [number, number] => [item.x * COLUMN_GAP, item.y * ROW_HEIGHT];
  const data = picture.items.map((item) => {
    const head = item.column === undefined;
    const marked = head && (item.node === target || item.node === selected);
    const [x, y] = at(item);
    return {
      x,
      y,
      symbol: 'rect',
      symbolSize: [BOX_WIDTH, ROW_HEIGHT - 2],
      itemStyle: {
        color: palette.background,
        borderColor: colour[item.kind],
        borderWidth: head ? (marked ? 3 : 2) : 1,
        opacity: item.faint ? 0.3 : 1,
      },
      label: {
        show: true,
        position: 'inside',
        color: palette.foreground,
        fontWeight: head ? 'bold' : 'normal',
        width: BOX_WIDTH - 12,
        overflow: 'truncate',
        opacity: item.faint ? 0.4 : 1,
      },
      text: head ? `${KIND_SIGN[item.kind]} ${item.name}` : item.name,
      tip: tip(fullName(picture, item), [head ? DEPENDENCIES_KIND_LABEL[item.kind] : 'column']),
    };
  });
  const links = picture.links.map(({ from, to, use }) => {
    const [source, user] = [picture.items[from], picture.items[to]];
    return {
      source: from,
      target: to,
      lineStyle: {
        color: palette.lines,
        type: LINE[use],
        opacity: source?.faint || user?.faint ? 0.15 : 0.8,
      },
      tip: tip(fullName(picture, source), [`${USE_LABEL[use]} in ${fullName(picture, user)}`]),
    };
  });
  const view = frame
    ? frameOf(
        picture.items.map((item) => {
          const [x, y] = at(item);
          return { x, y, faint: item.faint };
        }),
        FRAME_FIT,
        size,
      )
    : undefined;
  return {
    tooltip: { trigger: 'item' },
    aria: {
      label: {
        description: `Graph of ${picture.items.filter(({ column }) => column !== undefined).length} columns and ${picture.links.length} dependencies between them; the tab Columns shows them as text.`,
      },
    },
    series: [
      {
        id: 'graph',
        type: 'graph',
        layout: 'none',
        roam: true,
        scaleLimit: { min: 0.2, max: 5 },
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: 7,
        emphasis: { focus: 'adjacency', lineStyle: { width: 2.5 } },
        label: {
          show: true,
          formatter: (params: { readonly data: { readonly text: string } }) => params.data.text,
        },
        tooltip: { formatter: (params: { readonly data: { readonly tip: string } }) => params.data.tip },
        data,
        links,
        ...(view ? { center: view.center, zoom: view.zoom } : {}),
      },
    ],
  };
}
