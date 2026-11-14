import { LAKE_SUBJECT, oneLine, scriptDocument } from '../maintenance/document';
import type { ScriptBlock } from '../maintenance/document';
import type { FixStep } from '../maintenance/steps';
import type { HealthFinding } from './model';

// Findings named in a block or listed as open; the rest is counted.
const NAMED = 3;
const DECISIONS_LISTED = 50;

function subjectOf({ scope }: HealthFinding): string {
  if (scope.kind === 'lake') return LAKE_SUBJECT;
  return scope.kind === 'schema' ? `Schema ${scope.name}` : `Table ${scope.schema}.${scope.name}`;
}

const notesOf = (findings: readonly HealthFinding[]): string[] => [
  ...findings.slice(0, NAMED).map((finding) => `${finding.id}: ${finding.title}`),
  ...(findings.length > NAMED ? [`and ${findings.length - NAMED} more findings of this kind`] : []),
];

// Findings with the same statements share one block, so a hundred orphaned files give one dry run.
function blocksOf(findings: readonly HealthFinding[]): ScriptBlock[] {
  const groups = new Map<string, { step: FixStep; subject: string; sql: string; found: HealthFinding[] }>();
  for (const finding of findings) {
    const { fixSql, fixStep } = finding;
    if (fixSql === undefined || fixStep === undefined) continue;
    const subject = subjectOf(finding);
    const key = `${fixStep}
${subject}
${fixSql}`;
    const known = groups.get(key);
    if (known) known.found.push(finding);
    else groups.set(key, { step: fixStep, subject, sql: fixSql, found: [finding] });
  }
  return [...groups.values()].map(({ step, subject, sql, found }) => ({
    step,
    subject,
    sql,
    notes: notesOf(found),
  }));
}

function decisionLines(findings: readonly HealthFinding[]): string[] {
  const open = findings.filter((finding) => finding.fixSql === undefined && finding.severity !== 'info');
  if (open.length === 0) return [];
  return [
    '-- These findings need a decision, not a script:',
    ...open
      .slice(0, DECISIONS_LISTED)
      .flatMap((finding) => [
        oneLine(`-- [${finding.severity}] ${finding.id}: ${finding.title}`),
        oneLine(`--     ${finding.fix}`),
      ]),
    ...(open.length > DECISIONS_LISTED
      ? [`-- and ${open.length - DECISIONS_LISTED} more in the report`]
      : []),
  ];
}

/**
 * One SQL document for the findings that maintenance can fix: options first, then merge, rewrite and flush,
 * expire, clean up and orphans last; destructive calls start as a dry run. Undefined when no finding has a script.
 */
export function maintenanceScriptOf(findings: readonly HealthFinding[]): string | undefined {
  return scriptDocument(
    '-- Made from the findings of the Health Check. Read every block before you run it.',
    blocksOf(findings),
    decisionLines(findings),
  );
}
