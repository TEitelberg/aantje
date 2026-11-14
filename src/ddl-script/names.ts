import { foldIdentifier, qualifiedName } from '../catalog/ddl';
import { withoutInvisible } from '../markdown';

// Catalog names as the scripts match them and as their comment lines and pickers show them. A name is data of whoever
// writes the catalog: in a comment line it stays on one line, and a picker draws no icon for it.

/** The first item of each name, by `foldIdentifier`; DuckDB allows no second one, a broken catalog may have it. */
export function indexByName<T extends { readonly name: string }>(items: readonly T[]): Map<string, T> {
  const found = new Map<string, T>();
  for (const item of items) {
    if (!found.has(foldIdentifier(item.name))) found.set(foldIdentifier(item.name), item);
  }
  return found;
}

// What can stand next to a name in an expression and be part of it.
const WORD = /[\p{L}\p{N}_$]/u;

/**
 * True when the expression can name the column: the name as a whole word or in double quotes, A to Z in either case.
 * It errs towards true; a name inside a string literal counts too.
 */
export function mentions(expression: string, name: string): boolean {
  const text = foldIdentifier(expression);
  const key = foldIdentifier(name);
  if (key === '') return false;
  if (text.includes(`"${key.replaceAll('"', '""')}"`)) return true;
  for (let at = text.indexOf(key); at !== -1; at = text.indexOf(key, at + 1)) {
    if (!WORD.test(text[at - 1] ?? ' ') && !WORD.test(text[at + key.length] ?? ' ')) return true;
  }
  return false;
}

/** Catalog text for an SQL comment or a title, on one line and without characters that hide text. */
export const commentText = (text: string): string => withoutInvisible(text);

/** A quoted, qualified name for an SQL comment, e.g. `"sales"."orders"`, on one line. */
export const commentName = (...parts: string[]): string => commentText(qualifiedName(...parts));
