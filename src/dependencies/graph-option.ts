import { tip } from '../shell/chart-option';
import type { ChartOption } from '../shell/chart-option';
import type { Palette } from '../shell/palette';
import { DEPENDENCIES_KIND_LABEL, KIND_SIGN } from './model';
import type { Picture, PictureItem } from './picture';

// The room of a column and of a row in the units of the layout; the chart fits the whole into its box.
const COLUMN_GAP = 240;
const ROW_GAP = 48;

const SYMBOL: Readonly<Record<PictureItem['kind'], string>> = {
  table: 'rect',
  view: 'roundRect',
  scalarMacro: 'circle',
  tableMacro: 'diamond',
  missing: 'triangle',
};

const KIND_TEXT: Readonly<Record<PictureItem['kind'], string>> = {
  ...DEPENDENCIES_KIND_LABEL,
  missing: 'missing: no object of the lake has this name',
};

const EDGE_TEXT: Readonly<Record<Picture['edges'][number]['kind'], string>> = {
  reads: 'read by',
  calls: 'called by',
  missing: 'named by',
};

/** The size of the chart in pixels. */
export interface ChartSize {
  readonly width: number;
  readonly height: number;
}

export interface GraphOptionInput {
  readonly picture: Picture;
  /** The object of the report, drawn larger; null for the lake or a schema. */
  readonly target: number | null;
  readonly selected: number | undefined;
  /** Zoom to fit the boxes that are not faint; the zoom stays as it is otherwise. */
  readonly frame: boolean;
  /** The size of the chart, which the zoom of a frame needs. */
  readonly size?: ChartSize | undefined;
  readonly contrast: boolean;
}

/** How a frame fits: the pixels kept free for the labels around the boxes, and the most it zooms in. */
export interface FrameFit {
  readonly room: readonly [number, number];
  readonly max: number;
}

// Labels of up to 280 pixels below the boxes; a zoom of 3 gives the rows of a large lake room for their labels.
const FRAME_FIT: FrameFit = { room: [280, 60], max: 3 };

// The smallest and the largest of the values, which are not empty.
function span(values: readonly number[]): readonly [number, number] {
  let low = Infinity;
  let high = -Infinity;
  for (const value of values) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  return [low, high];
}

/**
 * The centre and the zoom that frame the points that are not faint, in the units of the layout. At zoom 1 ECharts fits
 * every point into 80 % of the chart and keeps the shape; it zooms around `center`. A frame zooms in until what is not
 * faint and the room of `fit` fill the chart, at least 1 and at most `fit.max`; without the size of the chart it
 * stays at 1. Undefined when every point is faint.
 */
export function frameOf(
  points: readonly { readonly x: number; readonly y: number; readonly faint: boolean }[],
  fit: FrameFit,
  size: ChartSize | undefined,
): { readonly center: [number, number]; readonly zoom: number } | undefined {
  const framed = points.filter(({ faint }) => !faint);
  if (framed.length === 0) return undefined;
  const [left, right] = span(points.map(({ x }) => x));
  const [top, bottom] = span(points.map(({ y }) => y));
  const [frameLeft, frameRight] = span(framed.map(({ x }) => x));
  const [frameTop, frameBottom] = span(framed.map(({ y }) => y));
  const center: [number, number] = [(frameLeft + frameRight) / 2, (frameTop + frameBottom) / 2];
  if (!size || size.width <= 0 || size.height <= 0) return { center, zoom: 1 };
  // Pixels per unit at zoom 1; ECharts widens a box without width or height by one unit on each side.
  const scale =
    0.8 * Math.min(size.width / Math.max(right - left, 2), size.height / Math.max(bottom - top, 2));
  const fits = (pixels: number, units: number): number => (units === 0 ? Infinity : pixels / (scale * units));
  const zoom = Math.min(
    fits(size.width - fit.room[0], frameRight - frameLeft),
    fits(size.height - fit.room[1], frameBottom - frameTop),
  );
  return { center, zoom: Math.min(Math.max(zoom, 1), fit.max) };
}

/** The pixel height of the graph: a row per box of the fullest column, within limits. */
export function graphHeight(picture: Picture): number {
  const perColumn = new Map<number, number>();
  for (const { column } of picture.items) {
    perColumn.set(column, (perColumn.get(column) ?? 0) + 1);
  }
  return Math.min(Math.max(240, Math.max(0, ...perColumn.values()) * 36 + 80), 720);
}

const sign = (item: PictureItem): string => (item.kind === 'missing' ? '?' : KIND_SIGN[item.kind]);

/** The colour of each kind of box: the first four series colours, and none for a missing name. */
export const kindColours = (palette: Palette): Readonly<Record<PictureItem['kind'], string>> => ({
  table: palette.series[0],
  view: palette.series[1],
  scalarMacro: palette.series[2],
  tableMacro: palette.series[3],
  missing: palette.background,
});

/** The graph series: boxes at their column and row, the kind by shape and colour, the data flow by arrows. */
export function graphOption(input: GraphOptionInput, palette: Palette): ChartOption {
  const { picture, target, selected, frame, size, contrast } = input;
  const colour = kindColours(palette);
  const at = (item: PictureItem): [number, number] => [item.column * COLUMN_GAP, item.row * ROW_GAP];
  const data = picture.items.map((item) => {
    const marked = item.node !== undefined && (item.node === target || item.node === selected);
    const missing = item.kind === 'missing';
    const [x, y] = at(item);
    return {
      x,
      y,
      symbol: SYMBOL[item.kind],
      symbolSize: item.node !== undefined && item.node === target ? 22 : 14,
      itemStyle: {
        color: colour[item.kind],
        opacity: item.faint ? 0.25 : 1,
        borderColor: missing ? palette.error : palette.foreground,
        borderWidth: missing ? 2 : marked ? 3 : contrast ? 1.5 : 0,
        borderType: missing ? 'dashed' : 'solid',
      },
      label: { opacity: item.faint ? 0.4 : 1 },
      text: `${sign(item)} ${item.name}`,
      tip: tip(item.name, [KIND_TEXT[item.kind]]),
    };
  });
  const links = picture.edges.map(({ from, to, kind }) => {
    const [used, user] = [picture.items[from], picture.items[to]];
    return {
      source: from,
      target: to,
      lineStyle: {
        color: kind === 'missing' ? palette.error : palette.lines,
        type: kind === 'reads' ? 'solid' : 'dashed',
        opacity: used?.faint || user?.faint ? 0.15 : 0.8,
      },
      tip: tip(used?.name ?? '', [`${EDGE_TEXT[kind]} ${user?.name ?? ''}`]),
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
        description: `Graph of ${picture.items.length} objects and ${picture.edges.length} dependencies; the tab ${target === null ? 'List' : 'Objects'} shows them as text.`,
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
        edgeSymbolSize: 8,
        labelLayout: { hideOverlap: true },
        emphasis: { focus: 'adjacency', lineStyle: { width: 3 } },
        label: {
          show: true,
          position: 'bottom',
          color: palette.foreground,
          width: 280,
          overflow: 'truncate',
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
