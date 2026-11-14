/// <reference lib="dom" />
// DOM builders of the statistics page. They take the state they show and hand charts to the page through `chartBox`.
import { cardGrid, dataTable, empty, note, tableRow } from '../shell/blocks';
import { barChartHeight } from '../shell/chart-option';
import type { Frame } from '../shell/chart-set';
import { el } from '../shell/dom';
import { FILES_NOTE, fileGrowthOption, growthNotes, noGrowthNote } from '../shell/file-growth';
import { count, formatBytes } from '../shell/model';
import { severityColor } from '../shell/theme';
import { histogramOption, partitionOption } from './chart-options';
import {
  COLUMNS_NOTE,
  COLUMNS_PARTIAL_NOTE,
  COLUMNS_UNREAD_NOTE,
  COLUMN_HEADERS,
  NO_COLUMNS_NOTE,
  NO_PARTITION_FILES_NOTE,
  RANGES_NOTE,
  evennessSeverity,
  evennessText,
  noDataFilesNote,
  notPartitionedNote,
  overviewCards,
  partitioningNotes,
  partitioningText,
  statisticsColumnRows,
} from './model';
import type { StatisticsData } from './model';

export type Statistics = StatisticsData['statistics'];

export function overview(stats: Statistics, frame: Frame): HTMLElement[] {
  return [
    cardGrid(overviewCards(stats), severityColor(frame.theme)),
    note(FILES_NOTE),
    el('h2', undefined, 'File size distribution'),
    stats.sizeHistogram.length > 0
      ? frame.charts.box(histogramOption(stats, frame.theme.palette), {
          label: `File sizes: ${count(stats.files)} files in ${stats.sizeHistogram.length} size ranges, the largest is ${formatBytes(stats.largestFileBytes)}`,
        })
      : empty(noDataFilesNote(stats.snapshot)),
    note(RANGES_NOTE),
  ];
}

export function columns(stats: Statistics, frame: Frame): HTMLElement[] {
  if (stats.columns.length === 0) {
    return [empty(NO_COLUMNS_NOTE)];
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
    dataTable(COLUMN_HEADERS, rows),
    note(COLUMNS_NOTE),
    ...(stats.columnsPartial ? [note(COLUMNS_PARTIAL_NOTE, 'warning')] : []),
    ...(stats.columnsUnread ? [note(COLUMNS_UNREAD_NOTE, 'warning')] : []),
  ];
}

export function partitioning(stats: Statistics, frame: Frame): HTMLElement[] {
  const partitions = stats.partitioning;
  if (!partitions) {
    return [empty(notPartitionedNote(stats.snapshot))];
  }
  const bars = partitions.partitions.length + (partitions.rest ? 1 : 0);
  const evenness = evennessText(partitions);
  return [
    el('h2', undefined, `Partitioned by ${partitioningText(partitions)}`),
    bars > 0
      ? frame.charts.box(partitionOption(partitions, frame.theme.palette), {
          label: `Size of ${count(bars)} partitions`,
          height: barChartHeight(bars),
        })
      : empty(NO_PARTITION_FILES_NOTE),
    ...(evenness ? [note(evenness, evennessSeverity(partitions))] : []),
    ...partitioningNotes(partitions).map((text) => note(text)),
  ];
}

export function growth(stats: Statistics, frame: Frame): HTMLElement[] {
  if (stats.growth.length === 0) {
    return [empty(noGrowthNote(stats.snapshot))];
  }
  return [
    frame.charts.box(fileGrowthOption(stats, frame.theme.palette), {
      label: `Size and number of files after each of ${count(stats.growth.length)} snapshots`,
    }),
    ...growthNotes(stats).map((text) => note(text)),
  ];
}
