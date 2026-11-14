import { LAKE } from '../data/attach';
import { waitText } from '../shell/numbers';
import { CHECKS } from './model';
import { maintenanceFix } from './fix';
import type { StoredFile } from '../catalog/model';
import type { FixStep } from '../maintenance/steps';
import type {
  CheckId,
  ConnectionAction,
  EndpointSuggestion,
  FindingScope,
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
  readonly connectionActions?: readonly ConnectionAction[];
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

/** `data:12`: the key of a file that the storage and the deep group share, and the object of its findings. */
export const fileKey = (file: Pick<StoredFile, 'kind' | 'id'>): string => `${file.kind}:${file.id}`;

/** `data file` or `delete file`. */
export const kindText = (file: Pick<StoredFile, 'kind'>): string =>
  file.kind === 'data' ? 'data file' : 'delete file';

/** The scope of a finding of a file: its table, by the name of the catalog or else by the row of the file. */
export const fileScope = (
  file: Pick<StoredFile, 'tableId' | 'schema' | 'table'>,
  names: TableNames,
): FindingScope => tableScope(file.tableId, names, { schema: file.schema, name: file.table });

/** `shop.events`, or `table #7` for a table without a catalog name; `the schema shop`, `the lake`. */
export function qualified(scope: FindingScope): string {
  if (scope.kind === 'lake') return 'the lake';
  if (scope.kind === 'schema') return `the schema ${scope.name}`;
  return scope.schema === '' ? `table ${scope.name}` : `${scope.schema}.${scope.name}`;
}

/**
 * The first `limit` items of a check and how many more were found. A list that the catalog cut (`cut`: it was asked for
 * one item more than is reported, or said that it has more) counts none: how many are left is unknown, and the group
 * says that a limit was reached.
 */
export function capFindings<T>(
  list: readonly T[],
  limit: number,
  cut = false,
): { shown: T[]; omitted: number } {
  const shown = list.slice(0, limit);
  return { shown, omitted: cut ? 0 : list.length - shown.length };
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
