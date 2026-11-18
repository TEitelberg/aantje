import type { StorageData, StorageTable } from './model';
import type { StorageAction } from './protocol';

type StoragePlan =
  | { readonly action: 'showStatistics' | 'revealTable'; readonly table: StorageTable }
  | { readonly action: 'inspectFiles'; readonly table: StorageTable }
  | { readonly action: 'script'; readonly kind: 'merge' | 'rewrite'; readonly table: StorageTable }
  | { readonly action: 'script'; readonly kind: 'cleanup' | 'expire' }
  | { readonly action: 'showProperties' };

/** The action for a request; undefined for a table that was not sent. */
export function planStorageAction(data: StorageData, message: StorageAction): StoragePlan | undefined {
  switch (message.action) {
    case 'scriptCleanup':
      return { action: 'script', kind: 'cleanup' };
    case 'scriptExpire':
      return { action: 'script', kind: 'expire' };
    case 'showProperties':
      return { action: 'showProperties' };
    default: {
      const table = data.tables.find((candidate) => candidate.id === message.table);
      if (!table) {
        return undefined;
      }
      switch (message.action) {
        case 'scriptMerge':
          return { action: 'script', kind: 'merge', table };
        case 'scriptRewrite':
          return { action: 'script', kind: 'rewrite', table };
        case 'inspectFiles':
          return { action: 'inspectFiles', table };
        default:
          return { action: message.action, table };
      }
    }
  }
}
