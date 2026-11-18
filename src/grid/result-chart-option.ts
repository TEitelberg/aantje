// The ECharts option of the chart of a result (plan-client.js). The tooltips are HTML: every text in them comes from
// the result, so `tip` escapes it. The option holds the exact text of each value next to its number.
import { tip } from '../shell/chart-option';
import type { ChartOption } from '../shell/chart-option';
import { count } from '../shell/numbers';
import type { HouseColors } from '../shell/house-colors';
import type { CartesianSeries, PreparedChart, Value } from './chart-values';

/** What the option takes from the theme: the series and the ramp of the colours of aantje, and the text colour. */
export interface ResultChartStyle {
  readonly colors: Pick<HouseColors, 'series' | 'ramp'>;
  readonly foreground: string;
  readonly lines: string;
  readonly background: string;
}

/** The height that a chart needs at least, in pixels: a calendar of several years needs a row each. */
export function minimumHeight(chart: PreparedChart): number {
  return chart.kind === 'calendar' ? 80 + chart.years.length * 150 : 240;
}

// Above this, lines are drawn without symbols and sampled, so that the chart stays fast.
const MANY = 2000;
const BUBBLE_PX: readonly [number, number] = [6, 48];

interface Datum {
  readonly value: number | readonly number[];
  readonly text: string;
  readonly xText?: string;
  readonly sizeText?: string;
}

const datum = (value: Value): Datum => ({ value: value.value, text: value.text });

/** The text of a data item that the option put there. */
function textOf(data: unknown): string {
  return typeof data === 'object' && data !== null && 'text' in data ? String(data.text) : '';
}

function field(data: unknown, name: 'xText' | 'sizeText'): string | undefined {
  return typeof data === 'object' && data !== null && name in data
    ? String((data as Record<string, unknown>)[name])
    : undefined;
}

interface TooltipParam {
  readonly seriesName?: string;
  readonly name?: string;
  readonly data?: unknown;
  readonly dataIndex: number;
  readonly percent?: number;
}

/** Zoom on the axis of X: the mouse wheel, and a slider below (at the right of horizontal bars). */
const zoom = (vertical = false): ChartOption[] => [
  { type: 'inside', [vertical ? 'yAxisIndex' : 'xAxisIndex']: 0, filterMode: 'none' },
  vertical
    ? { type: 'slider', yAxisIndex: 0, filterMode: 'none', orient: 'vertical', width: 16, right: 4 }
    : { type: 'slider', xAxisIndex: 0, filterMode: 'none', height: 16, bottom: 4 },
];

/** The name of the X axis below its labels, where it is not cut off. */
const below = (name: string): ChartOption => ({ name, nameLocation: 'middle', nameGap: 28 });

/** Room for the labels, the name of X and the slider below. */
const GRID = { left: 12, right: 32, top: 32, bottom: 56, containLabel: true };

/** The option of a prepared chart. */
export function resultChartOption(chart: PreparedChart, style: ResultChartStyle): ChartOption {
  const base = { animation: false, color: [...style.colors.series], aria: { enabled: true } };
  switch (chart.kind) {
    case 'cartesian':
      return { ...base, ...cartesian(chart) };
    case 'pie':
      return {
        ...base,
        legend: { type: 'scroll', top: 0 },
        tooltip: {
          trigger: 'item',
          formatter: (param: TooltipParam) =>
            tip(param.name ?? '', [`${chart.name}: ${textOf(param.data)}`, `${param.percent ?? 0} %`]),
        },
        series: [
          {
            type: 'pie',
            name: chart.name,
            radius: chart.donut ? ['42%', '70%'] : '70%',
            center: ['50%', '55%'],
            label: { color: style.foreground, formatter: '{b}\n{d} %' },
            itemStyle: { borderColor: style.background, borderWidth: 1 },
            data: chart.slices.map(({ name, value }) => ({ name, ...datum(value) })),
          },
        ],
      };
    case 'heatmap': {
      const values = chart.cells.map(({ value }) => value.value);
      return {
        ...base,
        grid: { ...GRID, right: 16, bottom: 88 },
        tooltip: {
          trigger: 'item',
          formatter: (param: TooltipParam) => {
            const cell = chart.cells[param.dataIndex];
            return cell
              ? tip(`${chart.xs[cell.x] ?? ''} · ${chart.ys[cell.y] ?? ''}`, [
                  `${chart.name}: ${cell.value.text}`,
                ])
              : '';
          },
        },
        xAxis: { type: 'category', data: [...chart.xs], ...below(chart.xName), splitArea: { show: true } },
        yAxis: { type: 'category', data: [...chart.ys], name: chart.yName, splitArea: { show: true } },
        visualMap: visualMap(values, style),
        series: [
          {
            type: 'heatmap',
            name: chart.name,
            data: chart.cells.map(({ x, y, value }) => ({ value: [x, y, value.value], text: value.text })),
            emphasis: { itemStyle: { borderColor: style.foreground, borderWidth: 1 } },
          },
        ],
      };
    }
    case 'histogram':
      return {
        ...base,
        grid: GRID,
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          formatter: (params: readonly TooltipParam[]) => {
            const bin = chart.bins[params[0]?.dataIndex ?? 0];
            return bin ? tip(`${bin.from} to ${bin.to}`, [`rows: ${count(bin.count)}`]) : '';
          },
        },
        xAxis: { type: 'category', ...below(chart.name), data: chart.bins.map(({ from }) => String(from)) },
        yAxis: { type: 'value', name: 'rows', minInterval: 1 },
        dataZoom: zoom(),
        series: [
          { type: 'bar', name: 'rows', barCategoryGap: '4%', data: chart.bins.map((bin) => bin.count) },
        ],
      };
    case 'boxplot':
      return {
        ...base,
        grid: GRID,
        tooltip: {
          trigger: 'item',
          formatter: (param: TooltipParam) => {
            const box = chart.boxes[param.dataIndex];
            const [min, low, median, high, max] = box?.stats ?? [];
            return box
              ? tip(chart.categories[param.dataIndex] ?? '', [
                  `max: ${max}`,
                  `third quartile: ${high}`,
                  `median: ${median}`,
                  `first quartile: ${low}`,
                  `min: ${min}`,
                  `values: ${count(box.count)}`,
                ])
              : '';
          },
        },
        xAxis: { type: 'category', ...below(chart.xName), data: [...chart.categories] },
        yAxis: { type: 'value', name: chart.name, scale: true },
        dataZoom: zoom(),
        series: [
          {
            type: 'boxplot',
            name: chart.name,
            itemStyle: { color: style.colors.ramp[0], borderColor: style.colors.series[0], borderWidth: 1.5 },
            data: chart.boxes.map(({ stats }) => [...stats]),
          },
        ],
      };
    case 'calendar':
      return { ...base, ...calendar(chart, style) };
  }
}

function visualMap(values: readonly number[], style: ResultChartStyle): ChartOption {
  const low = values.reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);
  const high = values.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
  return {
    min: Number.isFinite(low) ? low : 0,
    max: Number.isFinite(high) && high > low ? high : low + 1,
    calculable: true,
    orient: 'horizontal',
    left: 'center',
    bottom: 0,
    itemHeight: 120,
    textStyle: { color: style.foreground },
    inRange: { color: [...style.colors.ramp] },
  };
}

function calendar(chart: Extract<PreparedChart, { kind: 'calendar' }>, style: ResultChartStyle): ChartOption {
  const label = { color: style.foreground };
  return {
    tooltip: {
      trigger: 'item',
      formatter: (param: TooltipParam) => {
        const day = Array.isArray(param.data) ? String((param.data as unknown[])[0]) : '';
        const found = chart.days.find((item) => item.day === day);
        return found ? tip(day, [`${chart.name}: ${found.value.text}`]) : '';
      },
    },
    visualMap: visualMap(
      chart.days.map(({ value }) => value.value),
      style,
    ),
    calendar: chart.years.map((year, index) => ({
      range: String(year),
      top: 32 + index * 150,
      left: 48,
      right: 16,
      cellSize: ['auto', 14],
      yearLabel: { ...label, position: 'left' },
      monthLabel: label,
      dayLabel: { ...label, firstDay: 1 },
      splitLine: { lineStyle: { color: style.lines } },
      itemStyle: { color: 'transparent', borderColor: style.lines, borderWidth: 0.5 },
    })),
    series: chart.years.map((year, index) => ({
      type: 'heatmap',
      coordinateSystem: 'calendar',
      calendarIndex: index,
      name: chart.name,
      data: chart.days
        .filter(({ day }) => day.startsWith(`${year}-`))
        .map(({ day, value }) => [day, value.value]),
    })),
  };
}

function cartesian(chart: Extract<PreparedChart, { kind: 'cartesian' }>): ChartOption {
  const horizontal = chart.type === 'bar-horizontal';
  const stacked = chart.type === 'bar-stacked' || chart.type === 'area';
  const category = chart.xAxis === 'category';
  const sizes = chart.series.flatMap(({ points }) =>
    points.flatMap(({ size }) => (size ? [size.value] : [])),
  );
  const lowSize = sizes.reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);
  const highSize = sizes.reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
  const bubble = (value: number): number => {
    const [small, large] = BUBBLE_PX;
    if (!(highSize > lowSize)) return (small + large) / 2;
    const share = Math.sqrt((value - lowSize) / (highSize - lowSize));
    return small + share * (large - small);
  };
  const xAxis = category
    ? { type: 'category', data: [...chart.categories], axisLabel: { hideOverlap: true } }
    : { type: chart.xAxis, scale: true };
  const valueAxis = { type: 'value', name: chart.yName, scale: !category };
  const second = chart.series.find((series) => series.line);
  const yAxis = second
    ? [valueAxis, { type: 'value', name: second.name, splitLine: { show: false } }]
    : valueAxis;
  const legend = chart.series.length > 1;
  return {
    legend: { show: legend, type: 'scroll', top: 0 },
    grid: { ...GRID, right: horizontal ? 40 : second ? 24 : 32, top: legend ? 52 : 32 },
    tooltip: category
      ? {
          trigger: 'axis',
          axisPointer: { type: horizontal ? 'shadow' : 'line' },
          formatter: (params: readonly TooltipParam[]) =>
            tip(
              chart.categories[params[0]?.dataIndex ?? 0] ?? '',
              params.map((param) => `${param.seriesName ?? ''}: ${textOf(param.data)}`),
            ),
        }
      : {
          trigger: 'item',
          formatter: (param: TooltipParam) => {
            const size = field(param.data, 'sizeText');
            return tip(field(param.data, 'xText') ?? '', [
              `${param.seriesName ?? ''}: ${textOf(param.data)}`,
              ...(size === undefined ? [] : [`size: ${size}`]),
            ]);
          },
        },
    xAxis: horizontal ? { ...valueAxis, ...below(chart.yName) } : { ...xAxis, ...below(chart.xName) },
    yAxis: horizontal ? { ...xAxis, name: chart.xName, inverse: true } : yAxis,
    dataZoom: zoom(horizontal),
    series: chart.series.map((series) => seriesOption(chart, series, { category, stacked, bubble })),
  };
}

function seriesOption(
  chart: Extract<PreparedChart, { kind: 'cartesian' }>,
  series: CartesianSeries,
  how: { readonly category: boolean; readonly stacked: boolean; readonly bubble: (value: number) => number },
): ChartOption {
  const type =
    series.line || chart.type === 'line' || chart.type === 'area'
      ? 'line'
      : chart.type === 'scatter' || chart.type === 'bubble'
        ? 'scatter'
        : 'bar';
  const data: (Datum | null)[] = how.category
    ? series.values.map((value) => (value ? datum(value) : null))
    : series.points.map(({ x, xText, y, size }) => ({
        value: size ? [x, y.value, size.value] : [x, y.value],
        text: y.text,
        xText,
        ...(size ? { sizeText: size.text } : {}),
      }));
  const many = data.length > MANY;
  return {
    type,
    name: series.name,
    data,
    ...(how.stacked ? { stack: 'total' } : {}),
    ...(chart.type === 'area' ? { areaStyle: { opacity: 0.35 } } : {}),
    ...(series.line ? { yAxisIndex: 1 } : {}),
    ...(type === 'line'
      ? { showSymbol: !many && data.length <= 200, ...(many ? { sampling: 'lttb' } : {}) }
      : {}),
    ...(type === 'scatter' && chart.type === 'bubble'
      ? { symbolSize: (value: readonly number[]) => how.bubble(value[2] ?? 0), itemStyle: { opacity: 0.7 } }
      : {}),
  };
}
