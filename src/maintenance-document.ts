import { HEADER } from './maintenance';
import { compareText } from './order';
import { FIX_STEPS } from './health/model';
import type { FixStep } from './health/model';

const STEP_TITLES: Record<FixStep, string> = {
  option: 'Options',
  compact: 'Merge, rewrite and flush',
  expire: 'Expire snapshots',
  cleanup: 'Clean up old files',
  orphans: 'Delete orphaned files',
};

/** The subject of a block that is about the whole lake; it comes first in its step. */
export const LAKE_SUBJECT = 'The lake';

// Catalog and store text may hold a line break, which would end the comment and run the rest as SQL.
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ');

/** The statements of one step for one subject, with the lines that say why they are there. */
export interface ScriptBlock {
  readonly step: FixStep;
  readonly subject: string;
  readonly sql: string;
  /** What the block is for: a finding or a recommendation per entry; written as comments. */
  readonly notes: readonly string[];
  /** Orders blocks of one step: a lower part first. */
  readonly part?: number;
}

const byOrder = (a: ScriptBlock, b: ScriptBlock): number =>
  FIX_STEPS.indexOf(a.step) - FIX_STEPS.indexOf(b.step) ||
  (a.part ?? 0) - (b.part ?? 0) ||
  Number(b.subject === LAKE_SUBJECT) - Number(a.subject === LAKE_SUBJECT) ||
  compareText(a.subject, b.subject);

const blockLines = ({ subject, notes, sql }: ScriptBlock): string[] => [
  oneLine(`-- ${subject}`),
  ...notes.map((note) => `-- ${oneLine(note)}`),
  sql,
];

/**
 * One SQL document of maintenance blocks in the order the steps have to run: options first, then merge, rewrite
 * and flush, expire, clean up and orphans last. `intro` and `decisions` are comment lines before the blocks.
 * Undefined when there is no block.
 */
export function scriptDocument(
  intro: string,
  blocks: readonly ScriptBlock[],
  decisions: readonly string[] = [],
): string | undefined {
  if (blocks.length === 0) return undefined;
  const sorted = blocks.toSorted(byOrder);
  const sections = FIX_STEPS.flatMap((step) => {
    const own = sorted.filter((block) => block.step === step);
    return own.length === 0
      ? []
      : [[`-- == ${STEP_TITLES[step]} ==`, ...own.flatMap((block) => ['', ...blockLines(block)])].join('\n')];
  });
  return [
    HEADER,
    intro,
    '-- The order matters: an option comes first because the compaction skips a table whose auto_compact is false; clean up and orphans come last because they delete what the steps before made unneeded.',
    ...(decisions.length > 0 ? ['', ...decisions] : []),
    '',
    sections.join('\n\n'),
    '',
  ].join('\n');
}
