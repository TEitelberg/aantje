import { lakeScript, tableScript } from '../maintenance/scripts';
import { LAKE_SUBJECT, scriptDocument } from '../maintenance/document';
import { STEP_OF } from '../maintenance/steps';
import type { ScriptBlock } from '../maintenance/document';
import type { AdvisorData } from './model';
import { recommendationsOf } from './recommend';
import type { Recommendation } from './recommend';

// The rewrite follows the merge and the flush: it works on the files they leave.
const REWRITE_PART = 1;

// The merge of a table whose small files have deleted rows rewrites them first, as the Maintenance menu does; when
// they could not be read (null), the script says so.
function sqlOf(data: AdvisorData, { kind, table }: Recommendation): string {
  const deleted =
    kind === 'merge' ? data.merge.find((item) => item.table.id === table?.id)?.deleted : undefined;
  return (
    table && (kind === 'merge' || kind === 'flush' || kind === 'rewrite')
      ? tableScript(kind, table.schema, table.name, deleted)
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
    step: STEP_OF[item.kind],
    subject: table ? `Table ${table.schema}.${table.name}` : LAKE_SUBJECT,
    sql: sqlOf(data, item),
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
