import { isObject, isString } from '../guards';
import { withoutInvisible } from '../markdown';
import type { NodeRef } from './refs';

// The filters of the explorer by name: set on a connection (the objects of all its schemas), a schema or one of its
// folders Tables, Views and Macros; pure but for the memento.

/** The folders of a schema whose objects a filter narrows. */
export type FilteredFolder = 'tables' | 'views' | 'macros';

/** The filters of one connection by place: `lake`, `s<schema id>` or `s<schema id>/<folder>`, each to its text. */
export type Filters = Readonly<Record<string, string>>;

/** The longest filter text kept. */
export const MAX_FILTER_LENGTH = 200;

/** The workspace state key; its value maps a connection id to its filters. */
export const FILTERS_KEY = 'aantje.treeFilters';

const LAKE = 'lake';
const schemaKey = (schemaId: number): string => `s${schemaId}`;
const folderKey = (schemaId: number, folder: FilteredFolder): string => `${schemaKey(schemaId)}/${folder}`;

const isFiltered = (folder: string): folder is FilteredFolder =>
  folder === 'tables' || folder === 'views' || folder === 'macros';

/** The place of a node that takes a filter of its own; undefined for any other node. */
export function filterKeyOf(ref: NodeRef): string | undefined {
  switch (ref.kind) {
    case 'connection':
      return LAKE;
    case 'schema':
      return schemaKey(ref.schema.id);
    case 'folder':
      return isFiltered(ref.folder) && 'schema' in ref ? folderKey(ref.schema.id, ref.folder) : undefined;
    default:
      return undefined;
  }
}

/** The places whose filter applies to a node, its own first: a folder, its schema, the connection. */
function placesOf(ref: NodeRef): string[] {
  switch (ref.kind) {
    case 'connection':
      return [LAKE];
    case 'schema':
      return [schemaKey(ref.schema.id), LAKE];
    case 'folder':
      return isFiltered(ref.folder) && 'schema' in ref
        ? [folderKey(ref.schema.id, ref.folder), schemaKey(ref.schema.id), LAKE]
        : [];
    default:
      return [];
  }
}

/** The filter that applies to a node and where it is set: the node's own, else its schema's, else the connection's. */
export function appliedFilter(
  filters: Filters,
  ref: NodeRef,
): { readonly key: string; readonly text: string } | undefined {
  const key = placesOf(ref).find((place) => filters[place] !== undefined);
  const text = key === undefined ? undefined : filters[key];
  return key === undefined || text === undefined ? undefined : { key, text };
}

/** The filter set on the node itself; undefined when it has none of its own. */
export function ownFilter(filters: Filters, ref: NodeRef): string | undefined {
  const key = filterKeyOf(ref);
  return key === undefined ? undefined : filters[key];
}

/** The filter for the objects of a folder of a schema, with the test of a name. */
export function folderFilter(
  filters: Filters,
  schemaId: number,
  folder: FilteredFolder,
): { readonly text: string; readonly matches: (name: string) => boolean } | undefined {
  const text = filters[folderKey(schemaId, folder)] ?? filters[schemaKey(schemaId)] ?? filters[LAKE];
  return text === undefined ? undefined : { text, matches: nameMatcher(text) };
}

/**
 * The test of a name: a text with `*` or `?` is a pattern for the whole name (`*` any characters, `?` one), any other
 * text a part of the name; both ignore case.
 */
export function nameMatcher(text: string): (name: string) => boolean {
  const wanted = text.trim().toLowerCase();
  if (!/[*?]/.test(wanted)) return (name) => name.toLowerCase().includes(wanted);
  const pattern = Array.from(wanted);
  return (name) => matchesPattern(pattern, Array.from(name.toLowerCase()));
}

/**
 * Whether a name matches a pattern of `*` and `?` as a whole, by characters (code points). It goes back only to the last
 * `*`, so its time grows with the product of the two lengths at most, never exponentially as a regular expression with
 * many `.*` can (a filter is typed by the user, the names come from the catalog).
 */
function matchesPattern(pattern: readonly string[], name: readonly string[]): boolean {
  let at = 0;
  let of = 0;
  let star = -1;
  let resume = 0;
  while (of < name.length) {
    const wanted = pattern[at];
    if (wanted !== undefined && wanted !== '*' && (wanted === '?' || wanted === name[of])) {
      at += 1;
      of += 1;
    } else if (wanted === '*') {
      star = at;
      resume = of;
      at += 1;
    } else if (star >= 0) {
      at = star + 1;
      resume += 1;
      of = resume;
    } else {
      return false;
    }
  }
  while (pattern[at] === '*') at += 1;
  return at === pattern.length;
}

/** The text of a filter as it is kept: on one line, without control characters, trimmed and shortened. */
export const filterText = (text: string): string =>
  withoutInvisible(text.replace(/\s+/g, ' ')).trim().slice(0, MAX_FILTER_LENGTH);

/** `filter: sales*`, the description of a node that has a filter of its own. */
export const filterDescription = (text: string): string => `filter: ${text}`;

/** The part of VS Code's `Memento` that the filters use. */
export interface FilterMemento {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** The filters of the tree per connection, in the workspace state; a write it cannot make is logged. */
export class TreeFilters {
  constructor(
    private readonly memento: FilterMemento,
    private readonly log: (message: string, error: unknown) => void,
  ) {}

  /** The filters of a connection; a stored value that is no text is skipped. */
  of(connectionId: string): Filters {
    const stored = this.stored()[connectionId];
    if (!isObject(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, string] => isString(entry[1]) && entry[1] !== '',
      ),
    );
  }

  /** Sets the filter of a place; an empty text removes it. */
  set(connectionId: string, key: string, text: string): Promise<void> {
    const kept = filterText(text);
    const rest = Object.fromEntries(Object.entries(this.of(connectionId)).filter(([place]) => place !== key));
    return this.write(connectionId, kept === '' ? rest : { ...rest, [key]: kept });
  }

  /** The removal of a connection: its filters go. */
  forget(connectionId: string): Promise<void> {
    return this.write(connectionId, {});
  }

  private stored(): Record<string, unknown> {
    const value = this.memento.get(FILTERS_KEY);
    return isObject(value) ? value : {};
  }

  private async write(connectionId: string, filters: Filters): Promise<void> {
    const rest = Object.fromEntries(Object.entries(this.stored()).filter(([id]) => id !== connectionId));
    const next = Object.keys(filters).length > 0 ? { ...rest, [connectionId]: filters } : rest;
    try {
      await this.memento.update(FILTERS_KEY, Object.keys(next).length > 0 ? next : undefined);
    } catch (error) {
      this.log('The filter of the tree could not be saved.', error);
    }
  }
}
