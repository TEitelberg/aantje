import { capRows, code, markdownTable, markdownText, visibleLine } from '../markdown';
import { count, formatBytes, formatUtc } from '../shell/model';
import {
  DASHBOARD_HEADING,
  ENGINE_LABEL,
  dashboardCards,
  dashboardFindings,
  dashboardNotes,
  inlinedRows,
  lastAnalyze,
  lastVacuum,
  timeText,
} from './model';
import type { DashboardData } from './model';

/** The tables the document lists; the page lists all. */
const TABLE_ROWS = 100;

const bytes = (value: number | null | undefined): string =>
  value === null || value === undefined ? '' : formatBytes(value);
const rows = (value: number | null | undefined): string =>
  value === null || value === undefined ? '' : count(value);

function tableSection(data: DashboardData): string[] {
  const { database } = data;
  const postgres = database.engine === 'postgres';
  const { shown, omitted } = capRows(database.tables, TABLE_ROWS);
  const header = postgres
    ? [
        'Table',
        'Rows (estimate)',
        'Size',
        'Table only',
        'Indexes',
        'TOAST',
        'Inserted',
        'Deleted',
        'Dead rows',
        'Last vacuum',
        'Last analyze',
      ]
    : ['Table', 'Rows', ...(database.sizesPerTable ? ['Size'] : [])];
  const body = shown.map((table) =>
    postgres
      ? [
          code(table.name),
          rows(table.rows),
          bytes(table.totalBytes),
          bytes(table.tableBytes),
          bytes(table.indexBytes),
          bytes(table.toastBytes),
          rows(table.insertedRows),
          rows(table.deletedRows),
          rows(table.deadRows),
          timeText(lastVacuum(table)),
          timeText(lastAnalyze(table)),
        ]
      : [code(table.name), rows(table.rows), ...(database.sizesPerTable ? [bytes(table.totalBytes)] : [])],
  );
  return ['## Tables', '', ...markdownTable(header, body), ...omitted, ''];
}

/** The Markdown of the dashboard; every name from the catalog database is code, everything else of it plain text. */
export function dashboardMarkdown(data: DashboardData): string {
  const { database } = data;
  const findings = dashboardFindings(data);
  const inlined = inlinedRows(data);
  const notes = dashboardNotes(data);
  return [
    `# ${markdownText(visibleLine(`${DASHBOARD_HEADING} · ${data.connection}`))}`,
    '',
    `${ENGINE_LABEL[database.engine]}${database.version === null ? '' : ` ${markdownText(database.version)}`}${database.schema === undefined ? '' : `, schema ${code(database.schema)}`}, read ${formatUtc(data.readAt)}.`,
    '',
    ...markdownTable(
      ['Figure', 'Value'],
      dashboardCards(data).map((card) => [
        card.label,
        `${card.label === 'Largest table' ? code(card.value) : card.value}${card.detail === undefined ? '' : ` (${markdownText(card.detail)})`}`,
      ]),
    ),
    '',
    ...(findings.length === 0
      ? []
      : [
          '## Findings',
          '',
          ...findings.flatMap((finding) => [
            `- **${finding.severity}**: ${markdownText(finding.title)}. ${markdownText(finding.detail)}`,
          ]),
          '',
        ]),
    ...tableSection(data),
    ...(inlined.length === 0
      ? []
      : [
          '## Inlined data',
          '',
          ...markdownTable(
            ['Inlined table', 'Rows of', 'Rows'],
            inlined.map((entry) => [code(entry.name), code(entry.table), rows(entry.rows)]),
          ),
          '',
        ]),
    ...(notes.length === 0 ? [] : ['## Notes', '', ...notes.map((line) => `- ${markdownText(line)}`), '']),
  ].join('\n');
}
