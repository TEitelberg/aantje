import { firstIndex, tip } from '../shell/chart-option';
import type { ChartOption } from '../shell/chart-option';
import { formatUtc, plural, whoText } from '../shell/model';
import type { Palette } from '../shell/palette';
import { METRIC_LABEL, formatDelta, formatMetric, formatStep } from './model';
import type { Metric, Step, GrowthXAxis } from './model';

interface GrowthChart {
  readonly steps: readonly Step[];
  readonly metric: Metric;
  readonly axis: GrowthXAxis;
  /** Feeds the description of the chart. */
  readonly scope: string;
  readonly selected?: number | undefined;
  /** High contrast theme: larger marks with an outline. */
  readonly contrast: boolean;
}

function tooltipOf(metric: Metric, step: Step | undefined, before: Step | undefined): string {
  if (!step) {
    return '';
  }
  const who = whoText(step.author, step.message);
  return tip(`@${step.id} · ${formatUtc(step.time)}`, [
    ...(who === '' ? [] : [who]),
    `${METRIC_LABEL[metric]}: ${formatStep(metric, step)}`,
    before
      ? `${formatDelta(metric, step.delta[metric])} since @${before.id}`
      : `${formatDelta(metric, step.delta[metric])} at the oldest snapshot read`,
    ...(step.changed ? [] : ['no change to the table']),
  ]);
}

/** One line with a mark per snapshot that changed the selection; the tooltip reads the step by point index. */
export function growthOption(chart: GrowthChart, palette: Palette): ChartOption {
  const { steps, metric, axis, contrast } = chart;
  const times = steps.map((step) => Date.parse(step.time));
  const size = contrast ? 11 : 8;
  const data = steps.map((step, index) => {
    const value = step.total[metric];
    const point = axis === 'time' ? [times[index], value] : value;
    const picked = step.id === chart.selected;
    return {
      value: point,
      symbol: step.changed || picked ? (step.approximate ? 'emptyCircle' : 'circle') : 'none',
      symbolSize: picked ? size + 6 : size,
    };
  });
  return {
    animation: false,
    aria: {
      label: {
        description: `Line chart of the ${METRIC_LABEL[metric].toLowerCase()} of ${chart.scope} after ${plural(steps.length, 'snapshot', 'snapshots')}. The table below has the same information.`,
      },
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      formatter: (params: unknown) => {
        const index = firstIndex(params);
        return tooltipOf(metric, steps[index], steps[index - 1]);
      },
    },
    grid: { left: 8, right: 24, top: 24, bottom: 64, containLabel: true },
    xAxis:
      axis === 'time'
        ? { type: 'time', splitLine: { show: false } }
        : {
            type: 'category',
            data: steps.map((step) => `@${step.id}`),
            boundaryGap: false,
            axisLabel: { hideOverlap: true },
          },
    yAxis: {
      type: 'value',
      name: METRIC_LABEL[metric],
      minInterval: metric === 'bytes' ? undefined : 1,
      axisLabel: { formatter: (value: number) => formatMetric(metric, value) },
    },
    dataZoom: [
      { type: 'slider', xAxisIndex: 0, filterMode: 'none', height: 24, bottom: 8 },
      { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
    ],
    series: [
      {
        type: 'line',
        name: METRIC_LABEL[metric],
        data,
        itemStyle: {
          color: palette.series[0],
          borderColor: palette.foreground,
          borderWidth: contrast ? 1.5 : 0,
        },
        lineStyle: { color: palette.series[0] },
      },
    ],
  };
}
