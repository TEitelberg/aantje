import { MAINTENANCE_LABEL } from '../maintenance-labels';
import { capRows, code, markdownTable, reportTitle } from '../markdown';
import { count, files, formatUtc, groupedPlural, tableLabel } from '../shell/model';
import { expirableLine, expirableNote, scheduledLine } from '../shell/scheduled-text';
import { lakeWide, scopeSchema } from '../shell/scope';
import { CANDIDATE_LIMIT, MARKDOWN_RECOMMENDATIONS, policyLines, sizeText, skippedMeasures } from './model';
import type { AdvisorData, Measured } from './model';
import { levelText, recommendationsOf, riskText } from './recommend';
import type { Recommendation } from './recommend';

const measured = <T>(measure: Measured<T>, text: (value: T) => string): string =>
  measure.state === 'measured' ? text(measure.value) : `not measured (${code(measure.reason)})`;

function recommendation(item: Recommendation, position: number): string[] {
  return [
    '',
    `### ${position}. ${item.title}`,
    '',
    `Impact: ${levelText(item.impact)} · Effort: ${levelText(item.effort)} · Risk: ${riskText(item.risk)}`,
    ...item.explanation.flatMap((paragraph) => ['', paragraph]),
    '',
    ...markdownTable(
      ['Figure', 'Value'],
      item.figures.map(([label, value]) => [label, value]),
    ),
    '',
    `Script: the **${MAINTENANCE_LABEL[item.kind]}** entry of the Maintenance menu${item.table === undefined ? '' : ` of ${code(tableLabel(item.table))}`}.`,
  ];
}

/** The Advisor as Markdown, the most worthwhile recommendation first; catalog values are escaped. */
export function advisorMarkdown(data: AdvisorData): string {
  const named = (table: Parameters<typeof tableLabel>[0]): string => code(tableLabel(table));
  const recommendations = recommendationsOf(data, named);
  const { shown, omitted } = capRows(recommendations, MARKDOWN_RECOMMENDATIONS);
  const skipped = skippedMeasures(data);
  const scheduled = data.scheduled;
  const lake = (label: string): string => lakeWide(data.scope, label);
  const summary = [
    ...(data.scope.kind === 'schema'
      ? [
          [
            'Scope',
            `The tables of the schema ${code(data.scope.name)}. Snapshots, expiry and files are lake-wide: the rows marked so are about the whole lake.`,
          ],
        ]
      : []),
    ['Snapshot', `@${data.snapshot} (the newest; the dry runs act on it)`],
    ['Read', formatUtc(data.readAt)],
    [
      lake('Snapshots to expire'),
      measured(
        data.expiry,
        (value) =>
          `${count(value.expiring)} of ${count(value.snapshots)}, older than ${data.policy.expire.text}`,
      ),
    ],
    ...(data.expirable === null
      ? []
      : [
          [
            lake('Expirable snapshots'),
            [expirableLine(data.expirable), expirableNote(data.expirable)].filter(Boolean).join('. '),
          ],
        ]),
    [
      lake('Files to clean up'),
      measured(data.cleanup, (value) => `${files(value.files)}, ${sizeText(value)}`),
    ],
    [lake('Orphaned files'), measured(data.orphans, (value) => `${files(value.files)}, ${sizeText(value)}`)],
    [
      lake('Scheduled for deletion'),
      scheduled.oldestScheduledAt === null
        ? scheduledLine(scheduled)
        : `${scheduledLine(scheduled)}; oldest since ${formatUtc(scheduled.oldestScheduledAt)}`,
    ],
    ['Merge candidates', groupedPlural(data.merge.length, 'table', 'tables')],
    ['Rewrite candidates', groupedPlural(data.rewrite.length, 'table', 'tables')],
    ['Flush candidates', groupedPlural(data.flush.length, 'table', 'tables')],
  ];
  return [
    reportTitle('Maintenance advisor of', data.connection, scopeSchema(data.scope)),
    '',
    'What maintenance would do, measured with the dry runs of DuckLake. Nothing was changed, and nothing is run by this report: the scripts open as documents.',
    '',
    ...markdownTable(['Property', 'Value'], summary),
    '',
    '## Policy',
    '',
    ...policyLines(data.policy, code).map((line) => `- ${line}`),
    ...(skipped.length === 0
      ? []
      : [
          '',
          '## Not measured',
          '',
          ...skipped.map(
            ({ label, reason }) =>
              `- ${label}: ${code(reason)}. Run its script in a SQL session to see the dry run.`,
          ),
        ]),
    '',
    '## Recommendations',
    ...(recommendations.length === 0
      ? ['', 'Nothing measured is worth doing now.']
      : [
          '',
          ...markdownTable(
            ['#', 'Recommendation', 'Impact', 'Effort', 'Risk'],
            shown.map((item, index) => [
              String(index + 1),
              item.title,
              levelText(item.impact),
              levelText(item.effort),
              riskText(item.risk),
            ]),
          ),
          ...omitted,
          ...shown.flatMap((item, index) => recommendation(item, index + 1)),
        ]),
    ...(data.more
      ? ['', `The lists of tables were cut at ${count(CANDIDATE_LIMIT)} per kind; more tables may qualify.`]
      : []),
    '',
  ].join('\n');
}
