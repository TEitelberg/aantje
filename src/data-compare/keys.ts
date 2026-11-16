import type { CompareSide } from './model';

/** The global state of the extension as the memory of the keys uses it. */
export interface KeyStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

const STATE_KEY = 'aantje.dataCompareKeys';
/** The pairs it keeps; the oldest choice goes first. */
const MAX_PAIRS = 200;

type Pair = Pick<CompareSide, 'connectionId' | 'schema' | 'table'>;

const pairKey = (source: Pair, target: Pair): string =>
  JSON.stringify([
    source.connectionId,
    source.schema,
    source.table,
    target.connectionId,
    target.schema,
    target.table,
  ]);

const isNames = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((name) => typeof name === 'string');

/**
 * The key columns chosen for a pair of tables (empty: whole rows), kept in the global state of the extension. What does
 * not have the stored shape is ignored.
 */
export class CompareKeys {
  constructor(private readonly store: KeyStore) {}

  private all(): [string, string[]][] {
    const stored = this.store.get(STATE_KEY);
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return [];
    return Object.entries(stored).filter((entry): entry is [string, string[]] => isNames(entry[1]));
  }

  /** The key chosen last for these two tables, or undefined when none was. */
  remembered(source: Pair, target: Pair): string[] | undefined {
    const key = pairKey(source, target);
    return this.all().find(([pair]) => pair === key)?.[1];
  }

  /** Remembers the key of these two tables; the newest choice comes last. */
  async remember(source: Pair, target: Pair, columns: readonly string[]): Promise<void> {
    const key = pairKey(source, target);
    const kept = this.all().filter(([pair]) => pair !== key);
    const entries = [...kept, [key, [...columns]] as [string, string[]]].slice(-MAX_PAIRS);
    await this.store.update(STATE_KEY, Object.fromEntries(entries));
  }
}
