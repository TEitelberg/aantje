import { code, markdownTable, reportHeadingLine } from '../markdown';
import { kindsText, markdownText } from '../markdown';
import { shortUtc, tableLabel } from '../shell/model';
import {
  CELL_KINDS,
  SCHEMA_HISTORY_KIND_LABEL,
  LEGEND,
  MAX_ROWS,
  OLDER_NOTE,
  columnHistoryOf,
  columnLabel,
  comparePoints,
  compareViewOf,
  eventText,
  pointText,
  snapshotsBetween,
  stateText,
} from './model';
import type { CellKind, ColumnState, ComparePoint, SchemaHistoryData } from './model';

/** The page's choices; the extension fits them to the data it holds. */
export interface SchemaHistoryMarkdownView {
  readonly from: number;
  readonly to: number;
  readonly kinds: readonly CellKind[];
  readonly text: string;
  /** The column of Search Changes, while that tab is shown. */
  readonly column?: number | undefined;
}

const timeText = (time: string | null): string => (time === null ? 'expired' : shortUtc(time));

const stateCell = (state: ColumnState | null | undefined, name: string): string =>
  state ? code(stateText(state, name)) : '–';

/** The comparison as a table, or why there is none. */
function comparisonLines(
  data: SchemaHistoryData,
  from: ComparePoint | undefined,
  to: ComparePoint | undefined,
  filter: { readonly kinds: readonly CellKind[]; readonly text: string },
): string[] {
  if (!from || !to) {
    return ['No schema change of this table is recorded in the catalog.'];
  }
  const compared = compareViewOf(data, { from: from.id, to: to.id, ...filter });
  const rows = compared.rows.map((row) => {
    const name = row.column.path.at(-1) ?? '';
    return [
      code(columnLabel(row.column)),
      stateCell(row.from, name),
      stateCell(row.to, name),
      row.changes.map((change) => code(change.text)).join(' '),
    ];
  });
  return rows.length === 0
    ? ['No column is left by the filters.']
    : [
        ...markdownTable(['Column', `From @${from.id}`, `To @${to.id}`, 'Changes'], rows),
        ...(compared.omittedRows > 0
          ? ['', `… ${compared.omittedRows} more omitted (limit: ${MAX_ROWS}).`]
          : []),
      ];
}

/** Every change of the column of Search Changes, newest first. */
function columnLines(data: SchemaHistoryData, column: number): string[] {
  const history = columnHistoryOf(data, column);
  return history.length === 0
    ? ['No change of this column is recorded.']
    : markdownTable(
        ['Snapshot', 'Time (UTC)', 'Change', 'Author', 'Message'],
        history.map(({ snapshot, text }) => [
          `@${snapshot.id}`,
          timeText(snapshot.time),
          code(text),
          code(snapshot.author ?? ''),
          code(snapshot.message ?? ''),
        ]),
      );
}

/** The snapshots that changed the schema between the two, newest first. */
function snapshotLines(
  data: SchemaHistoryData,
  from: ComparePoint | undefined,
  to: ComparePoint | undefined,
): string[] {
  const between = from && to ? snapshotsBetween(data, from.id, to.id) : [];
  return between.length === 0
    ? ['No snapshot between the two changed the schema.']
    : markdownTable(
        ['Snapshot', 'Time (UTC)', 'Author', 'Message', 'Table'],
        between.map((snapshot) => [
          `@${snapshot.id}`,
          timeText(snapshot.time),
          code(snapshot.author ?? ''),
          code(snapshot.message ?? ''),
          snapshot.events.map((event) => code(eventText(event))).join(' '),
        ]),
      );
}

/**
 * The comparison of the two snapshots as filtered, the legend, the changes of the column of Search Changes when the
 * view names one, and the snapshots between the two; without a view, the whole history. Catalog text is code.
 */
export function schemaHistoryMarkdown(data: SchemaHistoryData, view?: SchemaHistoryMarkdownView): string {
  const points = comparePoints(data);
  const from = points.find(({ id }) => id === view?.from) ?? points[0];
  const to = points.find(({ id }) => id === view?.to) ?? points.at(-1);
  const kinds = view ? CELL_KINDS.filter((kind) => view.kinds.includes(kind)) : CELL_KINDS;
  const text = view?.text.trim() ?? '';
  const column = data.columns.find(({ id }) => id === view?.column);
  const summary = [
    ['Table', code(tableLabel(data))],
    ['From', from ? pointText(from) : 'none'],
    ['To', to ? pointText(to) : 'none'],
    ['Kinds of change', kindsText(kinds, CELL_KINDS, SCHEMA_HISTORY_KIND_LABEL)],
    ['Column filter', text === '' ? 'none' : code(text)],
  ];
  return [
    reportHeadingLine('Schema History', data.connection, tableLabel(data)),
    '',
    `Read from ${markdownText(data.connection.replace(/\s+/g, ' ').trim())}; the newest snapshot of the catalog is @${data.latest}.`,
    '',
    ...markdownTable(['Property', 'Value'], summary),
    '',
    ...(data.more ? [OLDER_NOTE, ''] : []),
    '## Comparison',
    '',
    ...comparisonLines(data, from, to, { kinds, text }),
    '',
    LEGEND,
    '',
    ...(column
      ? [`## Changes of ${code(columnLabel(column))}`, '', ...columnLines(data, column.id), '']
      : []),
    '## Snapshots',
    '',
    ...snapshotLines(data, from, to),
    '',
  ].join('\n');
}
