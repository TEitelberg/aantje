import type { MaintenanceScript } from './labels';

// The steps of a maintenance script for many findings or recommendations. Pages import this file: it holds no logic.

/** The steps in the order they have to run: an option first, since a table with `auto_compact` false is skipped by the compaction. */
export const FIX_STEPS = ['option', 'compact', 'expire', 'cleanup', 'orphans'] as const;
export type FixStep = (typeof FIX_STEPS)[number];

/** The step that the script of each entry of the Maintenance menu belongs to. */
export const STEP_OF: Readonly<Record<MaintenanceScript, FixStep>> = {
  merge: 'compact',
  rewrite: 'compact',
  flush: 'compact',
  expire: 'expire',
  cleanup: 'cleanup',
  orphans: 'orphans',
};
