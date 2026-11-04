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

export interface GraphOptionInput {
  readonly picture: Picture;
  /** The object of the report, drawn larger; null for the lake or a schema. */
  readonly target: number | null;
  readonly selected: number | undefined;
  /** An object to zoom in on. */
  readonly centre: number | undefined;
  readonly contrast: boolean;
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

/** The graph series: boxes at their column and row, the kind by shape and colour, the data flow by arrows. */
export function graphOption(input: GraphOptionInput, palette: Palette): ChartOption {
  const { picture, target, selected, centre, contrast } = input;
  const colour: Readonly<Record<PictureItem['kind'], string>> = {
    table: palette.series[0],
    view: palette.series[1],
    scalarMacro: palette.series[2],
    tableMacro: palette.series[3],
    missing: palette.background,
  };
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
  const focus = picture.items.find(({ node }) => node !== undefined && node === centre);
  return {
    tooltip: { trigger: 'item' },
    aria: {
      label: {
        description: `Graph of ${picture.items.length} objects and ${picture.edges.length} dependencies; the list shows them as text.`,
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
        ...(focus ? { center: at(focus), zoom: 2 } : {}),
      },
    ],
  };
}
