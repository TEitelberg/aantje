import type { TableStatistics } from '../catalog/model';
import { formatBytes } from '../shell/numbers';
import { files } from '../shell/model';
import { binLabel, partitionEntries } from './model';
import { firstIndex, tip } from '../shell/chart-option';
import type { ChartOption } from '../shell/chart-option';
import type { Palette } from '../shell/palette';

// Animation is off because the page redraws on every theme change; patterns (`aria.decal`) come from the theme.
const base = { animation: false, tooltip: { confine: true } };

/** The number of data files per size range; the ranges are halves of the largest file. */
export function histogramOption(stats: TableStatistics, palette: Palette): ChartOption {
  const bins = stats.sizeHistogram;
  return {
    ...base,
    tooltip: {
      ...base.tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const index = firstIndex(params);
        const bin = bins[index];
        return bin
          ? tip(binLabel(bin, index, bins.length), [`${files(bin.files)}, ${formatBytes(bin.sizeBytes)}`])
          : '';
      },
    },
    grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: bins.map((bin, index) => binLabel(bin, index, bins.length)),
      axisLabel: { interval: 0 },
    },
    yAxis: { type: 'value', name: 'Files', minInterval: 1 },
    series: [
      {
        type: 'bar',
        name: 'Files',
        data: bins.map((bin) => bin.files),
        itemStyle: { color: palette.series[0] },
        emphasis: { focus: 'series' },
      },
    ],
  };
}

/** Bytes per partition, largest on top; the unnamed partitions are one bar in the line colour. */
export function partitionOption(
  partitioning: NonNullable<TableStatistics['partitioning']>,
  palette: Palette,
): ChartOption {
  const entries = partitionEntries(partitioning);
  return {
    ...base,
    tooltip: {
      ...base.tooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const entry = entries[firstIndex(params)];
        return entry ? tip(entry.label, [formatBytes(entry.sizeBytes), entry.detail]) : '';
      },
    },
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', axisLabel: { formatter: (value: number) => formatBytes(value) } },
    yAxis: { type: 'category', inverse: true, data: entries.map((entry) => entry.label) },
    series: [
      {
        type: 'bar',
        name: 'Size',
        data: entries.map((entry) => ({
          value: entry.sizeBytes,
          itemStyle: { color: entry.rest ? palette.lines : palette.series[0] },
        })),
      },
    ],
  };
}
