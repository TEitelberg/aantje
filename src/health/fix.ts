import type { DeletedFiles } from '../catalog/model';
import { lakeScript, tableScript } from '../maintenance/scripts';
import { STEP_OF } from '../maintenance/steps';
import { FIXES } from './model';
import type { CheckId, FindingScope, HealthFinding } from './model';

/**
 * The maintenance script of a check that maintenance can fix (`FIXES`), written by the builders of the Maintenance
 * menu: the destructive calls start as a dry run and keep the real call commented out. A table script needs the schema
 * name of the table. `deleted`, the files of the table with deleted rows, puts the rewrite before a merge as the menu
 * does (null: not readable, which the script says).
 */
export function maintenanceFix(
  check: CheckId,
  scope: FindingScope,
  deleted?: DeletedFiles | null,
): Pick<HealthFinding, 'fixSql' | 'fixStep'> | undefined {
  const fix = FIXES[check];
  if (scope.kind === 'table') {
    return fix?.level === 'table' && scope.schema !== ''
      ? {
          fixSql: tableScript(fix.kind, scope.schema, scope.name, deleted).join('\n'),
          fixStep: STEP_OF[fix.kind],
        }
      : undefined;
  }
  return fix?.level === 'lake'
    ? { fixSql: lakeScript(fix.kind).join('\n'), fixStep: STEP_OF[fix.kind] }
    : undefined;
}
