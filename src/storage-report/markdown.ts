import { CLEANUP_OVERDUE_DAYS, SMALL_FILES } from '../catalog/thresholds';
import { capRows, code, markdownTable, reportTitle } from '../markdown';
import { GROWTH_MERGED_NOTE, growthLabel, growthTime } from '../shell/file-growth';
import { approximateCount, count, files, formatBytes, plural, tableLabel } from '../shell/model';
import { expirableLine, expirableNote, scheduledLine, scheduledNote } from '../shell/scheduled-text';
import { lakeWide, scopeSchema } from '../shell/scope';
import {
  DEFAULT_SORT,
  LAKE_WIDE_NOTE,
  GROWTH_ROWS,
  MARKDOWN_TABLES,
  TABLE_LIMIT,
  matchingTables,
  mergeCandidates,
  rowsText,
  scheduledOf,
  smallFilesText,
  sortedTables,
} from './model';
import type { StorageData, StorageView } from './model';

const totals = ({ count: n, sizeBytes }: { count: number; sizeBytes: number }): string =>
  `${files(n)}, ${formatBytes(sizeBytes)}`;

/** The Storage report as Markdown: summary, largest tables, many-small-files tables and growth; tables follow the filter. */
export function storageMarkdown(data: StorageData, view?: StorageView): string {
  const { storage } = data;
  const scheduled = scheduledOf(data);
  const lake = (label: string): string => lakeWide(data.scope, label);
  const summary = [
    [lake('Data path'), storage.dataPath === null ? 'not set' : code(storage.dataPath)],
    [lake('Encrypted'), storage.encrypted ? 'yes' : 'no'],
    ['Snapshot', `@${data.snapshot}`],
    ['Data files', totals(storage.dataFiles)],
    ['Delete files', totals(storage.deleteFiles)],
    ['Rows', approximateCount(data.rows, data.approximate)],
    [
      lake('Scheduled for deletion'),
      scheduled.oldest === undefined
        ? scheduledLine(storage.scheduledForDeletion)
        : `${scheduledLine(storage.scheduledForDeletion)}; oldest scheduled ${scheduled.oldest}`,
    ],
    ...(storage.expirableSnapshots === null
      ? []
      : [[lake('Snapshots to expire'), expirableLine(storage.expirableSnapshots)]]),
  ];
  const filter = view?.filter ?? '';
  const matching = sortedTables(matchingTables(data.tables, filter), DEFAULT_SORT);
  const { shown, omitted } = capRows(matching, MARKDOWN_TABLES);
  const leftOut = data.tableCount - data.tables.length;
  const candidates = capRows(mergeCandidates(matching), MARKDOWN_TABLES);
  return [
    reportTitle('Storage of', data.connection, scopeSchema(data.scope)),
    '',
    data.scope.kind === 'schema'
      ? `The tables of the schema ${code(data.scope.name)}: the files, rows and growth are the schema's. ${LAKE_WIDE_NOTE} Files that are visible at the shown snapshot; the figures of a table cover its data files and delete files.`
      : 'Files that are visible at the shown snapshot; the figures of a table cover its data files and delete files.',
    '',
    ...markdownTable(['Property', 'Value'], summary),
    ...(scheduledNote(storage.scheduledForDeletion) === ''
      ? []
      : ['', scheduledNote(storage.scheduledForDeletion)]),
    ...(expirableNote(storage.expirableSnapshots) === ''
      ? []
      : ['', expirableNote(storage.expirableSnapshots)]),
    ...(scheduled.severity === 'warning'
      ? [
          '',
          `The oldest scheduled file has waited ${scheduled.age}, longer than ${plural(CLEANUP_OVERDUE_DAYS, 'day', 'days')}: Clean Up Old Files is due.`,
        ]
      : []),
    '',
    '## Largest tables',
    '',
    ...(filter.trim() === ''
      ? []
      : [`Filter: ${code(filter.trim())}. ${matching.length} of ${data.tables.length} tables match.`, '']),
    ...(data.tableCount === 0
      ? ['No table exists at this snapshot.']
      : matching.length === 0
        ? ['No table matches the filter.']
        : [
            ...markdownTable(
              ['Table', 'Files', 'Size', 'Rows'],
              shown.map((table) => [
                code(tableLabel(table)),
                count(table.files),
                formatBytes(table.sizeBytes),
                rowsText(table),
              ]),
            ),
            ...omitted,
            '',
            'Rows are those of the data files; inlined rows are not included, and `~` marks a count that is only approximate.',
          ]),
    ...(leftOut > 0
      ? [
          '',
          `${plural(leftOut, 'smaller table is', 'smaller tables are')} not part of this report (limit: ${count(TABLE_LIMIT)}).`,
        ]
      : []),
    ...(candidates.shown.length === 0
      ? []
      : [
          '',
          '## Tables with many small files',
          '',
          `At least ${SMALL_FILES.minFiles} data files, ${SMALL_FILES.ratio * 100} % or more of them under ${formatBytes(data.smallFileBytes)}; merging adjacent files compacts them.`,
          '',
          ...markdownTable(
            ['Table', 'Files', 'Small files'],
            candidates.shown.map((table) => [
              code(tableLabel(table)),
              count(table.files),
              smallFilesText(table),
            ]),
          ),
          ...candidates.omitted,
        ]),
    '',
    ...growthSection(data),
    '',
  ].join('\n');
}

function growthSection(data: StorageData): string[] {
  const { growth } = data;
  const last = growth.at(-1);
  if (!last) {
    return ['## Growth', '', `No data file was added or removed up to snapshot @${data.snapshot}.`];
  }
  const largest = growth.reduce((best, point) => (point.sizeBytes > best.sizeBytes ? point : best));
  const newest = capRows(growth.toReversed(), GROWTH_ROWS);
  return [
    '## Growth',
    '',
    ...markdownTable(
      ['Property', 'Value'],
      [
        ['Points', `${count(growth.length)} (${growthLabel(growth[0] ?? last)} to ${growthLabel(last)})`],
        ['Latest', `${files(last.files)}, ${formatBytes(last.sizeBytes)}`],
        ['Largest', `${formatBytes(largest.sizeBytes)} at ${growthLabel(largest)}`],
      ],
    ),
    '',
    'The state after each snapshot that added or removed files, newest first. `Compaction` marks a snapshot that merged adjacent files.',
    '',
    ...markdownTable(
      ['Snapshot', 'Time', 'Size', 'Files', 'Note'],
      newest.shown.map((point) => [
        growthLabel(point),
        growthTime(point),
        formatBytes(point.sizeBytes),
        count(point.files),
        point.compaction ? 'Compaction' : '',
      ]),
    ),
    ...newest.omitted,
    ...(data.growthMerged ? ['', GROWTH_MERGED_NOTE] : []),
  ];
}
