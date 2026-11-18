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
import { maskSecrets, SECRET_MASK } from '../secrets';
import { favoriteLabel, queryLabel } from '../tree/format';
import { maskSecretStatements, namesSecret } from './history-mask';
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
  /**
   * The values of the parameters it used, by name; `sql` keeps the placeholders. A parameter named like a secret
   * (`namesSecret`) has its value masked.
   */
  readonly parameters?: Readonly<Record<string, string>>;
}

/** A stored statement: masked, at most `MAX_SQL_BYTES` long (`cut` when it was longer), `seq` unique per connection. */
export interface HistoryEntry extends RanStatement {
  readonly seq: number;
  readonly cut?: boolean;
}

/**
 * A statement the user kept as a favourite: a copy of a history entry, so it is masked as that was, with an id unique
 * per connection and a label of the user's own.
 */
export interface Favorite extends HistoryEntry {
  readonly id: number;
  readonly label?: string;
}

// The setting `aantje.queryHistory.size` and its limits; keep the maximum in step with package.json.
const DEFAULT_HISTORY_SIZE = 25;
const MAX_HISTORY_SIZE = 1000;
/** The longest statement kept, in UTF-8 bytes; a longer one is stored cut. */
export const MAX_SQL_BYTES = 64 * 1024;
const MAX_ERROR_LENGTH = 4000;

/** The global state key; its value maps a connection id to its entries, newest first. */
export const HISTORY_KEY = 'aantje.queryHistory';
/** The global state key of the favourites; its value maps a connection id to its favourites, newest first. */
export const FAVORITES_KEY = 'aantje.queryHistory.favorites';
/** The most favourites kept per connection; a new one beyond it drops the oldest. */
export const MAX_FAVORITES = 1000;
const MAX_LABEL_LENGTH = 200;

/** The global state key of the last commit messages per connection (`commit-message.ts`), newest first. */
export const MESSAGES_KEY = 'aantje.commitMessages';
const RECENT_MESSAGES = 5;

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
  parameters: isOptional((value) => isObject(value) && Object.values(value).every(isString)),
}) as (value: unknown) => value is HistoryEntry;

const isFavorite = (value: unknown): value is Favorite =>
  isEntry(value) && isShape({ id: isCount, label: isOptional(isString) })(value);

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
    const list = this.stored(HISTORY_KEY)[connectionId];
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
      return this.write(HISTORY_KEY, connectionId, [...added, ...this.entries(connectionId)].slice(0, size));
    } catch (error) {
      // A run must not fail because its history could not be written.
      this.log('The Query History could not record a run.', error);
      return Promise.resolve();
    }
  }

  /** The favourites of a connection, newest first; they are kept apart from the rotation of the entries. */
  favorites(connectionId: string): readonly Favorite[] {
    const list = this.stored(FAVORITES_KEY)[connectionId];
    return Array.isArray(list) ? list.filter(isFavorite).slice(0, MAX_FAVORITES) : [];
  }

  /**
   * Keeps a copy of the entry as the newest favourite; undefined when a favourite of the connection already holds the
   * same statement.
   */
  async addFavorite(connectionId: string, entry: HistoryEntry): Promise<Favorite | undefined> {
    const favorites = this.favorites(connectionId);
    if (favorites.some(({ sql }) => sql === entry.sql)) return undefined;
    const id = favorites.reduce((max, favorite) => Math.max(max, favorite.id), 0) + 1;
    const favorite: Favorite = { ...entry, id };
    await this.write(FAVORITES_KEY, connectionId, [favorite, ...favorites].slice(0, MAX_FAVORITES));
    return favorite;
  }

  /**
   * Whether another favourite of the connection already shows the name `label` that the favourite `id` would get. Names
   * are compared as the tree shows them (a favourite without a name shows its statement), trimmed and ignoring case.
   * An empty name shows the statement again and is never taken.
   */
  favoriteNameTaken(connectionId: string, id: number, label: string): boolean {
    return this.nameTaken(connectionId, id, this.labelText(label));
  }

  /**
   * Gives a favourite a label of its own; an empty or missing label shows the statement again. Resolves false, and
   * stores nothing, when another favourite of the connection shows that name already (`favoriteNameTaken`).
   */
  async renameFavorite(connectionId: string, id: number, label: string | undefined): Promise<boolean> {
    const text = label === undefined ? '' : this.labelText(label);
    if (this.nameTaken(connectionId, id, text)) return false;
    await this.write(
      FAVORITES_KEY,
      connectionId,
      this.favorites(connectionId).map((favorite) => {
        if (favorite.id !== id) return favorite;
        const { label: _old, ...rest } = favorite;
        return text === '' ? rest : { ...rest, label: text };
      }),
    );
    return true;
  }

  removeFavorite(connectionId: string, id: number): Promise<void> {
    return this.write(
      FAVORITES_KEY,
      connectionId,
      this.favorites(connectionId).filter((favorite) => favorite.id !== id),
    );
  }

  /** The last commit messages of a connection, newest first, at most five; none while the history is off. */
  recentMessages(connectionId: string): readonly string[] {
    const list = this.size() === 0 ? undefined : this.stored(MESSAGES_KEY)[connectionId];
    return Array.isArray(list)
      ? list.filter((message): message is string => typeof message === 'string').slice(0, RECENT_MESSAGES)
      : [];
  }

  /** Keeps a commit message as the newest of its connection; nothing while the history is off. */
  rememberMessage(connectionId: string, message: string): Promise<void> {
    if (this.size() === 0) return Promise.resolve();
    const others = this.recentMessages(connectionId).filter((known) => known !== message);
    return this.saveMessages(connectionId, [message, ...others].slice(0, RECENT_MESSAGES));
  }

  /** Clear Query History: the entries and the commit messages go, the favourites stay. */
  async clearEntries(connectionId: string): Promise<void> {
    await this.write(HISTORY_KEY, connectionId, []);
    await this.saveMessages(connectionId, []);
  }

  /** The removal of a connection: its entries, its favourites and its commit messages go. */
  async clear(connectionId: string): Promise<void> {
    await this.write(HISTORY_KEY, connectionId, []);
    await this.write(FAVORITES_KEY, connectionId, []);
    await this.saveMessages(connectionId, []);
  }

  /**
   * Keeps the newest `size` entries per connection; with 0 the stored history goes, the favourites and the commit
   * messages with it.
   */
  async trim(): Promise<void> {
    const size = this.size();
    const all = this.stored(HISTORY_KEY);
    if (size === 0) {
      for (const key of [HISTORY_KEY, FAVORITES_KEY]) {
        if (Object.keys(this.stored(key)).length > 0) await this.save(key, undefined, undefined);
      }
      if (Object.keys(this.stored(MESSAGES_KEY)).length > 0) await this.saveMessages(undefined, []);
      return;
    }
    for (const connectionId of Object.keys(all)) {
      const list = all[connectionId];
      if (Array.isArray(list) && list.length > size)
        await this.write(HISTORY_KEY, connectionId, this.entries(connectionId));
    }
  }

  /** The listener gets the connection whose history changed, or undefined for all. */
  onDidChange(listener: (connectionId: string | undefined) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  /** A label as it is stored: without the secrets that aantje knows, trimmed, at most `MAX_LABEL_LENGTH` characters. */
  private labelText(label: string): string {
    return this.redact(label).trim().slice(0, MAX_LABEL_LENGTH);
  }

  /** `text` is a stored label (`labelText`). */
  private nameTaken(connectionId: string, id: number, text: string): boolean {
    if (text === '') return false;
    const name = queryLabel(text).toLowerCase();
    return this.favorites(connectionId).some(
      (favorite) => favorite.id !== id && favoriteLabel(favorite).toLowerCase() === name,
    );
  }

  private stored(key: string): Record<string, unknown> {
    const value = this.memento.get(key);
    return isObject(value) ? value : {};
  }

  // The messages of one connection, or with `undefined` none of any.
  private async saveMessages(connectionId: string | undefined, messages: readonly string[]): Promise<void> {
    const rest = Object.fromEntries(
      Object.entries(this.stored(MESSAGES_KEY)).filter(
        ([id]) => connectionId !== undefined && id !== connectionId,
      ),
    );
    const next =
      connectionId !== undefined && messages.length > 0 ? { ...rest, [connectionId]: messages } : rest;
    try {
      await this.memento.update(MESSAGES_KEY, Object.keys(next).length > 0 ? next : undefined);
    } catch (error) {
      this.log('The commit messages could not be saved.', error);
    }
  }

  private write(key: string, connectionId: string, entries: readonly HistoryEntry[]): Promise<void> {
    const rest = Object.fromEntries(Object.entries(this.stored(key)).filter(([id]) => id !== connectionId));
    const next = entries.length > 0 ? { ...rest, [connectionId]: entries } : rest;
    return this.save(key, Object.keys(next).length > 0 ? next : undefined, connectionId);
  }

  // The memento takes the value at once and persists it later, so a read right after sees it.
  private async save(key: string, value: unknown, connectionId: string | undefined): Promise<void> {
    const saving = this.memento.update(key, value);
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
  const parameters =
    ran.parameters &&
    Object.fromEntries(
      Object.entries(ran.parameters).map(([name, value]) => [
        name,
        maskSecrets(mask(value.slice(0, MAX_ERROR_LENGTH)), hidden),
      ]),
    );
  return {
    ...ran,
    sql,
    ...(sql.length < text.length || ran.sql.length > 2 * MAX_SQL_BYTES ? { cut: true } : {}),
    ...(error === undefined ? {} : { error: error.slice(0, MAX_ERROR_LENGTH) }),
    ...(parameters === undefined ? {} : { parameters }),
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
  private current: Pick<RanStatement, 'sql' | 'startedAt' | 'parameters'> | undefined;

  constructor(
    private readonly script: string,
    private readonly now: () => number,
    /** The values of the parameters of the run by name, as the dialog took them. */
    private readonly values: Readonly<Record<string, string>> = {},
  ) {}

  /** `cancelled`: the user cancelled the run, so an error ends the statement as cancelled. */
  event(event: SqlEvent, cancelled: boolean): void {
    switch (event.kind) {
      case 'start':
        this.current = {
          sql: event.sql,
          startedAt: this.now(),
          ...(event.parameters && { parameters: this.shown(event.parameters) }),
        };
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

  // The values of the named parameters, a secret one masked.
  private shown(names: readonly string[]): Record<string, string> {
    return Object.fromEntries(
      names.map((name) => [name, namesSecret(name) ? SECRET_MASK : (this.values[name] ?? '')]),
    );
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
