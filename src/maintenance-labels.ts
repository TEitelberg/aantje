/** The maintenance scripts that a report page or document points to; each is an entry of the Maintenance menu. */
export type MaintenanceScript = 'expire' | 'cleanup' | 'orphans' | 'merge' | 'rewrite' | 'flush';

/**
 * The names of those entries, as the titles of their commands in `package.json` (`aantje.maintenance<Kind>`) give them;
 * a manifest test keeps the two equal. Pages import this file, so it holds nothing else.
 */
export const MAINTENANCE_LABEL: Readonly<Record<MaintenanceScript, string>> = {
  expire: 'Expire Snapshots',
  cleanup: 'Clean Up Old Files',
  orphans: 'Delete Orphaned Files',
  merge: 'Merge Adjacent Files',
  rewrite: 'Rewrite Data Files',
  flush: 'Flush Inlined Data',
};
