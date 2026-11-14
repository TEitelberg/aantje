/// <reference lib="dom" />
// The plan of Explain and Analysis, drawn like the plans of SQL Server Management Studio: the result on the left, each
// operator as a tile with its figures, arrows from the inputs on the right to the operators that read them. ECharts
// draws it as one custom series, so that aantje lays the plan out itself (plan-layout.ts); only that chart and the
// tooltip are bundled.
import { CustomChart } from 'echarts/charts';
import { TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import type { EChartsCoreOption } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { escapeHtml } from '../html-escape';
import { count, secondsText } from '../shell/numbers';
import { chartColors, tint } from './chart-colors';
import { clipTo } from './model';
import { estimateOf, operatorTitle, shareText, totalOperatorSeconds } from './plan';
import type { Plan, PlanNode } from './plan';
import { enablePanning, followMouse, pinning } from './plan-interaction';
import type { Pinning, TooltipPosition } from './plan-interaction';
import {
  GAP_X,
  ICON,
  ICON_GAP,
  LINE_HEIGHT,
  PAD_X,
  PAD_Y,
  TEXT_SIZE,
  TITLE_SIZE,
  layoutOf,
} from './plan-layout';
import type { Accent, Layout, Measure } from './plan-layout';
import type { ChartHandle } from './result-tab';

echarts.use([CustomChart, TooltipComponent, CanvasRenderer]);

// Width of a character in a monospace font, as a share of the font size, when the page cannot measure text.
const CHAR = 0.62;
const MIN_ZOOM = 0.25;
// A plan opens at least this large, at the result in the top left corner; Fit shows all of it, however small.
const READABLE_ZOOM = 0.7;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.2;
const TOOLTIP_DETAIL_CHARS = 600;

/** Measures with the font of the page, so that tiles fit their text exactly. */
function measureWith(font: string): Measure {
  const context = document.createElement('canvas').getContext('2d');
  return (text, size, bold) => {
    if (!context) return text.length * size * CHAR;
    context.font = `${bold ? 'bold ' : ''}${size}px ${font}`;
    return context.measureText(text).width;
  };
}

interface Colors {
  readonly foreground: string;
  readonly muted: string;
  readonly line: string;
  readonly font: string;
  /** Fill, border and symbol of an operator that took little time, of one above a quarter and above half the slowest. */
  readonly tiles: Readonly<
    Record<Accent, { readonly fill: string; readonly border: string; readonly icon: string }>
  >;
}

function colors(): Colors {
  const { palette, editorForeground, muted, editorFont } = chartColors();
  const { background, warning: orange, error: red } = palette;
  const [, green] = palette.series;
  return {
    foreground: editorForeground,
    muted,
    line: muted,
    font: editorFont,
    tiles: {
      calm: { fill: tint(green, background, 0.14), border: tint(green, background, 0.55), icon: green },
      warm: { fill: tint(orange, background, 0.32), border: orange, icon: orange },
      hot: { fill: tint(red, background, 0.32), border: red, icon: red },
    },
  };
}

function tooltip(node: PlanNode, plan: Plan, total: number): string {
  const lines = [`<b>${escapeHtml(operatorTitle(node))}</b>`];
  for (const [label, detail] of node.details) {
    lines.push(`<b>${escapeHtml(label)}:</b> ${escapeHtml(clipTo(detail, TOOLTIP_DETAIL_CHARS))}`);
  }
  if (node.estimated !== undefined) {
    const estimated = estimateOf(node);
    lines.push(
      `<b>Estimated rows:</b> ${estimated === undefined ? escapeHtml(node.estimated) : count(estimated)}`,
    );
  }
  if (plan.analyzed && node.rows !== undefined) lines.push(`<b>Actual rows:</b> ${count(node.rows)}`);
  if (plan.analyzed && node.seconds !== undefined) {
    const share = total > 0 ? ` (${shareText(node.seconds / total)} of all operators)` : '';
    lines.push(`<b>Time, all threads:</b> ${secondsText(node.seconds)}${share}`);
  }
  return lines.join('<br>');
}

type Line = readonly [text: string, size: number, fill: string, bold: boolean];

/** The tile of one operator and the arrow to the operator that reads it, at zoom `z`, shifted by `offset`. */
function tileElements(
  layout: Layout,
  index: number,
  palette: Colors,
  z: number,
  offset: { x: number; y: number },
): Record<string, unknown> {
  const tile = layout.tiles[index];
  if (!tile) return { type: 'group', children: [] };
  const colorsOf = palette.tiles[tile.accent];
  const at = (x: number, y: number): [number, number] => [offset.x + x * z, offset.y + y * z];
  const children: Record<string, unknown>[] = [];
  // The arrow runs from the left side of the tile, at the height of its title, to the right side of its reader.
  const reader = tile.place.parent === undefined ? undefined : layout.tiles[tile.place.parent];
  if (reader) {
    const connect = PAD_Y + LINE_HEIGHT / 2;
    const width = 1 + 4 * (Math.log1p(tile.flow) / Math.log1p(layout.maxFlow));
    const head = 6 + width;
    const end = reader.x + reader.width;
    const [startY, endY] = [tile.y + connect, reader.y + connect];
    const turn = layout.turns[reader.place.depth] ?? end + GAP_X / 2;
    const points =
      startY === endY
        ? [at(tile.x, startY), at(end + head, endY)]
        : [at(tile.x, startY), at(turn, startY), at(turn, endY), at(end + head, endY)];
    children.push(
      {
        type: 'polyline',
        silent: true,
        shape: { points },
        style: { stroke: palette.line, lineWidth: width * z, fill: 'none', lineJoin: 'round' },
      },
      {
        type: 'polygon',
        silent: true,
        shape: { points: [at(end, endY), at(end + head, endY - head / 2), at(end + head, endY + head / 2)] },
        style: { fill: palette.line },
      },
    );
  }
  const [x, y] = at(tile.x, tile.y);
  children.push(
    {
      type: 'rect',
      shape: { x, y, width: tile.width * z, height: tile.height * z, r: 5 * z },
      style: { fill: colorsOf.fill, stroke: colorsOf.border, lineWidth: tile.accent === 'calm' ? 1 : 2 },
    },
    {
      // Placed by its own transform: the layout box of a path is not computed again when ECharts reuses it.
      type: 'path',
      silent: true,
      x: x + PAD_X * z,
      y: y + (PAD_Y + (LINE_HEIGHT - ICON) / 2) * z,
      scaleX: z,
      scaleY: z,
      shape: { pathData: tile.icon },
      style: { stroke: colorsOf.icon, lineWidth: 1.4, fill: 'none' },
    },
  );
  const textX = x + (PAD_X + ICON + ICON_GAP) * z;
  const lines: Line[] = [
    [tile.title, TITLE_SIZE, palette.foreground, true],
    ...(tile.object ? [[tile.object, TEXT_SIZE, palette.muted, false] as const] : []),
    ...tile.figures.map((line): Line => [line, TEXT_SIZE, palette.foreground, false]),
  ];
  lines.forEach(([text, size, fill, bold], line) => {
    children.push({
      type: 'text',
      silent: true,
      x: textX,
      y: y + (PAD_Y + line * LINE_HEIGHT + LINE_HEIGHT / 2) * z,
      style: {
        text,
        fill,
        font: `${bold ? 'bold ' : ''}${size * z}px ${palette.font}`,
        verticalAlign: 'middle',
        width: (tile.width - ICON - ICON_GAP - 2 * PAD_X) * z,
        overflow: 'truncate',
      },
    });
  });
  return { type: 'group', children };
}

interface Drawing {
  readonly plan: Plan;
  readonly layout: Layout;
  readonly palette: Colors;
  readonly pins: Pinning;
  readonly follow: TooltipPosition;
}

/** The ECharts option of the plan at zoom `z`: one custom series of tiles, and the tooltip of each. */
function planOption(drawing: Drawing, z: number, offset: { x: number; y: number }): EChartsCoreOption {
  const { plan, layout, palette, pins } = drawing;
  const total = totalOperatorSeconds(plan.root);
  return {
    animation: false,
    tooltip: {
      trigger: 'item',
      // A pinned tooltip can be entered to scroll it; long text wraps.
      enterable: true,
      alwaysShowContent: false,
      extraCssText:
        'max-width: min(460px, 80vw); overflow: auto; white-space: normal; overflow-wrap: anywhere; user-select: text;',
      position: pins.position(drawing.follow),
      formatter: (params: { dataIndex?: number }) => {
        const node = layout.tiles[params.dataIndex ?? -1]?.place.node;
        if (!node) return '';
        const note =
          params.dataIndex === pins.index()
            ? '<i>Pinned. Click the operator again to release it.</i><br>'
            : '';
        return note + tooltip(node, plan, total);
      },
    },
    series: [
      {
        type: 'custom',
        coordinateSystem: 'none',
        data: layout.tiles.map((_, index) => [index]),
        renderItem: (params: { dataIndex: number }) =>
          tileElements(layout, params.dataIndex, palette, z, offset),
      },
    ],
  };
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.textContent = text;
  element.title = title;
  element.addEventListener('click', onClick);
  return element;
}

/** Draws the plan into `host`, an element in the document: a row of zoom buttons and the scrolling drawing below it. */
export function drawPlan(host: HTMLElement, plan: Plan, extra?: HTMLElement): ChartHandle {
  const palette = colors();
  const layout = layoutOf(plan, measureWith(palette.font));

  const tools = document.createElement('div');
  tools.className = 'plan-tools';
  const shown = document.createElement('span');
  const scroller = document.createElement('div');
  scroller.className = 'plan-scroll';
  const canvas = document.createElement('div');
  scroller.append(canvas);
  host.replaceChildren(tools, scroller);

  const chart = echarts.init(canvas, undefined, { renderer: 'canvas' });
  const drawing: Drawing = {
    plan,
    layout,
    palette,
    pins: pinning(chart, enablePanning(scroller)),
    follow: followMouse(scroller),
  };
  let zoom = 1;
  // How a resize sets the zoom: as at the start, as Fit, or not at all once the user zoomed.
  let mode: 'start' | 'fit' | 'manual' = 'start';
  // Where the drawing starts in the canvas, which is at least as large as the visible part.
  let offset = { x: 0, y: 0 };

  const fitZoom = (): number =>
    Math.min(
      1,
      Math.max(
        MIN_ZOOM,
        Math.min(scroller.clientWidth / layout.width, scroller.clientHeight / layout.height),
      ),
    );
  const startZoom = (): number => Math.min(1, Math.max(READABLE_ZOOM, fitZoom()));

  // Zoom draws everything again at the new size, so that text stays sharp.
  const render = (): void => {
    const width = Math.max(scroller.clientWidth, layout.width * zoom);
    const height = Math.max(scroller.clientHeight - 4, layout.height * zoom);
    // A plan smaller than the visible part stays in its top left corner, like the result it starts with.
    offset = { x: 0, y: 0 };
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    chart.resize();
    // A new zoom draws everything new; nothing of the drawing before may stay behind.
    chart.clear();
    drawing.pins.reset();
    chart.setOption(planOption(drawing, zoom, offset), { notMerge: true });
    shown.textContent = `${Math.round(zoom * 100)}%`;
  };

  /** Zooms by `factor` and keeps the point under `anchor` (in the visible part) where it is. */
  const zoomBy = (factor: number, anchor?: { x: number; y: number }): void => {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    if (next === zoom) return;
    const at = anchor ?? { x: scroller.clientWidth / 2, y: scroller.clientHeight / 2 };
    const content = {
      x: (scroller.scrollLeft + at.x - offset.x) / zoom,
      y: (scroller.scrollTop + at.y - offset.y) / zoom,
    };
    zoom = next;
    mode = 'manual';
    render();
    scroller.scrollLeft = content.x * zoom + offset.x - at.x;
    scroller.scrollTop = content.y * zoom + offset.y - at.y;
  };

  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = 'Ctrl + mouse wheel zooms, dragging moves the plan';
  tools.append(
    button('−', 'Zoom out (Ctrl + mouse wheel)', () => zoomBy(1 / ZOOM_STEP)),
    shown,
    button('+', 'Zoom in (Ctrl + mouse wheel)', () => zoomBy(ZOOM_STEP)),
    button('Fit', 'Show the whole plan', () => {
      zoom = fitZoom();
      mode = 'fit';
      render();
    }),
    button('100%', 'Show the plan at its own size', () => zoomBy(1 / zoom)),
    ...(extra ? [extra] : []),
    hint,
  );

  scroller.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const bounds = scroller.getBoundingClientRect();
      zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
    },
    { passive: false },
  );
  zoom = startZoom();
  render();

  return {
    resize() {
      if (mode === 'fit') zoom = fitZoom();
      if (mode === 'start') zoom = startZoom();
      render();
    },
    dispose() {
      chart.dispose();
    },
  };
}
