/** Code-unit order: identical on every machine, so lists and scripts do not depend on the locale. */
export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Case-insensitive, numbers by value ("table2" before "table10"). Shared: `localeCompare` with options builds a collator per call. */
export const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Objects by name with `collator`: case-insensitive, numbers by value ("table2" before "table10"). */
export function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  return collator.compare(a.name, b.name);
}

/**
 * The items by `key`, or with `value` what it makes of each, in their order within each group and in the order of
 * first appearance between groups. Linear: each item is appended to its group.
 */
export function groupBy<T, K>(items: Iterable<T>, key: (item: T) => K): Map<K, T[]>;
export function groupBy<T, K, V>(items: Iterable<T>, key: (item: T) => K, value: (item: T) => V): Map<K, V[]>;
export function groupBy<T, K, V>(
  items: Iterable<T>,
  key: (item: T) => K,
  value?: (item: T) => V,
): Map<K, (T | V)[]> {
  const groups = new Map<K, (T | V)[]>();
  for (const item of items) {
    const name = key(item);
    const entry = value ? value(item) : item;
    const group = groups.get(name);
    if (group) {
      group.push(entry);
    } else {
      groups.set(name, [entry]);
    }
  }
  return groups;
}
