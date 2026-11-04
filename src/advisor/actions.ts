import type { AdvisorData, AdvisorTable } from './model';
import type { AdvisorAction } from './protocol';

export type AdvisorActionId =
  | 'scriptExpire'
  | 'scriptCleanup'
  | 'scriptOrphans'
  | 'scriptMerge'
  | 'scriptRewrite'
  | 'scriptFlush'
  | 'showStatistics'
  | 'revealTable'
  | 'showStorage'
  | 'checkHealth'
  | 'maintenanceScript';

export type AdvisorPlan =
  | { readonly action: 'script'; readonly kind: 'expire' | 'cleanup' | 'orphans' }
  | { readonly action: 'script'; readonly kind: 'merge' | 'rewrite' | 'flush'; readonly table: AdvisorTable }
  | { readonly action: 'showStatistics' | 'revealTable'; readonly table: AdvisorTable }
  | { readonly action: 'showStorage' | 'checkHealth' | 'maintenanceScript' };

const TABLE_SCRIPTS = { scriptMerge: 'merge', scriptRewrite: 'rewrite', scriptFlush: 'flush' } as const;

// The tables of the candidates of each kind: a script is offered only for tables the advisor named for it.
function candidatesOf(data: AdvisorData, kind: 'merge' | 'rewrite' | 'flush'): readonly AdvisorTable[] {
  return data[kind].map((candidate) => candidate.table);
}

/** The action for a request; undefined for an unknown table, or a script for a non-candidate. */
export function planAdvisorAction(data: AdvisorData, message: AdvisorAction): AdvisorPlan | undefined {
  switch (message.action) {
    case 'scriptExpire':
      return { action: 'script', kind: 'expire' };
    case 'scriptCleanup':
      return { action: 'script', kind: 'cleanup' };
    case 'scriptOrphans':
      return { action: 'script', kind: 'orphans' };
    case 'showStorage':
    case 'checkHealth':
    case 'maintenanceScript':
      return { action: message.action };
    case 'scriptMerge':
    case 'scriptRewrite':
    case 'scriptFlush': {
      const kind = TABLE_SCRIPTS[message.action];
      const table = candidatesOf(data, kind).find((candidate) => candidate.id === message.table);
      return table && { action: 'script', kind, table };
    }
    case 'showStatistics':
    case 'revealTable': {
      const table = (['merge', 'rewrite', 'flush'] as const)
        .flatMap((kind) => candidatesOf(data, kind))
        .find((candidate) => candidate.id === message.table);
      return table && { action: message.action, table };
    }
  }
}
