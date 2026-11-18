import { neutralised } from '../grid/model';
import { capRows, code, markdownTable, markdownText } from '../markdown';
import { reportHeading } from '../shell/report-heading';
import { formatUtc } from '../shell/model';
import { scopeSchema } from '../shell/scope';
import { DEFAULT_VIEW, MARKDOWN_ROWS, TABS, detailsNotes, shownList } from './model';
import type { DetailsData, DetailsView } from './model';

/** A name of the catalog or the connection on one line of the title, escaped. */
const oneLine = (text: string): string => markdownText(text.replace(/\s+/g, ' ').trim());

/** The Details report as Markdown: the list of the chosen tab with the chosen columns, filter and order, and the notes. */
export function detailsMarkdown(data: DetailsData, view: DetailsView = DEFAULT_VIEW): string {
  const { columns, cells } = shownList(data, view);
  const { shown, omitted } = capRows(cells, MARKDOWN_ROWS);
  const tab = TABS.find(({ id }) => id === view.tab)?.label ?? '';
  const filter = view.filter.trim();
  return [
    `# ${oneLine(reportHeading('Details', scopeSchema(data.scope)))} · ${oneLine(data.connection)}`,
    '',
    `${tab} at snapshot @${data.snapshot}, read ${formatUtc(data.readAt)}.${filter === '' ? '' : ` Filter: ${code(filter)}.`}`,
    '',
    ...(cells.length === 0
      ? ['No object matches.']
      : markdownTable(
          columns.map(({ label }) => label),
          shown.map((row) => row.map((cell) => (cell.catalog ? code(cell.text) : cell.text))),
        )),
    ...omitted,
    '',
    ...detailsNotes(data).map((note) => `- ${note}`),
    '',
  ].join('\n');
}

/**
 * The list as Copy puts it on the clipboard: tab separated with a heading row, for a spreadsheet; every row that
 * matches, a text that a spreadsheet would read as a formula with a leading `'`.
 */
export function detailsTsv(data: DetailsData, view: DetailsView): string {
  const { columns, cells } = shownList(data, view);
  const field = (text: string): string => neutralised(text.replace(/[\t\r\n]+/g, ' '));
  return [columns.map(({ label }) => label), ...cells.map((row) => row.map(({ text }) => text))]
    .map((row) => row.map(field).join('\t'))
    .join('\n');
}
