import type { DeletedRead } from '../maintenance/deletes';
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
  | {
      readonly action: 'script';
      readonly kind: 'merge' | 'rewrite' | 'flush';
      readonly table: AdvisorTable;
      /** For a merge, its small files with deleted rows as the advisor counted them. */
      readonly deleted?: DeletedRead;
    }
  | { readonly action: 'showStatistics' | 'revealTable'; readonly table: AdvisorTable }
  | { readonly action: 'showStorage' | 'checkHealth' | 'maintenanceScript' };

const TABLE_SCRIPTS = { scriptMerge: 'merge', scriptRewrite: 'rewrite', scriptFlush: 'flush' } as const;

// The tables of the candidates of each kind: a script is offered only for tables the advisor named for it.
function candidatesOf(data: AdvisorData, kind: 'merge' | 'rewrite' | 'flush'): readonly AdvisorTable[] {
  return data[kind].map((candidate) => candidate.table);
}

// The merge script rewrites what the advisor counted, as its script for all recommendations does. It reads nothing,
// so it is the same while the explorer is not connected. Counts the advisor could not read stay unread (null), so
// that the script says so.
function countedDeletes(data: AdvisorData, table: AdvisorTable): DeletedRead {
  const deleted = data.merge.find((candidate) => candidate.table.id === table.id)?.deleted;
  if (deleted === null) return null;
  return deleted ? [{ tableId: table.id, schema: table.schema, table: table.name, ...deleted }] : [];
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
      return (
        table && {
          action: 'script',
          kind,
          table,
          ...(kind === 'merge' ? { deleted: countedDeletes(data, table) } : {}),
        }
      );
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
