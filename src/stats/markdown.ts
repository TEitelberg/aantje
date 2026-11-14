import { capRows, code, inlineCode, markdownTable, reportTitle } from '../markdown';
import { count, formatBytes } from '../shell/model';
import { FILES_NOTE, growthLabel, growthNotes, growthTime, noGrowthNote } from '../shell/file-growth';
import {
  COLUMNS_NOTE,
  COLUMNS_PARTIAL_NOTE,
  COLUMNS_UNREAD_NOTE,
  COLUMN_HEADERS,
  NO_COLUMNS_NOTE,
  NO_PARTITION_FILES_NOTE,
  RANGES_NOTE,
  binLabel,
  evennessText,
  noDataFilesNote,
  notPartitionedNote,
  overviewCards,
  partitionEntries,
  partitioningNotes,
  partitioningText,
  statisticsColumnRows,
} from './model';
import type { StatisticsData } from './model';

const GROWTH_ROWS = 100;

const SIGN = { ok: '', warning: ' (warning)', error: ' (error)' } as const;

/** The statistics report as Markdown, all four tabs one after the other. Catalog text is code. */
export function statisticsMarkdown({ table, connection, statistics: stats }: StatisticsData): string {
  const cards = overviewCards(stats).map((card) => [
    card.label,
    `${card.value}${SIGN[card.severity]}`,
    card.detail ?? '',
  ]);
  const histogram = stats.sizeHistogram.map((bin, index) => [
    binLabel(bin, index, stats.sizeHistogram.length),
    count(bin.files),
    formatBytes(bin.sizeBytes),
  ]);
  const columns = statisticsColumnRows(stats.columns).map((row) => [
    code(row.name),
    code(row.type),
    row.nullable,
    row.nullText,
    code(row.min),
    code(row.max),
  ]);
  const partitions = stats.partitioning;
  // The values of a partition are catalog text; the label of the partitions summed up is not.
  const bars = partitions
    ? partitionEntries(partitions).map((entry) => [
        entry.rest ? entry.label : code(entry.label),
        count(entry.fileCount),
        formatBytes(entry.sizeBytes),
        count(entry.rows),
      ])
    : [];
  const evenness = partitions && evennessText(partitions);
  const growth = capRows(stats.growth.toReversed(), GROWTH_ROWS);
  return [
    // Like Schema History and Dependencies: the title names the table, the next line the snapshot and the connection.
    reportTitle('Statistics of', table),
    '',
    `Snapshot @${stats.snapshot} of ${inlineCode(connection)}.`,
    '',
    '## Overview',
    '',
    ...markdownTable(['Figure', 'Value', 'Detail'], cards),
    '',
    FILES_NOTE,
    '',
    '### File size distribution',
    '',
    ...(histogram.length === 0
      ? [noDataFilesNote(stats.snapshot)]
      : [...markdownTable(['Size range', 'Files', 'Size'], histogram), '', RANGES_NOTE]),
    '',
    '## Columns',
    '',
    ...(columns.length === 0
      ? [NO_COLUMNS_NOTE]
      : [
          ...markdownTable(COLUMN_HEADERS, columns),
          '',
          COLUMNS_NOTE,
          ...(stats.columnsPartial ? ['', COLUMNS_PARTIAL_NOTE] : []),
          ...(stats.columnsUnread ? ['', COLUMNS_UNREAD_NOTE] : []),
        ]),
    '',
    '## Partitioning',
    '',
    ...(!partitions
      ? [notPartitionedNote(stats.snapshot)]
      : [
          `Partitioned by ${inlineCode(partitioningText(partitions))}.`,
          '',
          ...(bars.length === 0
            ? [NO_PARTITION_FILES_NOTE]
            : markdownTable(['Partition', 'Files', 'Size', 'Rows'], bars)),
          ...(evenness ? ['', evenness] : []),
          ...partitioningNotes(partitions).flatMap((text) => ['', text]),
        ]),
    '',
    '## Growth',
    '',
    ...(stats.growth.length === 0
      ? [noGrowthNote(stats.snapshot)]
      : [
          ...markdownTable(
            ['Snapshot', 'Time', 'Files', 'Size', 'Compaction'],
            growth.shown.map((point) => [
              growthLabel(point),
              growthTime(point),
              count(point.files),
              formatBytes(point.sizeBytes),
              point.compaction ? 'yes' : 'no',
            ]),
          ),
          ...growth.omitted,
          ...growthNotes(stats).flatMap((text) => ['', text]),
        ]),
    '',
  ].join('\n');
}
