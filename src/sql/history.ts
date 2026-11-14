import { wholeNumberOf } from '../data/settings';
import {
  isBoolean,
  isCount,
  isFiniteNumber,
  isObject,
  isOneOf,
  isOptional,
  isShape,
  isString,
} from '../guards';
import { maskSecrets } from '../secrets';
import { maskSecretStatements } from './history-mask';
import type { SqlEvent } from './session';

/** How a statement of the history ended. */
export type HistoryStatus = 'ok' | 'failed' | 'cancelled';

/** A statement as the SQL editor ran it, before it is masked and stored. */
export interface RanStatement {
  readonly sql: string;
  /** Milliseconds since 1970 when it started. */
  readonly startedAt: number;
  readonly elapsedMs: number;
  readonly status: HistoryStatus;
  /** The rows of its result; `partial` when the result had more than were read. */
  readonly rows?: number;
  readonly partial?: boolean;
  /** The rows it inserted, updated or deleted. */
  readonly changed?: number;
  readonly error?: string;
}

/** A stored statement: masked, at most `MAX_SQL_BYTES` long (`cut` when it was longer), `seq` unique per connection. */
export interface HistoryEntry extends RanStatement {
  readonly seq: number;
  readonly cut?: boolean;
}

// The setting `aantje.queryHistory.size` and its limits; keep the maximum in step with package.json.
const DEFAULT_HISTORY_SIZE = 25;
const MAX_HISTORY_SIZE = 1000;
/** The longest statement kept, in UTF-8 bytes; a longer one is stored cut. */
export const MAX_SQL_BYTES = 64 * 1024;
const MAX_ERROR_LENGTH = 4000;

/** The global state key; its value maps a connection id to its entries, newest first. */
export const HISTORY_KEY = 'aantje.queryHistory';

/** The entries per connection; 0 records nothing and keeps nothing. */
export function historySizeOf(value: unknown): number {
  return wholeNumberOf(value, { min: 0, max: MAX_HISTORY_SIZE, fallback: DEFAULT_HISTORY_SIZE });
}

/** The part of VS Code's `Memento` that the history uses. */
export interface HistoryMemento {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

const isEntry = isShape({
  sql: isString,
  seq: isCount,
  startedAt: isFiniteNumber,
  elapsedMs: isFiniteNumber,
  status: isOneOf('ok', 'failed', 'cancelled'),
  rows: isOptional(isCount),
  partial: isOptional(isBoolean),
  changed: isOptional(isCount),
  error: isOptional(isString),
  cut: isOptional(isBoolean),
}) as (value: unknown) => value is HistoryEntry;

/**
 * The statements that the SQL editor ran, per connection, in VS Code's global state of this machine. The text is masked
 * before it is stored; the store never rejects a write it cannot make, it logs it.
 */
export class QueryHistory {
  private readonly listeners = new Set<(connectionId: string | undefined) => void>();

  constructor(
    private readonly memento: HistoryMemento,
    /** `aantje.queryHistory.size`, read at every call. */
    private readonly size: () => number,
    private readonly log: (message: string, error: unknown) => void,
    /** Masks every secret aantje knows on this machine, also when the run's session never opened. */
    private readonly redact: (text: string) => string = (text) => text,
  ) {}

  /** Whether the history is on; with size 0 the tree shows no folder. */
  shown(): boolean {
    return this.size() > 0;
  }

  /** The entries of a connection, newest first; a stored value that is not an entry is skipped. */
  entries(connectionId: string): readonly HistoryEntry[] {
    const list = this.stored()[connectionId];
    return Array.isArray(list) ? list.filter(isEntry).slice(0, this.size()) : [];
  }

  /** Adds the statements of one run; `mask` hides the connection's secrets, as the session does in its messages. */
  record(connectionId: string, ran: readonly RanStatement[], mask: (text: string) => string): Promise<void> {
    try {
      const size = this.size();
      if (size === 0 || ran.length === 0) return Promise.resolve();
      let seq = this.entries(connectionId)[0]?.seq ?? 0;
      const hide = (text: string): string => this.redact(mask(text));
      const added = ran.map((statement) => ({ ...stored(statement, hide), seq: ++seq })).reverse();
      return this.write(connectionId, [...added, ...this.entries(connectionId)].slice(0, size));
    } catch (error) {
      // A run must not fail because its history could not be written.
      this.log('The Query History could not record a run.', error);
      return Promise.resolve();
    }
  }

  /** Clear Query History, and the removal of a connection. */
  clear(connectionId: string): Promise<void> {
    return this.write(connectionId, []);
  }

  /** Keeps the newest `size` entries per connection; with 0 the stored history goes. */
  async trim(): Promise<void> {
    const size = this.size();
    const all = this.stored();
    if (size === 0) {
      if (Object.keys(all).length > 0) await this.save(undefined, undefined);
      return;
    }
    for (const connectionId of Object.keys(all)) {
      const list = all[connectionId];
      if (Array.isArray(list) && list.length > size)
        await this.write(connectionId, this.entries(connectionId));
    }
  }

  /** The listener gets the connection whose history changed, or undefined for all. */
  onDidChange(listener: (connectionId: string | undefined) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  private stored(): Record<string, unknown> {
    const value = this.memento.get(HISTORY_KEY);
    return isObject(value) ? value : {};
  }

  private write(connectionId: string, entries: readonly HistoryEntry[]): Promise<void> {
    const rest = Object.fromEntries(Object.entries(this.stored()).filter(([id]) => id !== connectionId));
    const next = entries.length > 0 ? { ...rest, [connectionId]: entries } : rest;
    return this.save(Object.keys(next).length > 0 ? next : undefined, connectionId);
  }

  // The memento takes the value at once and persists it later, so a read right after sees it.
  private async save(value: unknown, connectionId: string | undefined): Promise<void> {
    const saving = this.memento.update(HISTORY_KEY, value);
    for (const listener of [...this.listeners]) listener(connectionId);
    try {
      await saving;
    } catch (error) {
      this.log('The Query History could not be saved.', error);
    }
  }
}

/** The entry of a statement: its secrets masked, then cut at `MAX_SQL_BYTES`. */
function stored(ran: RanStatement, mask: (text: string) => string): Omit<HistoryEntry, 'seq'> {
  // Masking a huge text costs time; what lies beyond twice the limit is cut off anyway.
  const { text, hidden } = maskSecretStatements(mask(ran.sql.slice(0, 2 * MAX_SQL_BYTES)));
  const sql = cutToBytes(text, MAX_SQL_BYTES);
  const error = ran.error === undefined ? undefined : maskSecrets(mask(ran.error), hidden);
  return {
    ...ran,
    sql,
    ...(sql.length < text.length || ran.sql.length > 2 * MAX_SQL_BYTES ? { cut: true } : {}),
    ...(error === undefined ? {} : { error: error.slice(0, MAX_ERROR_LENGTH) }),
  };
}

/** The longest start of the text that has at most `limit` bytes in UTF-8, without splitting a character. */
function cutToBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > limit) break;
    end += character.length;
  }
  return text.slice(0, end);
}

/**
 * The statements of one run, from its events: each `start` opens one, its result set, message or error ends it. An error
 * without a statement (the script did not parse, the session did not open) makes the whole script one entry.
 */
export class RunRecord {
  private readonly ran: RanStatement[] = [];
  private current: { sql: string; startedAt: number } | undefined;

  constructor(
    private readonly script: string,
    private readonly now: () => number,
  ) {}

  /** `cancelled`: the user cancelled the run, so an error ends the statement as cancelled. */
  event(event: SqlEvent, cancelled: boolean): void {
    switch (event.kind) {
      case 'start':
        this.current = { sql: event.sql, startedAt: this.now() };
        break;
      case 'resultSet':
        this.end('ok', event.elapsedMs, {
          rows: event.rows.length,
          ...(event.truncated && { partial: true }),
        });
        break;
      case 'message':
        this.end(
          'ok',
          event.elapsedMs,
          event.rowsAffected === undefined ? {} : { changed: event.rowsAffected },
        );
        break;
      case 'error':
        // An error after the last statement (a results view that failed) belongs to none.
        if (!this.current && this.ran.length > 0) break;
        this.current ??= { sql: this.script, startedAt: this.now() };
        this.end(cancelled ? 'cancelled' : 'failed', undefined, { error: event.message });
        break;
      default:
        break;
    }
  }

  /** The statements of the run in the order they ran; one that never ended counts as failed or cancelled. */
  finish(cancelled: boolean): readonly RanStatement[] {
    if (this.current) this.end(cancelled ? 'cancelled' : 'failed', undefined, {});
    return this.ran;
  }

  private end(
    status: HistoryStatus,
    elapsedMs: number | undefined,
    facts: Pick<RanStatement, 'rows' | 'partial' | 'changed' | 'error'>,
  ): void {
    const { current } = this;
    if (!current) return;
    this.current = undefined;
    this.ran.push({ ...current, elapsedMs: elapsedMs ?? this.now() - current.startedAt, status, ...facts });
  }
}
