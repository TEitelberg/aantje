import { capRows, code, markdownTable, reportTitle } from '../markdown';
import { tableLabel, withoutUtc } from '../shell/model';
import {
  buildModel,
  snapshotReportDetailOf,
  snapshotReportOlderNote,
  omittedLanesNote,
  OTHER_LABEL,
  OTHER_LANE,
  POINT_KINDS,
  snapshotReportViewOf,
  SNAPSHOT_REPORT_KIND_LABEL,
} from './model';
import type { PointKind, SnapshotReportData } from './model';

/** The page's choices; the extension fits them to the data it holds. */
export interface SnapshotReportMarkdownView {
  readonly lanes: readonly string[];
  readonly kinds: readonly PointKind[];
  readonly range: { readonly from: number; readonly to: number };
}

const SNAPSHOT_ROWS = 200;

/** The report as Markdown; without a view, what the page shows on opening. */
export function snapshotReportMarkdown(data: SnapshotReportData, view?: SnapshotReportMarkdownView): string {
  const model = buildModel(data.snapshots, data.more);
  const first = model.snapshots[0]?.id ?? 0;
  const last = model.snapshots.at(-1)?.id ?? 0;
  const fit = (value: number): number => Math.min(Math.max(value, first), last);
  const known = new Set(model.lanes.map((lane) => lane.key));
  const lanes = (view?.lanes ?? []).filter((key) => known.has(key));
  const kinds = view ? POINT_KINDS.filter((kind) => view.kinds.includes(kind)) : POINT_KINDS;
  const range = view ? { from: fit(view.range.from), to: fit(view.range.to) } : { from: first, to: last };
  const shown = snapshotReportViewOf(model, { lanes, kinds, range });
  const rows = shown.columns.toReversed().flatMap(({ id }) => {
    const detail = snapshotReportDetailOf(model, data.latest, id);
    return detail
      ? [
          [
            `@${detail.id}`,
            withoutUtc(detail.timeText),
            code(detail.author ?? ''),
            code(detail.message ?? ''),
            [
              ...detail.tables.map((table) => `${code(table.label)} ${table.actions.join(', ')}`),
              ...detail.others.map(code),
            ].join('; '),
          ],
        ]
      : [];
  });
  const { shown: listed, omitted } = capRows(rows, SNAPSHOT_ROWS);
  const names = lanes.map((key) =>
    key === OTHER_LANE
      ? OTHER_LABEL
      : code(tableLabel(model.lanes.find((lane) => lane.key === key) ?? { schema: null, name: key })),
  );
  const summary = [
    ['Snapshots read', `${data.snapshots.length} (latest in the catalog @${data.latest})`],
    ['Tables', names.length === 0 ? 'all' : names.join(', ')],
    [
      'Kinds of change',
      kinds.length === POINT_KINDS.length
        ? 'all'
        : kinds.map((kind) => SNAPSHOT_REPORT_KIND_LABEL[kind]).join(', ') || 'none',
    ],
    ['Range', model.snapshots.length === 0 ? 'none' : `@${range.from} to @${range.to}`],
    ['Snapshots listed', `${rows.length} of ${data.snapshots.length}`],
  ];
  return [
    reportTitle('Snapshot report of', data.connection),
    '',
    ...markdownTable(['Property', 'Value'], summary),
    '',
    ...(data.more ? [snapshotReportOlderNote(data), ''] : []),
    ...(shown.omittedLanes > 0 ? [omittedLanesNote(shown.omittedLanes), ''] : []),
    '## Snapshots',
    '',
    ...(rows.length === 0
      ? [
          data.snapshots.length === 0
            ? 'This catalog has no snapshots.'
            : 'No snapshot in this range changed the chosen tables with the chosen kinds of change.',
        ]
      : [...markdownTable(['Snapshot', 'Time (UTC)', 'Author', 'Message', 'Changes'], listed), ...omitted]),
    '',
  ].join('\n');
}
