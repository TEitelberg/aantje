import { firstIndex, tip } from '../shell/chart-option';
import type { ChartOption } from '../shell/chart-option';
import { formatBytes } from '../shell/model';
import type { ReportPalette } from '../shell/house-colors';
import type { BarEntry } from './model';

/**
 * Bytes per table, largest on top. A table with many small files has the warning colour and a sign in its label.
 * The selected table has the accent of aantje (orange), the bar of the other tables the muted colour.
 */
export function storageTablesOption(
  entries: readonly BarEntry[],
  palette: ReportPalette,
  selected: number | undefined,
): ChartOption {
  const colorOf = (entry: BarEntry): string =>
    entry.tableId === undefined
      ? palette.muted
      : entry.tableId === selected
        ? palette.accent
        : entry.manySmallFiles
          ? palette.warning
          : palette.series[0];
  return {
    animation: false,
    tooltip: {
      confine: true,
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
        data: entries.map((entry) => ({ value: entry.sizeBytes, itemStyle: { color: colorOf(entry) } })),
      },
    ],
  };
}
