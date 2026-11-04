import { lakeScript, tableScript } from '../maintenance';
import type { MaintenanceKind, TableMaintenance } from '../maintenance';
import type { CheckId, FindingScope, FixStep, HealthFinding } from './model';

const LAKE_FIXES: Partial<Record<CheckId, MaintenanceKind>> = {
  'catalog.cleanup-overdue': 'cleanup',
  'catalog.cleanup-pending': 'cleanup',
  'catalog.many-snapshots': 'expire',
  'storage.file-orphaned': 'orphans',
};

const TABLE_FIXES: Partial<Record<CheckId, TableMaintenance>> = {
  'catalog.small-files': 'merge',
  'catalog.large-inlined-data': 'flush',
};

const STEPS: Partial<Record<MaintenanceKind, FixStep>> = {
  expire: 'expire',
  cleanup: 'cleanup',
  orphans: 'orphans',
};

/**
 * The maintenance script of a check that maintenance can fix, written by the builders of the Maintenance menu:
 * the destructive calls start as a dry run and keep the real call commented out.
 */
export function maintenanceFix(
  check: CheckId,
  scope: FindingScope,
): Pick<HealthFinding, 'fixSql' | 'fixStep'> | undefined {
  if (scope.kind === 'table') {
    const kind = TABLE_FIXES[check];
    return kind && scope.schema !== ''
      ? { fixSql: tableScript(kind, scope.schema, scope.name).join('\n'), fixStep: 'compact' }
      : undefined;
  }
  const kind = LAKE_FIXES[check];
  return kind && { fixSql: lakeScript(kind).join('\n'), fixStep: STEPS[kind] };
}
