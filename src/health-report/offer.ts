import type { CatalogReader, SnapshotId } from '../catalog/model';
import { isAantjeError } from '../errors';
import type { FindingScope } from '../health/model';
import { healthRequestForError, resolveRequest } from '../health/request';
import type { SuggestedRequest } from '../health/request';

/** The button that goes with an error message, and the check it starts. */
export interface HealthOffer {
  readonly label: 'Check Table Health' | 'Check Health';
  readonly connectionId: string;
  readonly suggestion: SuggestedRequest;
}

/** A table check when the failed read named a table, a lake check for a connection or store failure, else nothing. */
export function offerFor(error: unknown): HealthOffer | undefined {
  const connectionId = isAantjeError(error) ? error.connectionId : undefined;
  const suggestion = healthRequestForError(error);
  return connectionId === undefined || suggestion === undefined
    ? undefined
    : {
        label: suggestion.scope.kind === 'table' ? 'Check Table Health' : 'Check Health',
        connectionId,
        suggestion,
      };
}

/** The scope of the offered check: the table in the shown or newest snapshot, else the lake. */
export async function scopeForOffer(
  offer: HealthOffer,
  reader: Pick<CatalogReader, 'entries'>,
  shown: SnapshotId,
  latest: SnapshotId | undefined,
): Promise<FindingScope> {
  const { scope } = offer.suggestion;
  if (scope.kind === 'lake') {
    return { kind: 'lake' };
  }
  for (const snapshot of latest === undefined || latest === shown ? [shown] : [shown, latest]) {
    const request = resolveRequest(offer.suggestion, await reader.entries(snapshot), shown);
    if (request.scope.kind === 'table') {
      return {
        kind: 'table',
        id: request.scope.tableId,
        schema: scope.table.schema,
        name: scope.table.table,
      };
    }
  }
  return { kind: 'lake' };
}
