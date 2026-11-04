/// <reference lib="dom" />
// Browser side of the Maintenance Advisor; DOM only, the logic is in model.ts and recommend.ts.
import { actionButton, cardGrid, empty, findingCard, note, pageHeader } from '../shell/blocks';
import { MAINTENANCE_LABEL } from '../maintenance-labels';
import { el } from '../shell/dom';
import { formatUtc, tableLabel } from '../shell/model';
import type { Page, PageContext, PageKind } from '../shell/page';
import { readTheme, severityColor } from '../shell/theme';
import type { Theme } from '../shell/theme';
import { CANDIDATE_LIMIT, advisorCards, policyLines, skippedMeasures } from './model';
import type { AdvisorData } from './model';
import { isAdvisorMessage } from './protocol';
import { levelText, recommendationsOf, riskText } from './recommend';
import type { Recommendation, RecommendationKind } from './recommend';

const SCRIPT_ACTION = {
  expire: 'scriptExpire',
  cleanup: 'scriptCleanup',
  orphans: 'scriptOrphans',
  merge: 'scriptMerge',
  rewrite: 'scriptRewrite',
  flush: 'scriptFlush',
} as const satisfies Record<RecommendationKind, string>;

function createAdvisorPage(context: PageContext): Page<AdvisorData> {
  let data: AdvisorData | undefined;
  let theme: Theme;

  const act = (action: string, table?: number): void =>
    context.post({ type: 'action', action, ...(table === undefined ? {} : { table }) });

  const scriptButton = (kind: RecommendationKind, table?: number, subject = ''): HTMLButtonElement =>
    actionButton(
      'Open script',
      () => act(SCRIPT_ACTION[kind], table),
      `Open the ${MAINTENANCE_LABEL[kind]} script${subject === '' ? '' : ` for ${subject}`} in a SQL document; it is not run${kind === 'expire' || kind === 'cleanup' || kind === 'orphans' ? ' and starts with a dry run' : ''}`,
    );

  function recommendation(advisor: AdvisorData, item: Recommendation, position: number): HTMLElement {
    const { table } = item;
    const name = table ? tableLabel(table) : '';
    const actions = [
      scriptButton(item.kind, table?.id, name),
      ...(table
        ? [
            actionButton(
              'Show table in tree',
              () => act('revealTable', table.id),
              `Select ${name} in the tree`,
            ),
            actionButton(
              'Show Statistics',
              () => act('showStatistics', table.id),
              `Show the statistics of ${name}`,
            ),
          ]
        : []),
      actionButton('Show Storage Report', () => act('showStorage'), 'Show the storage report of the lake'),
      actionButton(
        'Check Health',
        () => act('checkHealth'),
        advisor.scope.kind === 'schema'
          ? `Check the health of the schema ${advisor.scope.name}`
          : 'Check the health of the lake',
      ),
    ];
    return findingCard({
      severity: item.risk === 'high' ? 'warning' : 'ok',
      title: `${position}. ${item.title}`,
      body: [
        `Impact: ${levelText(item.impact)} · Effort: ${levelText(item.effort)} · Risk: ${riskText(item.risk)}`,
        ...item.explanation,
        item.figures.map(([label, value]) => `${label}: ${value}`).join(' · '),
      ],
      actions,
      open: position === 1,
    });
  }

  function render(): void {
    theme = readTheme();
    if (!data) {
      return;
    }
    const advisor = data;
    const recommendations = recommendationsOf(advisor);
    const header = pageHeader(context, {
      title:
        advisor.scope.kind === 'schema'
          ? `Maintenance Advisor · schema ${advisor.scope.name}`
          : 'Maintenance Advisor',
      subtitle: `Snapshot @${advisor.snapshot} · ${advisor.connection} · read ${formatUtc(advisor.readAt)} · dry runs only, nothing is changed`,
      refresh: 'Measure again at the newest snapshot',
      actions: [
        ...(recommendations.length === 0
          ? []
          : [
              actionButton(
                'Create maintenance script for all recommendations',
                () => act('maintenanceScript'),
                'Open one SQL document with the script of every recommendation, in the order they have to run; it is not run and the destructive calls start with a dry run',
              ),
            ]),
      ],
    });
    const main = el('main');
    const skipped = skippedMeasures(advisor);
    main.append(
      cardGrid(advisorCards(advisor), severityColor(theme), 4),
      note(
        'The figures come from the dry runs of DuckLake (dry_run => true) and from the catalog. The scripts open as documents; you run them.',
      ),
      ...(advisor.scope.kind === 'schema'
        ? [
            note(
              `The tables of the schema ${advisor.scope.name}. Snapshots, expiry and files are lake-wide; what is marked so is about the whole lake.`,
            ),
          ]
        : []),
      el('h2', undefined, 'Recommendations'),
      ...(recommendations.length === 0
        ? [empty('Nothing measured is worth doing now.')]
        : recommendations.map((item, index) => recommendation(advisor, item, index + 1))),
      ...(advisor.more
        ? [note(`The lists of tables were cut at ${CANDIDATE_LIMIT} per kind; more tables may qualify.`)]
        : []),
    );
    if (skipped.length > 0) {
      const section = el('div', 'skipped');
      for (const { kind, label, reason } of skipped) {
        const actions = el('div', 'actions');
        actions.append(scriptButton(kind));
        section.append(note(`${label} was not measured: ${reason}`, 'warning'), actions);
      }
      main.append(el('h2', undefined, 'Not measured'), section);
    }
    const policy = el('ul', 'policy');
    policy.append(...policyLines(advisor.policy).map((line) => el('li', undefined, line)));
    main.append(el('h2', undefined, 'Policy'), policy);
    context.app.replaceChildren(header.element, main);
    header.settle();
  }

  return {
    show(next) {
      data = next;
      render();
    },
    redraw: render,
    resize() {},
  };
}

export const advisorPage: PageKind<AdvisorData> = {
  type: 'advisor',
  isMessage: isAdvisorMessage,
  create: createAdvisorPage,
};
