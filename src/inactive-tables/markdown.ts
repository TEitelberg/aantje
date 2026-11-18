import { capRows, code, markdownTable, markdownText, visibleLine } from '../markdown';
import { approximateCount, count, formatBytes, formatUtc, tableLabel, whoText } from '../shell/model';
import { changeText, emptyText, inactiveHeading, lastReadText, summaryText } from './model';
import type { InactiveData } from './model';

/** The tables the document lists; the page lists all. */
const TABLE_ROWS = 200;

/** The Markdown of the report; names, authors, messages and comments from the catalog are code. */
export function inactiveMarkdown(data: InactiveData): string {
  const { shown, omitted } = capRows(data.tables, TABLE_ROWS);
  return [
    `# ${markdownText(visibleLine(`${inactiveHeading(data.scope)} · ${data.connection}`))}`,
    '',
    `${summaryText(data)}, read ${formatUtc(data.readAt)} at snapshot @${data.snapshot}.`,
    '',
    ...(data.tables.length === 0
      ? [emptyText(data)]
      : markdownTable(
          ['Table', 'Last change', 'By', 'Rows', 'Size', 'Files', 'Comment', 'Last read (local)'],
          shown.map((table) => [
            code(tableLabel(table)),
            changeText(table),
            code(whoText(table.change?.author ?? null, table.change?.commitMessage ?? null)),
            approximateCount(table.rows, table.approximate === true),
            formatBytes(table.sizeBytes),
            count(table.files),
            code(table.comment ?? ''),
            lastReadText(table),
          ]),
        )),
    ...omitted,
    '',
  ].join('\n');
}
