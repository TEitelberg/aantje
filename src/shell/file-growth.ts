import type { GrowthPoint, TableStatistics } from '../catalog/model';
import { isBoolean, isCount, isNullOr, isShape, isString } from '../guards';
import { firstIndex, tip } from './chart-option';
import type { ChartOption } from './chart-option';
import { files, formatBytes, formatUtc } from './model';
import type { Palette } from './palette';

// The data files of a table or of the lake, as Statistics and Storage show them: their growth over the snapshots and
// what the counts cover.

/** What the counts of files cover, under the figures of Statistics and Storage. */
export const FILES_NOTE =
  'Counts cover data files and delete files. Rows that DuckLake keeps inline in the catalog are not included.';

/** Guard for a point of the growth in the data a page receives. */
export const isGrowthPoint = isShape({
  snapshot: isCount,
  time: isNullOr(isString),
  files: isCount,
  sizeBytes: isCount,
  compaction: isBoolean,
});

/** `@12` */
export function growthLabel(point: GrowthPoint): string {
  return `@${point.snapshot}`;
}

export function growthTime(point: GrowthPoint): string {
  return point.time === null ? 'time unknown (snapshot expired)' : formatUtc(point.time);
}

export const GROWTH_MERGED_NOTE = 'The history is long: neighbouring snapshots are merged into one point.';

export function growthNotes(stats: Pick<TableStatistics, 'growthMerged'>): string[] {
  return [
    'The state after each snapshot that added or removed files. A compaction (diamond) replaces files that leave no trace, ' +
      'so the file count before it is what the catalog still shows.',
    ...(stats.growthMerged ? [GROWTH_MERGED_NOTE] : []),
  ];
}

/** Where the growth has no point. */
export const noGrowthNote = (snapshot: number): string =>
  `No data file was added or removed up to snapshot ${snapshot}.`;

/** Size and number of files after each snapshot that changed them; a compaction is a diamond on the size line. */
export function fileGrowthOption(stats: Pick<TableStatistics, 'growth'>, palette: Palette): ChartOption {
  const points = stats.growth;
  const line = (color: string) => ({
    itemStyle: { color },
    lineStyle: { color },
    step: 'end',
    showSymbol: true,
  });
  return {
    // Animation is off because the page redraws on every theme change; patterns (`aria.decal`) come from the theme.
    animation: false,
    tooltip: {
      confine: true,
      trigger: 'axis',
      formatter: (params: unknown) => {
        const point = points[firstIndex(params)];
        return point
          ? tip(`${growthLabel(point)}${point.compaction ? ' (compaction)' : ''}`, [
              growthTime(point),
              formatBytes(point.sizeBytes),
              files(point.files),
            ])
          : '';
      },
    },
    legend: { top: 0 },
    grid: { left: 8, right: 8, top: 36, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: points.map(growthLabel), boundaryGap: false },
    yAxis: [
      { type: 'value', name: 'Size', axisLabel: { formatter: (value: number) => formatBytes(value) } },
      { type: 'value', name: 'Files', minInterval: 1, splitLine: { show: false } },
    ],
    series: [
      {
        ...line(palette.series[0]),
        type: 'line',
        name: 'Size',
        data: points.map((point) =>
          point.compaction ? { value: point.sizeBytes, symbol: 'diamond', symbolSize: 14 } : point.sizeBytes,
        ),
      },
      {
        ...line(palette.series[2]),
        type: 'line',
        name: 'Files',
        yAxisIndex: 1,
        data: points.map((point) => point.files),
      },
    ],
  };
}
