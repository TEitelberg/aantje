import { isCount, isOneOf, isShape, isString } from '../guards';
import type { NodeRef } from '../tree/refs';

/** What a report is about: the whole lake, or the tables of one schema. */
export type ReportScope =
  { readonly kind: 'lake' } | { readonly kind: 'schema'; readonly id: number; readonly name: string };

export const LAKE_SCOPE: ReportScope = { kind: 'lake' };

/** Guard for a scope in the data a page receives. */
export const isReportScope = (value: unknown): boolean =>
  isShape({ kind: isOneOf('lake') })(value) ||
  isShape({ kind: isOneOf('schema'), id: isCount, name: isString })(value);

/** The scope of the node a report is opened on; undefined for a node that has no such report. */
export function scopeOfNode(ref: NodeRef): ReportScope | undefined {
  if (ref.kind === 'connection') return LAKE_SCOPE;
  return ref.kind === 'schema' ? { kind: 'schema', id: ref.schema.id, name: ref.schema.name } : undefined;
}

/** The key of a panel: the connection and, for a schema, its id. */
export const scopeKey = (connectionId: string, scope: ReportScope): string =>
  JSON.stringify([connectionId, scope.kind === 'schema' ? scope.id : 'lake']);

/** ` · schema shop` after a title; nothing for the lake. */
export const scopeSuffix = (scope: ReportScope): string =>
  scope.kind === 'schema' ? ` · schema ${scope.name}` : '';

/** The schema's name for a Markdown title; undefined for the lake. */
export const scopeSchema = (scope: ReportScope): string | undefined =>
  scope.kind === 'schema' ? scope.name : undefined;

/** `(lake-wide)` after the label of a figure that stays the lake's in a schema report. */
export const lakeWide = (scope: ReportScope, label: string): string =>
  scope.kind === 'schema' ? `${label} (lake-wide)` : label;
