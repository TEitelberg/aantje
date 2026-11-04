import { capRows, code, markdownTable, reportTitle } from '../markdown';
import { count, formatBytes } from '../shell/model';
import { inlineCode } from '../tree/format';
import {
  COLUMNS_NOTE,
  binLabel,
  statisticsColumnRows,
  evennessText,
  growthLabel,
  growthNotes,
  growthTime,
  overviewCards,
  partitionLabel,
  partitioningNotes,
  partitioningText,
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
  const bars = partitions
    ? [
        ...partitions.partitions.map((bucket) => [
          code(partitionLabel(bucket.values)),
          count(bucket.files),
          formatBytes(bucket.sizeBytes),
          count(bucket.rows),
        ]),
        ...(partitions.rest
          ? [
              [
                `other (${count(partitions.rest.partitions)})`,
                count(partitions.rest.files),
                formatBytes(partitions.rest.sizeBytes),
                count(partitions.rest.rows),
              ],
            ]
          : []),
      ]
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
    'Counts cover data files and delete files. Rows that DuckLake keeps inline in the catalog are not included.',
    '',
    '### File size distribution',
    '',
    ...(histogram.length === 0
      ? [`This table has no data files at snapshot ${stats.snapshot}.`]
      : [
          ...markdownTable(['Size range', 'Files', 'Size'], histogram),
          '',
          'Each range is half the size of the one above it, relative to the largest file.',
        ]),
    '',
    '## Columns',
    '',
    ...(columns.length === 0
      ? ['This table has no columns at this snapshot.']
      : [
          ...markdownTable(['Column', 'Type', 'Nullable', 'Null share', 'Minimum', 'Maximum'], columns),
          '',
          COLUMNS_NOTE,
          ...(stats.columnsPartial
            ? ['', 'The table has very many files: minimum and maximum cover only some of them.']
            : []),
        ]),
    '',
    '## Partitioning',
    '',
    ...(!partitions
      ? [`This table is not partitioned at snapshot ${stats.snapshot}.`]
      : [
          `Partitioned by ${inlineCode(partitioningText(partitions))}.`,
          '',
          ...(bars.length === 0
            ? ['No data file was written under this partitioning yet.']
            : markdownTable(['Partition', 'Files', 'Size', 'Rows'], bars)),
          ...(evenness ? ['', evenness] : []),
          ...partitioningNotes(partitions).flatMap((text) => ['', text]),
        ]),
    '',
    '## Growth',
    '',
    ...(stats.growth.length === 0
      ? [`No data file was added or removed up to snapshot ${stats.snapshot}.`]
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
