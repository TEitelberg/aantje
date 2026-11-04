import type { CatalogEntry, SnapshotId } from '../catalog/model';
import type { TableRef } from '../data/types';
import { isAantjeError } from '../errors';
import type { HealthRequest } from './model';

type HealthReason = 'missing-object' | 'access-denied' | 'connection';

/** The check an error message offers: the failed read's table, when known. */
export interface SuggestedRequest {
  readonly scope: { readonly kind: 'lake' } | { readonly kind: 'table'; readonly table: TableRef };
  readonly depth: 'quick';
  readonly reason: HealthReason;
}

/** The check for a failed read (missing file, refused request, unreachable store or catalog); undefined for other errors. */
export function healthRequestForError(error: unknown): SuggestedRequest | undefined {
  const { code, text, known } = describe(error);
  const reason = reasonOf(code, text);
  if (reason === undefined) {
    return undefined;
  }
  return { scope: known ? { kind: 'table', table: known } : { kind: 'lake' }, depth: 'quick', reason };
}

function describe(error: unknown): { code?: string; text: string; known?: TableRef } {
  if (isAantjeError(error)) {
    return { code: error.code, text: error.userMessage, ...(error.table ? { known: error.table } : {}) };
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return {
      text: error.message,
      ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
    };
  }
  return { text: '' };
}

// A store 404 or a missing local data file, in the wording of DuckDB or aantje. Other "No such file or
// directory" messages (a catalog file, an extension directory) must not match.
const MISSING =
  /HTTP 404|does not exist on this machine|IO Error: Cannot open file "[^"]*": (?:No such file or directory|The system cannot find the (?:file|path) specified)/;

function reasonOf(code: string | undefined, text: string): HealthReason | undefined {
  if (MISSING.test(text)) return 'missing-object';
  if (/HTTP 403|AccessDenied|SignatureDoesNotMatch|InvalidAccessKeyId/.test(text)) return 'access-denied';
  if (
    code === 'CONNECTION_FAILED' ||
    code === 'AUTH_FAILED' ||
    /Could not (connect|resolve)|SSL connect error/.test(text)
  ) {
    return 'connection';
  }
  return undefined;
}

/** Resolves a suggested request; a table missing from `entries` (dropped, renamed since) falls back to the whole lake. */
export function resolveRequest(
  suggestion: SuggestedRequest,
  entries: readonly CatalogEntry[],
  snapshot: SnapshotId,
): HealthRequest {
  if (suggestion.scope.kind === 'table') {
    const { schema, table } = suggestion.scope.table;
    const entry = entries.find(
      (candidate) =>
        candidate.kind === 'table' && candidate.schemaName === schema && candidate.name === table,
    );
    if (entry) {
      return { scope: { kind: 'table', tableId: entry.id }, depth: suggestion.depth, snapshot };
    }
  }
  return { scope: { kind: 'lake' }, depth: suggestion.depth, snapshot };
}
