/// <reference lib="dom" />
// The charts of a profile (Statistics): the flame graph, and the treemap with the bars of the costliest operators.
import { BarChart, CustomChart, TreemapChart } from 'echarts/charts';
import { DataZoomInsideComponent, GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import type { EChartsCoreOption } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { groupBy } from '../order';
import { tip } from '../shell/chart-option';
import { count, secondsText } from '../shell/numbers';
import { chartColors, readableOn } from './chart-colors';
import type { ChartColors } from './chart-colors';
import { flameBars, operatorRows, shareText, totalOperatorSeconds, typeTitle } from './plan';
import type { FlameBar, OperatorRow, Plan } from './plan';
import type { ChartHandle } from './result-tab';

echarts.use([
  BarChart,
  CustomChart,
  TreemapChart,
  DataZoomInsideComponent,
  GridComponent,
  TooltipComponent,
  CanvasRenderer,
]);

const ROW_HEIGHT = 26;
const TOP_OPERATORS = 12;

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

/** The operators with time, grouped by their type for the treemap. */
function groupsOf(rows: readonly OperatorRow[]): { title: string; rows: OperatorRow[] }[] {
  const groups = groupBy(rows, (row) => typeTitle(row.node));
  return [...groups].map(([title, members]) => ({ title, rows: members }));
}

/** The treemap of the operators' own time, grouped by type, and the bars of the costliest operators, side by side. */
export function drawOperators(host: HTMLElement, plan: Plan): ChartHandle {
  const theme = chartColors();
  const colors = theme.kinds;
  const text = font(theme);
  const total = totalOperatorSeconds(plan.root) * 1000;
  const rows = operatorRows(plan).filter((row) => (row.seconds ?? 0) > 0);
  const left = document.createElement('div');
  const right = document.createElement('div');
  left.className = 'chart';
  right.className = 'chart';
  const view = document.createElement('div');
  view.className = 'operators-view';
  view.append(left, right);
  host.replaceChildren(view);
  const share = (milli: number): string => (total > 0 ? shareText(milli / total) : '');
  const label = (row: OperatorRow): string =>
    row.branch === 'Result' ? row.name : `${row.name} · ${row.branch}`;

  const treemap = echarts.init(left, undefined, { renderer: 'canvas' });
  treemap.setOption({
    animation: false,
    textStyle: { fontFamily: text.family },
    tooltip: {
      formatter: (params: { name: string; value: number }) =>
        tip(params.name, [`Own time, all threads: ${milliseconds(params.value)} · ${share(params.value)}`]),
    },
    series: [
      {
        type: 'treemap',
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        upperLabel: {
          show: true,
          height: 20,
          color: text.color,
          formatter: (params: { name: string; value: number }) => `${params.name} · ${share(params.value)}`,
        },
        levels: [
          { itemStyle: { borderWidth: 0, gapWidth: 3 }, upperLabel: { show: false } },
          {
            itemStyle: {
              borderWidth: 2,
              gapWidth: 1,
              borderColor: theme.palette.background,
            },
          },
          { itemStyle: { gapWidth: 1 } },
        ],
        data: groupsOf(rows).map((group) => ({
          name: group.title,
          value: group.rows.reduce((sum, row) => sum + (row.seconds ?? 0) * 1000, 0),
          itemStyle: { color: colors[group.rows[0]?.kind ?? 'other'] },
          children: group.rows.map((row) => {
            const fill = colors[row.kind];
            return {
              name: label(row),
              value: (row.seconds ?? 0) * 1000,
              itemStyle: { color: fill },
              label: {
                color: readableOn(fill, theme.palette.background),
                formatter: (params: { name: string; value: number }) =>
                  `${params.name}\n${milliseconds(params.value)} · ${share(params.value)}`,
              },
            };
          }),
        })),
      },
    ],
  } as EChartsCoreOption);

  const top = [...rows].sort((a, b) => (b.seconds ?? 0) - (a.seconds ?? 0)).slice(0, TOP_OPERATORS);
  const bars = echarts.init(right, undefined, { renderer: 'canvas' });
  bars.setOption({
    animation: false,
    textStyle: { fontFamily: text.family, color: text.color },
    grid: { left: 8, right: 70, top: 8, bottom: 8, containLabel: true },
    tooltip: {
      trigger: 'item',
      formatter: (params: { dataIndex: number }) => {
        const row = top[params.dataIndex];
        return row
          ? tip(label(row), [
              typeTitle(row.node),
              `Own time, all threads: ${secondsText(row.seconds ?? 0)} (${share((row.seconds ?? 0) * 1000)})`,
              ...(row.node.rows === undefined ? [] : [`Rows: ${count(row.node.rows)}`]),
            ])
          : '';
      },
    },
    xAxis: {
      type: 'value',
      splitNumber: 3,
      // Each bar carries its time; the axis only gives the grid lines.
      axisLabel: { show: false },
      splitLine: { lineStyle: { color: text.line, opacity: 0.5 } },
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: top.map(label),
      axisLabel: { color: text.color, width: 220, overflow: 'truncate' },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: text.line } },
    },
    series: [
      {
        type: 'bar',
        barMaxWidth: 18,
        data: top.map((row) => ({
          value: (row.seconds ?? 0) * 1000,
          itemStyle: { color: colors[row.kind], borderRadius: [0, 3, 3, 0] },
        })),
        label: {
          show: true,
          position: 'right',
          color: text.color,
          formatter: (params: { value: number }) => milliseconds(params.value),
        },
      },
    ],
  } as EChartsCoreOption);

  return {
    resize() {
      treemap.resize();
      bars.resize();
    },
    dispose() {
      treemap.dispose();
      bars.dispose();
    },
  };
}
