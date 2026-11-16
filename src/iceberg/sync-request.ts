// The sync that aantje's MCP server asks for: the internal command that the Iceberg commands register and the MCP tool
// runs, its argument and its answer. Free of the VS Code API.
import { isObject } from '../guards';
import type { CopySource } from './flow';
import type { SyncOutcome } from './sync-flow';

/**
 * Internal command (the leading `_` keeps it out of the manifest, the Command Palette and the keybindings): it opens the
 * question of a sync in VS Code.
 */
export const REQUEST_SYNC = '_aantje.requestIcebergSync';

export interface SyncRequestArgs {
  readonly connectionId: string;
  readonly targetId: string;
  readonly source: CopySource;
}

/**
 * What came of the request: written, nothing to write, not wanted or stopped by the user, failed, or nothing synced
 * there before.
 */
export type RequestedSync =
  | {
      readonly kind: 'synced';
      readonly snapshot: number;
      readonly synced: number;
      /** `schema.table: reason` of the tables that failed. */
      readonly failed: readonly string[];
    }
  | { readonly kind: 'nothing'; readonly snapshot: number }
  | { readonly kind: 'declined' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'uncovered' };

/** The question of a request says where it comes from: the user did not start it in VS Code. */
export const askedByAssistant = (message: string): string =>
  `An assistant asks through aantje's MCP server: ${message}`;

const isSource = (value: unknown): value is CopySource =>
  isObject(value) &&
  (value.kind === 'lake' ||
    (value.kind === 'schema' && typeof value.schema === 'string') ||
    (value.kind === 'table' && typeof value.schema === 'string' && typeof value.table === 'string'));

export const isSyncRequest = (value: unknown): value is SyncRequestArgs =>
  isObject(value) &&
  typeof value.connectionId === 'string' &&
  typeof value.targetId === 'string' &&
  isSource(value.source);

export function requestedOutcome(outcome: SyncOutcome): RequestedSync {
  if (outcome.kind !== 'synced') return outcome;
  const { result } = outcome;
  return {
    kind: 'synced',
    snapshot: result.snapshot,
    synced: result.tables.filter((table) => table.status === 'synced').length,
    failed: result.tables
      .filter((table) => table.status === 'failed')
      .map((table) => `${table.step.record.schema}.${table.step.record.table}: ${table.error ?? 'failed'}`),
  };
}
