import { capRows, code, kindsText, markdownTable, reportTitle } from '../markdown';
import { LIST_ROWS, shortUtc } from '../shell/model';
import { boundsOf, fitRange } from '../shell/range-state';
import { scopeSchema } from '../shell/scope';
import { KIND_LABEL, POINT_KINDS, detailOf } from '../snapshot-changes/model';
import type { Model, PointKind } from '../snapshot-changes/model';
import {
  AUTHOR_EXAMPLE,
  AUTHOR_HINT,
  NO_AUTHOR,
  authorLabel,
  choices,
  activityModelOf,
  activityOlderNote,
  omittedAuthorsNote,
  omittedTablesNote,
  summarizeActivity,
} from './model';
import type { ActivityData, ActivitySummary, KindCounts } from './model';

/** The choices on the page that the document repeats; the extension fits them to the data. */
export interface ActivityMarkdownView {
  readonly author?: string | undefined;
  readonly table?: string | undefined;
  readonly kinds: readonly PointKind[];
  readonly text: string;
  readonly range: { readonly from: number; readonly to: number };
}

const DAY_ROWS = 100;

const counts = (kinds: KindCounts): string[] => POINT_KINDS.map((kind) => String(kinds[kind]));

const NO_SNAPSHOT = 'No snapshot is left by the filters.';

interface Fitted {
  readonly author: string | undefined;
  readonly table: { readonly key: string; readonly label: string } | undefined;
  readonly kinds: readonly PointKind[];
  readonly text: string;
  readonly range: { readonly from: number; readonly to: number };
}

// The view as the data allows it: unknown authors and tables drop out, the range stays inside the snapshots.
function fitView(model: Model, view: ActivityMarkdownView | undefined): Fitted {
  const offered = choices(model);
  return {
    author: offered.authors.some(({ key }) => key === view?.author) ? view?.author : undefined,
    table: offered.tables.find(({ key }) => key === view?.table),
    kinds: view ? POINT_KINDS.filter((kind) => view.kinds.includes(kind)) : POINT_KINDS,
    text: view?.text.trim() ?? '',
    range: fitRange(view?.range, boundsOf(model.snapshots)),
  };
}

function settingsTable(data: ActivityData, model: Model, summary: ActivitySummary, fitted: Fitted): string[] {
  const { author, table, kinds, text, range } = fitted;
  return markdownTable(
    ['Property', 'Value'],
    [
      [
        data.scope.kind === 'schema' ? 'Snapshots that changed the schema' : 'Snapshots read',
        `${data.snapshots.length} (latest in the catalog @${data.latest})`,
      ],
      ['Author', author === undefined ? 'all' : code(authorLabel(author))],
      ['Table', table ? code(table.label) : 'all'],
      ['Kinds of change', kindsText(kinds, POINT_KINDS, KIND_LABEL)],
      ['Message', text === '' ? 'all' : code(text)],
      ['Range', model.snapshots.length === 0 ? 'none' : `@${range.from} to @${range.to}`],
      ['Snapshots listed', `${summary.commits.length} of ${data.snapshots.length}`],
    ],
  );
}

function daysSection(summary: ActivitySummary): string[] {
  if (summary.days.length === 0) return [NO_SNAPSHOT];
  const days = capRows(
    summary.days.toReversed().map((day) => [day.day, String(day.commits), ...counts(day.kinds)]),
    DAY_ROWS,
  );
  const columns = POINT_KINDS.map((kind) => `${KIND_LABEL[kind]} (changes)`);
  return [...markdownTable(['Day (UTC)', 'Commits', ...columns], days.shown), ...days.omitted];
}

function authorsSection(summary: ActivitySummary): string[] {
  if (summary.authors.length === 0) return [NO_SNAPSHOT];
  return [
    ...markdownTable(
      ['Author', 'Commits', 'First', 'Latest', 'Latest message'],
      summary.authors.map((row) => [
        row.author === NO_AUTHOR ? authorLabel(row.author) : code(row.author),
        String(row.commits),
        shortUtc(row.first),
        shortUtc(row.last),
        code(row.message ?? ''),
      ]),
    ),
    ...(summary.omittedAuthors > 0 ? ['', omittedAuthorsNote(summary.omittedAuthors)] : []),
  ];
}

function tablesSection(summary: ActivitySummary): string[] {
  if (summary.tables.length === 0) return ['No table was changed by the snapshots that the filters leave.'];
  return [
    ...markdownTable(
      ['Table', 'Changes', ...POINT_KINDS.map((kind) => KIND_LABEL[kind])],
      summary.tables.map((row) => [code(row.label), String(row.changes), ...counts(row.kinds)]),
    ),
    ...(summary.omittedTables > 0 ? ['', omittedTablesNote(summary.omittedTables)] : []),
  ];
}

function commitsSection(data: ActivityData, model: Model, summary: ActivitySummary): string[] {
  const commits = capRows(
    summary.commits.map((commit) => {
      const detail = detailOf(model, data.latest, commit.id);
      return [
        `@${commit.id}`,
        shortUtc(commit.time),
        code(commit.author ?? ''),
        code(commit.message ?? ''),
        [
          ...(detail?.tables.map((entry) => `${code(entry.label)} ${entry.actions.join(', ')}`) ?? []),
          ...(detail?.others.map(code) ?? []),
        ].join('; '),
      ];
    }),
    LIST_ROWS,
  );
  if (commits.shown.length === 0) return [NO_SNAPSHOT];
  return [
    ...markdownTable(['Snapshot', 'Time (UTC)', 'Author', 'Message', 'Changes'], commits.shown),
    ...commits.omitted,
  ];
}

/** The Activity report as Markdown; without a view it shows everything that was read. Catalog text is code. */
export function activityMarkdown(data: ActivityData, view?: ActivityMarkdownView): string {
  const model = activityModelOf(data);
  const fitted = fitView(model, view);
  const { author, table, kinds, text, range } = fitted;
  const summary = summarizeActivity(model, { author, table: table?.key, kinds, text, range });
  return [
    reportTitle('Activity of', data.connection, scopeSchema(data.scope)),
    '',
    ...settingsTable(data, model, summary, fitted),
    '',
    ...(data.more ? [activityOlderNote(data), ''] : []),
    ...(summary.authors.some((row) => row.author === NO_AUTHOR)
      ? [AUTHOR_HINT, '', code(AUTHOR_EXAMPLE), '']
      : []),
    '## Commits per day',
    '',
    ...daysSection(summary),
    '',
    '## Authors',
    '',
    ...authorsSection(summary),
    '',
    '## Most changed tables',
    '',
    ...tablesSection(summary),
    '',
    '## Snapshots',
    '',
    ...commitsSection(data, model, summary),
    '',
  ].join('\n');
}
