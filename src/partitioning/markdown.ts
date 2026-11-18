import { code, markdownTable, markdownText, visibleLine } from '../markdown';
import { count, formatBytes } from '../shell/model';
import { figuresText, historyText, measureText, partitionHeading } from './model';
import type { PartitionData } from './model';

/** The Markdown of the suggestions: the table, the history it read, the candidates, the filters and the measures. */
export function partitionMarkdown(data: PartitionData): string {
  const { table, current } = data;
  return [
    `# ${markdownText(visibleLine(`${partitionHeading(table)} · ${data.connection}`))}`,
    '',
    `Table ${code(`${table.schema}.${table.name}`)} at snapshot ${table.snapshot}: ${count(table.rows)} rows, ${formatBytes(table.sizeBytes)} in ${count(table.files)} files. Partitioning: ${current.partitioning === null ? 'none' : code(current.partitioning)}. Sort order: ${current.sortOrder === null ? 'none' : code(current.sortOrder)}. Target file size: ${formatBytes(data.targetFileBytes)}.`,
    '',
    markdownText(historyText(data)),
    '',
    ...(data.measureError === undefined
      ? []
      : [`The data could not be measured: ${markdownText(data.measureError)}`, '']),
    '## Candidates',
    '',
    ...(data.candidates.length === 0
      ? ['No partitioning fits the data and the filters.', '']
      : data.candidates.flatMap((candidate, at) => [
          `### ${at + 1}. ${code(candidate.keys.join(', '))}`,
          '',
          markdownText(figuresText(candidate)),
          '',
          ...candidate.reasons.map((reason) => `- ${markdownText(reason)}`),
          ...candidate.risks.map((risk) => `- Risk: ${markdownText(risk)}`),
          '',
        ])),
    ...(data.sortOrder
      ? [
          '## Sort order instead',
          '',
          `${code(data.sortOrder.column)}: ${markdownText(data.sortOrder.reason)}`,
          '',
        ]
      : []),
    ...(data.filters.length === 0
      ? []
      : [
          '## Columns in filters',
          '',
          ...markdownTable(
            ['Column', 'Queries', 'Equality', 'Range', 'Join', 'Other'],
            data.filters.map(({ column, use }) => [
              code(column),
              count(use.queries),
              count(use.equality),
              count(use.range),
              count(use.join),
              count(use.other),
            ]),
          ),
          '',
        ]),
    ...(data.measures.length === 0
      ? []
      : [
          '## Measured columns',
          '',
          ...markdownTable(
            ['Column', 'Type', 'Measured'],
            data.measures.map((measure) => [code(measure.column), code(measure.type), measureText(measure)]),
          ),
          '',
        ]),
  ].join('\n');
}
