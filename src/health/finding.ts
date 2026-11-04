import { LAKE } from '../data/attach';
import { waitText } from '../shell/numbers';
import { CHECKS } from './model';
import { maintenanceFix } from './fix';
import type {
  CheckId,
  EndpointSuggestion,
  FindingScope,
  FixStep,
  HealthFinding,
  HealthSeverity,
} from './model';

/** The metadata catalog DuckLake attaches next to the lake, which the SQL editor attaches as `lake`. */
export const META = `__ducklake_metadata_${LAKE}`;

interface FindingInit {
  readonly severity: HealthSeverity;
  readonly scope: FindingScope;
  /** Tells this finding from others of its check; empty for a whole-lake finding. */
  readonly object?: string;
  readonly title: string;
  readonly detail: string;
  readonly cause: string;
  readonly fix: string;
  readonly inspectSql?: string;
  readonly fixSql?: string;
  readonly fixStep?: FixStep;
  readonly settingKey?: string;
  readonly objectKey?: string;
  readonly suggestion?: EndpointSuggestion;
}

/** Builds a finding of `check`; group and id follow from the check and object. */
export function finding(check: CheckId, init: FindingInit): HealthFinding {
  const { object, ...rest } = init;
  return {
    id: object === undefined || object === '' ? check : `${check}:${object}`,
    check,
    group: CHECKS[check].group,
    ...(rest.fixSql === undefined ? maintenanceFix(check, rest.scope) : {}),
    ...rest,
  };
}

/** The catalog's tables by id, named as at the newest snapshot. */
export type TableNames = ReadonlyMap<number, { readonly schema: string; readonly name: string }>;

/** The scope of a table finding; a table without a catalog row is called by its id. */
export function tableScope(
  id: number,
  names: TableNames,
  fallback?: { schema: string | null; name: string | null },
): FindingScope {
  const known = names.get(id);
  return {
    kind: 'table',
    id,
    schema: known?.schema ?? fallback?.schema ?? '',
    name: known?.name ?? fallback?.name ?? `#${id}`,
  };
}

/** `shop.events`, or `table #7` for a table without a catalog name; `the schema shop`, `the lake`. */
export function qualified(scope: FindingScope): string {
  if (scope.kind === 'lake') return 'the lake';
  if (scope.kind === 'schema') return `the schema ${scope.name}`;
  return scope.schema === '' ? `table ${scope.name}` : `${scope.schema}.${scope.name}`;
}

/** At most `limit` items as text, plus the count of the rest. */
export function listed(items: readonly string[], limit: number): string {
  const shown = items.slice(0, limit).join(', ');
  return items.length > limit ? `${shown} and ${items.length - limit} more` : shown;
}

/** `3 minutes ago`, `2 days ago`: the words of `waitText`, which the Storage report uses for the same wait. */
export function ago(ms: number): string {
  return ms < 60_000 ? 'just now' : `${waitText(ms)} ago`;
}
