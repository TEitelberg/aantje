/** Code-unit order: identical on every machine, so lists and scripts do not depend on the locale. */
export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Case-insensitive, numbers by value ("table2" before "table10"). Shared: `localeCompare` with options builds a collator per call. */
export const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
