import { code, markdownTable, reportTitle } from '../markdown';
import { shortUtc } from '../shell/model';
import { markdownText } from '../tree/format';
import {
  CELL_KINDS,
  SCHEMA_HISTORY_KIND_LABEL,
  LEGEND,
  MAX_ROWS,
  OLDER_NOTE,
  columnLabel,
  eventText,
  tableLabel,
  schemaHistoryViewOf,
} from './model';
import type { CellKind, SchemaHistoryData } from './model';

/** The page's choices; the extension fits them to the data it holds. */
export interface SchemaHistoryMarkdownView {
  readonly kinds: readonly CellKind[];
  readonly text: string;
  readonly range?: { readonly from: number; readonly to: number } | undefined;
}

/** The filtered matrix, snapshots and legend as Markdown; without a view, everything. Catalog text is code. */
export function schemaHistoryMarkdown(data: SchemaHistoryData, view?: SchemaHistoryMarkdownView): string {
  const first = data.snapshots[0]?.id ?? 0;
  const last = data.snapshots.at(-1)?.id ?? 0;
  const fit = (value: number): number => Math.min(Math.max(value, first), last);
  const kinds = view ? CELL_KINDS.filter((kind) => view.kinds.includes(kind)) : CELL_KINDS;
  const text = view?.text.trim() ?? '';
  const range = view?.range ? { from: fit(view.range.from), to: fit(view.range.to) } : undefined;
  const shown = schemaHistoryViewOf(data, { kinds, text, ...(range ? { range } : {}) });
  const heads = shown.snapshots.map(({ id }) => `@${id}`);
  const events = shown.snapshots.map(({ events: own }) =>
    own.map((event) => code(eventText(event))).join(' '),
  );
  const rows = shown.rows.map(({ column, cells }) => [
    code(columnLabel(column)),
    column.now === null ? (data.exists ? 'dropped' : 'table dropped') : code(column.now),
    ...shown.snapshots.map(({ id }) =>
      cells
        .filter((cell) => cell.snapshot === id)
        .map((cell) => code(cell.text))
        .join(' '),
    ),
  ]);
  const summary = [
    ['Table', code(tableLabel(data))],
    ['Snapshots in the matrix', `${shown.snapshots.length} of ${data.snapshots.length}`],
    [
      'Kinds of change',
      kinds.length === CELL_KINDS.length
        ? 'all'
        : kinds.map((kind) => SCHEMA_HISTORY_KIND_LABEL[kind]).join(', ') || 'none',
    ],
    ['Column filter', text === '' ? 'none' : code(text)],
    ['Range', range ? `@${range.from} to @${range.to}` : 'all'],
  ];
  return [
    reportTitle('Schema history of', tableLabel(data)),
    '',
    `Read from ${markdownText(data.connection.replace(/\s+/g, ' ').trim())}; the newest snapshot of the catalog is @${data.latest}.`,
    '',
    ...markdownTable(['Property', 'Value'], summary),
    '',
    ...(data.more ? [OLDER_NOTE, ''] : []),
    '## Matrix',
    '',
    ...(shown.snapshots.length === 0 && shown.rows.length === 0
      ? ['No column or snapshot is left by the filters.']
      : [
          ...markdownTable(['Column', 'Now', ...heads], [['Table', '', ...events], ...rows]),
          ...(shown.omittedRows > 0 ? ['', `… ${shown.omittedRows} more omitted (limit: ${MAX_ROWS}).`] : []),
        ]),
    '',
    LEGEND,
    '',
    '## Snapshots',
    '',
    ...(shown.snapshots.length === 0
      ? ['No snapshot is left by the filters.']
      : markdownTable(
          ['Snapshot', 'Time (UTC)', 'Author', 'Message', 'Table'],
          shown.snapshots
            .map((snapshot, index) => [
              `@${snapshot.id}`,
              snapshot.time === null ? 'expired' : shortUtc(snapshot.time),
              code(snapshot.author ?? ''),
              code(snapshot.message ?? ''),
              events[index] ?? '',
            ])
            .reverse(),
        )),
    '',
  ].join('\n');
}
