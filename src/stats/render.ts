/// <reference lib="dom" />
// DOM builders of the statistics page. They take the state they show and hand charts to the page through `chartBox`.
import { cardGrid, dataTable, empty, note, tableRow } from '../shell/blocks';
import { barChartHeight } from '../shell/chart-option';
import type { ChartOption } from '../shell/chart-option';
import { el } from '../shell/dom';
import { count, formatBytes } from '../shell/model';
import { severityColor } from '../shell/theme';
import type { Theme } from '../shell/theme';
import { histogramOption, partitionOption, statisticsGrowthOption } from './chart-options';
import {
  COLUMNS_NOTE,
  evennessSeverity,
  evennessText,
  growthNotes,
  overviewCards,
  partitioningNotes,
  partitioningText,
  statisticsColumnRows,
} from './model';
import type { StatisticsData } from './model';

export type Statistics = StatisticsData['statistics'];

/** The theme, and a chart box that the page draws once it is in the document. */
export interface Frame {
  readonly theme: Theme;
  readonly chartBox: (label: string, option: ChartOption, height?: number) => HTMLElement;
}

export function overview(stats: Statistics, frame: Frame): HTMLElement[] {
  return [
    cardGrid(overviewCards(stats), severityColor(frame.theme)),
    note(
      'Counts cover data files and delete files. Rows that DuckLake keeps inline in the catalog are not included.',
    ),
    el('h2', undefined, 'File size distribution'),
    stats.sizeHistogram.length > 0
      ? frame.chartBox(
          `File sizes: ${count(stats.files)} files in ${stats.sizeHistogram.length} size ranges, the largest is ${formatBytes(stats.largestFileBytes)}`,
          histogramOption(stats, frame.theme.palette),
        )
      : empty(`This table has no data files at snapshot ${stats.snapshot}.`),
    note('Each range is half the size of the one above it, relative to the largest file.'),
  ];
}

export function columns(stats: Statistics, frame: Frame): HTMLElement[] {
  if (stats.columns.length === 0) {
    return [empty('This table has no columns at this snapshot.')];
  }
  const color = severityColor(frame.theme);
  const rows = statisticsColumnRows(stats.columns).map((row) => {
    const nulls = el('div', 'nulls-cell');
    if (row.nullRatio !== null) {
      const fill = el('div');
      // The style property is allowed by the content security policy; a style attribute in the markup is not.
      fill.style.width = `${row.nullRatio * 100}%`;
      fill.style.background = color(row.severity);
      const bar = el('div', 'bar');
      bar.append(fill);
      nulls.append(bar);
    }
    nulls.append(el('span', undefined, row.nullText));
    const nullCell = el('td');
    nullCell.append(nulls);
    const min = el('td', 'range', row.min);
    const max = el('td', 'range', row.max);
    min.title = row.min;
    max.title = row.max;
    return tableRow([
      el('td', 'name', row.name),
      el('td', 'type', row.type),
      row.nullable,
      nullCell,
      min,
      max,
    ]);
  });
  return [
    dataTable(['Column', 'Type', 'Nullable', 'Null share', 'Minimum', 'Maximum'], rows),
    note(COLUMNS_NOTE),
    ...(stats.columnsPartial
      ? [note('The table has very many files: minimum and maximum cover only some of them.', 'warning')]
      : []),
  ];
}

export function partitioning(stats: Statistics, frame: Frame): HTMLElement[] {
  const partitions = stats.partitioning;
  if (!partitions) {
    return [empty(`This table is not partitioned at snapshot ${stats.snapshot}.`)];
  }
  const bars = partitions.partitions.length + (partitions.rest ? 1 : 0);
  const evenness = evennessText(partitions);
  return [
    el('h2', undefined, `Partitioned by ${partitioningText(partitions)}`),
    bars > 0
      ? frame.chartBox(
          `Size of ${count(bars)} partitions`,
          partitionOption(partitions, frame.theme.palette),
          barChartHeight(bars),
        )
      : empty('No data file was written under this partitioning yet.'),
    ...(evenness ? [note(evenness, evennessSeverity(partitions))] : []),
    ...partitioningNotes(partitions).map((text) => note(text)),
  ];
}

export function growth(stats: Statistics, frame: Frame): HTMLElement[] {
  if (stats.growth.length === 0) {
    return [empty(`No data file was added or removed up to snapshot ${stats.snapshot}.`)];
  }
  return [
    frame.chartBox(
      `Size and number of files after each of ${count(stats.growth.length)} snapshots`,
      statisticsGrowthOption(stats, frame.theme.palette),
    ),
    ...growthNotes(stats).map((text) => note(text)),
  ];
}
