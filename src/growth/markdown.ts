import { LIST_ROWS } from '../shell/model';
import { scopeSchema } from '../shell/scope';
import { capRows, code, markdownTable, reportTitle } from '../markdown';
import { shortUtc } from '../shell/model';
import {
  APPROXIMATE_NOTE,
  INLINED_FAILED_NOTE,
  INLINED_NOTE,
  METRIC_LABEL,
  METRICS,
  NO_DATA_NOTE,
  EXPIRED_NOTE,
  hasExpired,
  formatDelta,
  formatMetric,
  formatStep,
  growthModelOf,
  growthOlderNote,
  growthScopeLabel,
  seriesOf,
  summarizeGrowth,
  growthTableChoices,
} from './model';
import type { GrowthData, Metric, Step } from './model';

/** The page's choices; the extension fits them to the data it holds. */
export interface GrowthMarkdownView {
  readonly table?: number | undefined;
  readonly metric: Metric;
}

/** Markdown for the page's table and metric; without a view, all tables and live rows. Catalog text is code. */
export function growthMarkdown(data: GrowthData, view?: GrowthMarkdownView): string {
  const model = growthModelOf(data);
  const choices = growthTableChoices(data, model);
  const table = choices.find(({ id }) => id === view?.table);
  const metric = view && METRICS.includes(view.metric) ? view.metric : 'rows';
  const steps = seriesOf(data, model, table?.id);
  const summary = summarizeGrowth(steps, metric);
  const at = (step: Step | undefined, value: (step: Step) => string): string =>
    step ? `${value(step)} at @${step.id} (${shortUtc(step.time)})` : 'none';
  const list = capRows(
    steps
      .toReversed()
      .map((step) => [
        `@${step.id}`,
        shortUtc(step.time),
        formatStep(metric, step),
        formatDelta(metric, step.delta[metric]),
        step.changed ? 'yes' : 'no',
        code(step.author ?? ''),
        code(step.message ?? ''),
      ]),
    LIST_ROWS,
  );
  return [
    reportTitle('Growth of', data.connection, scopeSchema(data.scope)),
    '',
    ...markdownTable(
      ['Property', 'Value'],
      [
        ['Table', table ? code(table.label) : growthScopeLabel(choices, undefined)],
        ['Value', METRIC_LABEL[metric]],
        ['Snapshots read', `${data.read ?? data.snapshots.length} (latest in the catalog @${data.latest})`],
      ],
    ),
    '',
    ...(data.more ? [growthOlderNote(data), ''] : hasExpired(data) ? [EXPIRED_NOTE, ''] : []),
    ...(data.inlinedMore ? [INLINED_NOTE, ''] : []),
    ...(data.inlinedFailed ? [INLINED_FAILED_NOTE, ''] : []),
    ...(steps.some(({ approximate }) => approximate) ? [APPROXIMATE_NOTE, ''] : []),
    ...(steps.length > 0 && !steps.some(({ changed }) => changed) ? [NO_DATA_NOTE, ''] : []),
    '## Summary',
    '',
    ...(summary
      ? markdownTable(
          ['Figure', 'Value'],
          [
            ['First', at(summary.first, (step) => formatStep(metric, step))],
            ['Last', at(summary.last, (step) => formatStep(metric, step))],
            ['Highest', at(summary.highest, (step) => formatMetric(metric, step.total[metric]))],
            ['Largest increase', at(summary.increase, (step) => formatDelta(metric, step.delta[metric]))],
            ['Largest decrease', at(summary.decrease, (step) => formatDelta(metric, step.delta[metric]))],
          ],
        )
      : ['This catalog has no snapshots.']),
    '',
    '## Snapshots',
    '',
    ...(list.shown.length === 0
      ? ['This catalog has no snapshots.']
      : [
          ...markdownTable(
            [
              'Snapshot',
              'Time (UTC)',
              METRIC_LABEL[metric],
              'Change',
              'Changed the table',
              'Author',
              'Message',
            ],
            list.shown,
          ),
          ...list.omitted,
        ]),
    '',
  ].join('\n');
}
