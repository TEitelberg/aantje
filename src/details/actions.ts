import type { DetailsData, DetailsMacro, DetailsObject, DetailsView } from './model';
import type { DetailsAction } from './protocol';

/** What a request of the page asks for: an action on a row that was sent, or Copy of the list as the page shows it. */
export type DetailsPlan =
  | { readonly action: 'copy'; readonly view: DetailsView }
  | {
      readonly action: Exclude<DetailsAction['action'], 'copy'>;
      readonly row: DetailsObject | DetailsMacro;
      readonly kind: 'table' | 'view' | 'macro';
    };

// What each action needs of its row: a table, a relation (table or view), or any row.
const NEEDS: Readonly<Record<Exclude<DetailsAction['action'], 'copy'>, 'table' | 'relation' | 'any'>> = {
  showInTree: 'any',
  showDependencies: 'any',
  preview: 'relation',
  showStatistics: 'table',
  showSchemaHistory: 'table',
  scriptMerge: 'table',
  scriptRewrite: 'table',
  scriptFlush: 'table',
};

/** The plan of a request; undefined for a row that was not sent, or an action its kind has not. */
export function planDetailsAction(data: DetailsData, request: DetailsAction): DetailsPlan | undefined {
  if (request.action === 'copy') return request.view ? { action: 'copy', view: request.view } : undefined;
  const { kind, id } = request;
  const row =
    kind === 'macro'
      ? data.macros.find((macro) => macro.id === id)
      : data.objects.find((object) => object.kind === kind && object.id === id);
  const needs = NEEDS[request.action];
  if (!row || kind === undefined) return undefined;
  if ((needs === 'table' && kind !== 'table') || (needs === 'relation' && kind === 'macro')) return undefined;
  return { action: request.action, row, kind };
}
