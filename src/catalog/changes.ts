/** What a snapshot did to an object. */
export type ChangeAction =
  | 'created'
  | 'dropped'
  | 'altered'
  | 'inserted'
  | 'deleted'
  | 'inlined_insert'
  | 'inlined_delete'
  | 'flushed_inlined'
  | 'compacted'
  | 'merged'
  | 'rewritten'
  | 'expired'
  | 'unknown';

export type ChangeObject =
  'schema' | 'table' | 'view' | 'scalar_macro' | 'table_macro' | 'snapshot_tag' | 'snapshot';

/** One entry of `ducklake_snapshot_changes.changes_made`. */
export interface ChangeEntry {
  /** Text before the first colon (all of it when there is none), e.g. `inserted_into_table`. */
  readonly token: string;
  readonly action: ChangeAction;
  /** Null when the entry is not understood. */
  readonly object: ChangeObject | null;
  /** Argument of an id token (`altered_table:12`, `expired_snapshot:5`); null otherwise. */
  readonly id: number | null;
  /** Argument of a name token (`created_table:"sales"."orders"` is `['sales', 'orders']`); null otherwise. */
  readonly name: readonly string[] | null;
  /** The entry as stored. */
  readonly raw: string;
}

// Verb and object in two parts, so that a change whose object the catalog named (table history, snapshot changes)
// reads like its entry: "Inserted into" + "table". One table for the tree, the pickers and the reports.
const ACTION_TEXT: Readonly<Record<ChangeAction | 'renamed', string>> = {
  created: 'Created',
  dropped: 'Dropped',
  altered: 'Altered',
  renamed: 'Renamed',
  inserted: 'Inserted into',
  deleted: 'Deleted from',
  inlined_insert: 'Inserted inlined rows into',
  inlined_delete: 'Deleted inlined rows from',
  flushed_inlined: 'Flushed inlined data of',
  compacted: 'Compacted',
  merged: 'Merged adjacent files of',
  rewritten: 'Rewrote data files of',
  expired: 'Expired',
  unknown: 'Changed',
};

const OBJECT_TEXT: Readonly<Record<ChangeObject, string>> = {
  schema: 'schema',
  table: 'table',
  view: 'view',
  scalar_macro: 'scalar macro',
  table_macro: 'table macro',
  snapshot_tag: 'snapshot tag',
  snapshot: 'snapshot',
};

// The actions that only move files or snapshots; a Record, so that a new action has to be sorted in.
const MAINTENANCE: Readonly<Record<ChangeAction | 'renamed', boolean>> = {
  created: false,
  dropped: false,
  altered: false,
  renamed: false,
  inserted: false,
  deleted: false,
  inlined_insert: false,
  inlined_delete: false,
  flushed_inlined: true,
  compacted: true,
  merged: true,
  rewritten: true,
  expired: true,
  unknown: false,
};

/** Whether the action is maintenance: it flushes, compacts, merges or rewrites files, or expires a snapshot. */
export const isMaintenanceAction = (action: ChangeAction | 'renamed'): boolean => MAINTENANCE[action];

/** What a snapshot did to one object, without its name: `Inserted into table`. */
export function describeAction(action: ChangeAction | 'renamed', object: ChangeObject): string {
  return `${ACTION_TEXT[action]} ${OBJECT_TEXT[object]}`;
}

interface Known {
  readonly action: ChangeAction;
  readonly object: ChangeObject;
  readonly argument: 'name' | 'id';
}

const term = (action: ChangeAction, object: ChangeObject, argument: 'name' | 'id'): Known => ({
  action,
  object,
  argument,
});

// DuckLake creates these by name and drops them by id; the object is the suffix of the token.
const NAMED_OBJECTS = ['schema', 'table', 'view', 'scalar_macro', 'table_macro'] as const;

const FLUSHED = term('flushed_inlined', 'table', 'id');

// The DuckLake specification plus tokens only the extension source knows (tags, expiry, `flushed_inlined`).
const VOCABULARY = new Map<string, Known>([
  ...NAMED_OBJECTS.flatMap((object): [string, Known][] => [
    [`created_${object}`, term('created', object, 'name')],
    [`dropped_${object}`, term('dropped', object, 'id')],
  ]),
  ['altered_table', term('altered', 'table', 'id')],
  ['altered_view', term('altered', 'view', 'id')],
  ['inserted_into_table', term('inserted', 'table', 'id')],
  ['deleted_from_table', term('deleted', 'table', 'id')],
  ['inlined_insert', term('inlined_insert', 'table', 'id')],
  ['inlined_delete', term('inlined_delete', 'table', 'id')],
  ['flushed_inlined', FLUSHED],
  ['inline_flush', FLUSHED],
  ['compacted_table', term('compacted', 'table', 'id')],
  ['merge_adjacent', term('merged', 'table', 'id')],
  ['rewrite_delete', term('rewritten', 'table', 'id')],
  ['created_tag', term('created', 'snapshot_tag', 'name')],
  ['dropped_tag', term('dropped', 'snapshot_tag', 'name')],
  ['expired_snapshot', term('expired', 'snapshot', 'id')],
]);

// SQL identifier syntax: "sales"."orders", a quote inside a name doubled.
const QUOTED_NAME = /^"(?:[^"]|"")*"(?:\."(?:[^"]|"")*")*$/;
const DIGITS = /^\d+$/;

function parseName(text: string): string[] | undefined {
  if (!QUOTED_NAME.test(text)) {
    return undefined;
  }
  const parts = text.matchAll(/"((?:[^"]|"")*)"/g);
  return Array.from(parts, ([, part = '']) => part.replaceAll('""', '"'));
}

/**
 * Splits `changes_made` into entries (a comma inside a quoted name does not split); unparsable ones become `unknown`.
 */
export function parseChanges(changes: string | null): ChangeEntry[] {
  const entries = (changes ?? '').match(/(?:[^,"]|"[^"]*(?:"|$))+/g) ?? [];
  return entries.map(parseChange);
}

function parseChange(raw: string): ChangeEntry {
  // `s`: a quoted name in the argument may contain line breaks.
  const [, token = raw, argument = ''] = /^([^:]*):(.*)$/s.exec(raw) ?? [];
  const known = VOCABULARY.get(token);
  if (known?.argument === 'name') {
    const name = parseName(argument);
    // A name of only empty parts is no name; the entry shows as stored.
    if (name && name.join('.') !== '') {
      return { token, action: known.action, object: known.object, id: null, name, raw };
    }
  } else if (known && DIGITS.test(argument) && Number.isSafeInteger(Number(argument))) {
    return { token, action: known.action, object: known.object, id: Number(argument), name: null, raw };
  }
  return { token, action: 'unknown', object: null, id: null, name: null, raw };
}

/** Readable text of one entry: `Created table sales.orders`, `Altered table #2`, `Expired snapshot @5`. */
export function describeChange(entry: ChangeEntry): string {
  const known = VOCABULARY.get(entry.token);
  if (!known || entry.action === 'unknown') {
    return entry.raw;
  }
  if (entry.name) {
    return `${describeAction(known.action, known.object)} ${entry.name.join('.')}`;
  }
  return `${describeAction(known.action, known.object)} ${known.object === 'snapshot' ? '@' : '#'}${entry.id}`;
}
