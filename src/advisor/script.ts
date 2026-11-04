import { lakeScript, tableScript } from '../maintenance';
import { LAKE_SUBJECT, scriptDocument } from '../maintenance-document';
import type { ScriptBlock } from '../maintenance-document';
import type { FixStep } from '../health/model';
import type { AdvisorData } from './model';
import { recommendationsOf } from './recommend';
import type { Recommendation, RecommendationKind } from './recommend';

const STEPS: Record<RecommendationKind, FixStep> = {
  merge: 'compact',
  flush: 'compact',
  rewrite: 'compact',
  expire: 'expire',
  cleanup: 'cleanup',
  orphans: 'orphans',
};

// The rewrite follows the merge and the flush: it works on the files they leave.
const REWRITE_PART = 1;

function sqlOf({ kind, table }: Recommendation): string {
  return (
    table && (kind === 'merge' || kind === 'flush' || kind === 'rewrite')
      ? tableScript(kind, table.schema, table.name)
      : lakeScript(kind)
  ).join('\n');
}

// A rewrite below the threshold of the lake changes nothing; the plain script is still the one of the menu.
function rewriteNote(data: AdvisorData, { kind, table }: Recommendation): string[] {
  const candidate = kind === 'rewrite' && data.rewrite.find((item) => item.table.id === table?.id);
  return candidate && candidate.atThreshold === 0
    ? [
        'No file reaches the threshold of the lake yet: add delete_threshold => 0.5 to the call to rewrite these files.',
      ]
    : [];
}

function blockOf(data: AdvisorData, item: Recommendation): ScriptBlock {
  const { table } = item;
  return {
    step: STEPS[item.kind],
    subject: table ? `Table ${table.schema}.${table.name}` : LAKE_SUBJECT,
    sql: sqlOf(item),
    notes: [
      item.title,
      item.figures.map(([label, value]) => `${label}: ${value}`).join(' · '),
      ...rewriteNote(data, item),
    ],
    ...(item.kind === 'rewrite' ? { part: REWRITE_PART } : {}),
  };
}

/**
 * One SQL document for all recommendations of the Maintenance Advisor, in the order of the Health script: merge,
 * flush and rewrite, expire, clean up, orphans. Each block names its recommendation with the estimate; destructive
 * calls start as a dry run. Undefined when there is no recommendation.
 */
export function advisorScriptOf(data: AdvisorData): string | undefined {
  return scriptDocument(
    '-- Made from the recommendations of the Maintenance Advisor. Read every block before you run it.',
    recommendationsOf(data).map((item) => blockOf(data, item)),
  );
}
