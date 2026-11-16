/// <reference lib="dom" />
// The chart of a profile (Statistics): the flame graph.
import { CustomChart } from 'echarts/charts';
import { DataZoomInsideComponent, GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import type { EChartsCoreOption } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { tip } from '../shell/chart-option';
import { count, secondsText } from '../shell/numbers';
import { chartColors, readableOn } from './chart-colors';
import type { ChartColors } from './chart-colors';
import { flameBars, shareText, typeTitle } from './plan';
import type { FlameBar, Plan } from './plan';
import type { ChartHandle } from './result-tab';

echarts.use([CustomChart, DataZoomInsideComponent, GridComponent, TooltipComponent, CanvasRenderer]);

const ROW_HEIGHT = 26;

// The charts work in milliseconds, so that the axis has round steps; the texts say the time as the table does.
const milliseconds = (value: number): string => secondsText(value / 1000);

/** The text colours and font of the charts. */
function font(theme: ChartColors): { family: string; color: string; muted: string; line: string } {
  return {
    family: theme.palette.fontFamily,
    color: theme.palette.foreground,
    muted: theme.muted,
    line: theme.border,
  };
}

/**
 * The flame graph: the result at the top, its inputs below; each bar as long as the time of its operator and of all
 * operators below it, on the axis of their cumulated time. The mouse wheel zooms into narrow bars.
 */
export function drawFlame(host: HTMLElement, plan: Plan): ChartHandle {
  const bars = flameBars(plan);
  const total = (bars[0]?.seconds ?? 0) * 1000;
  const depth = Math.max(0, ...bars.map((bar) => bar.depth)) + 1;
  const theme = chartColors();
  const colors = theme.kinds;
  const text = font(theme);
  const canvas = document.createElement('div');
  canvas.className = 'chart';
  canvas.style.height = `${depth * ROW_HEIGHT + 64}px`;
  host.replaceChildren(canvas);
  const chart = echarts.init(canvas, undefined, { renderer: 'canvas' });
  const sharesOf = (bar: FlameBar): string[] => [
    `Time with its inputs, all threads: ${secondsText(bar.seconds)}${total > 0 ? ` (${shareText((bar.seconds * 1000) / total)})` : ''}`,
    ...(bar.node.seconds === undefined ? [] : [`Own time, all threads: ${secondsText(bar.node.seconds)}`]),
    ...(bar.node.rows === undefined ? [] : [`Rows: ${count(bar.node.rows)}`]),
  ];
  chart.setOption({
    animation: false,
    textStyle: { fontFamily: text.family, color: text.color },
    grid: { left: 8, right: 16, top: 8, bottom: 44 },
    xAxis: {
      type: 'value',
      min: 0,
      max: total,
      name: 'cumulated time of the operators, all threads',
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { color: text.muted },
      axisLabel: { formatter: (value: number) => milliseconds(value), color: text.muted },
      axisLine: { lineStyle: { color: text.line } },
      splitLine: { show: false },
    },
    yAxis: { type: 'value', min: 0, max: depth, inverse: true, show: false },
    dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }],
    tooltip: {
      trigger: 'item',
      formatter: (params: { dataIndex: number }) => {
        const bar = bars[params.dataIndex];
        return bar ? tip(bar.name, [typeTitle(bar.node), ...sharesOf(bar)]) : '';
      },
    },
    series: [
      {
        type: 'custom',
        encode: { x: [0, 1], y: 2 },
        data: bars.map((bar) => [bar.start * 1000, (bar.start + bar.seconds) * 1000, bar.depth]),
        renderItem: (
          params: { dataIndex: number; coordSys: { x: number; y: number; width: number; height: number } },
          api: {
            coord: (value: [number, number]) => [number, number];
            size: (value: [number, number]) => [number, number];
          },
        ) => {
          const bar = bars[params.dataIndex];
          if (!bar) return null;
          const [x, y] = api.coord([bar.start * 1000, bar.depth]);
          const [width, height] = api.size([bar.seconds * 1000, 1]);
          const shape = echarts.graphic.clipRectByRect(
            { x, y: y + 1, width: Math.max(width - 1, 1), height: height - 2 },
            params.coordSys,
          );
          if (!shape) return null;
          const fill = colors[bar.kind];
          return {
            type: 'group',
            children: [
              { type: 'rect', shape: { ...shape, r: 3 }, style: { fill } },
              {
                type: 'text',
                silent: true,
                x: shape.x + 6,
                y: shape.y + shape.height / 2,
                style: {
                  text: `${bar.name}  ${secondsText(bar.seconds)}`,
                  fill: readableOn(fill, theme.palette.background),
                  font: `12px ${text.family}`,
                  verticalAlign: 'middle',
                  width: Math.max(0, shape.width - 10),
                  overflow: 'truncate',
                },
              },
            ],
          };
        },
      },
    ],
  } as EChartsCoreOption);
  return { resize: () => chart.resize(), dispose: () => chart.dispose() };
}
