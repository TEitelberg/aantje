import { capRows, code, markdownTable, markdownText, visibleLine } from '../markdown';
import { count, formatBytes } from '../shell/model';
import { overlapShare, overlapText, parquetCards, parquetHeading, stateText } from './model';
import type { ParquetData } from './model';
import type { ParquetView } from './protocol';

/** The row groups the document lists; the page lists all that were read. */
const ROW_GROUP_ROWS = 200;

const codeOrEmpty = (text: string | null): string => (text === null ? '' : code(text));
const countOrEmpty = (amount: number | null): string => (amount === null ? '' : count(amount));

function rowGroupSection(data: ParquetData, column: number): string[] {
  const chosen = data.columns[column];
  if (!chosen || data.rowGroups.length === 0) return [];
  const { shown, omitted } = capRows(data.rowGroups, ROW_GROUP_ROWS);
  const stats = data.rowGroups.map((group) => group.stats[column] ?? null).filter((entry) => entry !== null);
  return [
    '## Row groups',
    '',
    `Column ${code(chosen.path)}. ${markdownText(overlapText(overlapShare(stats)))}`,
    '',
    ...markdownTable(
      ['Row group', 'Rows', 'Compressed', 'Uncompressed', 'Min', 'Max', 'Nulls', 'Distinct'],
      shown.map((group) => {
        const chunk = group.stats[column];
        return [
          String(group.id),
          count(group.rows),
          group.compressedBytes === null ? '' : formatBytes(group.compressedBytes),
          formatBytes(group.uncompressedBytes),
          codeOrEmpty(chunk?.min ?? null),
          codeOrEmpty(chunk?.max ?? null),
          countOrEmpty(chunk?.nulls ?? null),
          countOrEmpty(chunk?.distinct ?? null),
        ];
      }),
    ),
    ...omitted,
    ...((data.file?.rowGroups ?? 0) > data.rowGroups.length
      ? [
          '',
          `The file has ${count(data.file?.rowGroups ?? 0)} row groups; the first ${count(data.rowGroups.length)} were read.`,
        ]
      : []),
    '',
  ];
}

/** The Markdown of one file: the facts, the row groups of the chosen column, the columns and the key/value pairs. */
export function parquetMarkdown(data: ParquetData, view: ParquetView | undefined): string {
  const { target } = data;
  const state = stateText(data);
  return [
    `# ${markdownText(visibleLine(`${parquetHeading(data)} · ${data.connection}`))}`,
    '',
    `File ${code(target.path)}${target.lake ? `, data file #${target.lake.fileId} of ${code(target.lake.table)} (written at snapshot ${target.lake.beginSnapshot})` : ''}.`,
    '',
    ...(state === undefined ? [] : [markdownText(state), '']),
    ...markdownTable(
      ['Figure', 'Value'],
      parquetCards(data).map((card) => [
        card.label,
        `${card.label === 'Created by' || card.label === 'Encryption' ? code(card.value) : card.value}${card.detail === undefined ? '' : ` (${markdownText(card.detail)})`}`,
      ]),
    ),
    '',
    ...rowGroupSection(data, view?.column ?? 0),
    ...(data.columns.length === 0
      ? []
      : [
          '## Columns',
          '',
          ...markdownTable(
            [
              'Column',
              'Physical',
              'Logical',
              'Compression',
              'Encodings',
              'Dictionary',
              'Bloom filter',
              'Field id',
              'DuckLake column',
              'Compressed',
              'Uncompressed',
            ],
            data.columns.map((column) => [
              code(column.path),
              codeOrEmpty(column.physicalType),
              codeOrEmpty(column.logicalType),
              codeOrEmpty(column.compression),
              codeOrEmpty(column.encodings),
              column.dictionary ? 'yes' : 'no',
              column.bloomFilter ? 'yes' : 'no',
              column.fieldId === null ? '' : String(column.fieldId),
              codeOrEmpty(column.lakeColumn),
              formatBytes(column.compressedBytes),
              formatBytes(column.uncompressedBytes),
            ]),
          ),
          '',
        ]),
    ...(data.keyValues.length === 0
      ? []
      : [
          '## Key/value metadata',
          '',
          ...markdownTable(
            ['Key', 'Value'],
            data.keyValues.map((entry) => [code(entry.key), code(entry.value)]),
          ),
          '',
        ]),
  ].join('\n');
}
