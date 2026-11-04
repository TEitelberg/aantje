// The functions of DuckLake: the global `ducklake_*` ones from the generated `ducklake-vocabulary.ts`, the ones behind
// the lake's name (`lake.snapshots()`) by hand, and the texts of both.
import { DUCKLAKE_FUNCTIONS } from './ducklake-vocabulary';
import type { FunctionInfo, FunctionKind, Parameter } from './vocabulary';

/** A function as `scripts/ducklake-vocabulary.mjs` reads it from the engine. */
export interface GeneratedFunction {
  readonly name: string;
  readonly kind: FunctionKind;
  readonly overloads: readonly {
    readonly parameters: readonly { readonly name: string; readonly type: string }[];
    /** Passed as `name => value` after the positional ones. */
    readonly named: readonly { readonly name: string; readonly type: string }[];
  }[];
}

interface LakeText {
  readonly description: string;
  /** Changes the lake or deletes files: offered after CALL, not after FROM. */
  readonly procedure?: true;
  /** A call of the global function; `{lake}` stands for the lake name. `sql-language.test.ts` runs it on a lake. */
  readonly example: string;
}

const SNAPSHOT_RANGE = 'between two snapshots (ids or times, both included)';

/** By the name without `ducklake_`. */
const TEXTS: Readonly<Record<string, LakeText>> = {
  add_data_files: {
    description:
      'Adds existing Parquet files to a table as its data files, where they are: they are not copied. `schema` names the schema of the table.',
    procedure: true,
    example: "CALL ducklake_add_data_files('{lake}', 'orders', 'new_orders.parquet')",
  },
  cleanup_old_files: {
    description:
      'Deletes the data files that no snapshot needs any more and that are older than `older_than` (default: the option `delete_older_than`). `cleanup_all => true` deletes all of them, `dry_run => true` only lists them.',
    procedure: true,
    example: "CALL ducklake_cleanup_old_files('{lake}', dry_run => true)",
  },
  current_snapshot: {
    description: 'The id of the current snapshot.',
    example: "SELECT * FROM ducklake_current_snapshot('{lake}')",
  },
  delete_orphaned_files: {
    description:
      'Deletes the files in the data path that the catalog does not know and that are older than `older_than` (default: the option `delete_older_than`). `dry_run => true` only lists them.',
    procedure: true,
    example: "CALL ducklake_delete_orphaned_files('{lake}', dry_run => true)",
  },
  expire_snapshots: {
    description:
      'Expires the snapshots older than `older_than` (default: the option `expire_older_than`) or those in `versions`; an expired snapshot can no longer be read. `dry_run => true` only lists them.',
    procedure: true,
    example:
      "CALL ducklake_expire_snapshots('{lake}', older_than => now() - INTERVAL 7 DAY, dry_run => true)",
  },
  flush_inlined_data: {
    description:
      'Writes the rows that the lake keeps in the catalog (inlined data) to Parquet files; `schema_name` and `table_name` limit it.',
    procedure: true,
    example: "CALL ducklake_flush_inlined_data('{lake}')",
  },
  last_committed_snapshot: {
    description: 'The id of the snapshot that this connection committed last.',
    example: "SELECT * FROM ducklake_last_committed_snapshot('{lake}')",
  },
  list_files: {
    description:
      'The data files of a table with their sizes and delete files; `schema` names its schema, `snapshot_version` or `snapshot_time` a snapshot.',
    example: "SELECT * FROM ducklake_list_files('{lake}', 'orders')",
  },
  merge_adjacent_files: {
    description: 'Merges small adjacent data files into larger ones, of the whole lake or of one table.',
    procedure: true,
    example: "CALL ducklake_merge_adjacent_files('{lake}')",
  },
  options: {
    description: 'The options of the lake with description, value and scope.',
    example: "SELECT * FROM ducklake_options('{lake}')",
  },
  rewrite_data_files: {
    description:
      'Rewrites the data files in which many rows are deleted (`delete_threshold`), of the whole lake or of one table.',
    procedure: true,
    example: "CALL ducklake_rewrite_data_files('{lake}')",
  },
  set_commit_message: {
    description: 'Sets the author and the message of the snapshot of the running transaction.',
    procedure: true,
    example: "CALL ducklake_set_commit_message('{lake}', 'me', 'Nightly import')",
  },
  set_option: {
    description: 'Changes an option of the lake, for all tables, a schema or one table.',
    procedure: true,
    example: "CALL ducklake_set_option('{lake}', 'data_inlining_row_limit', 0)",
  },
  settings: {
    description: 'The catalog type, the extension version and the data path of the lake.',
    example: "SELECT * FROM ducklake_settings('{lake}')",
  },
  snapshots: {
    description: 'Every snapshot of the lake: id, time, schema version, changes, author and commit message.',
    example: "SELECT * FROM ducklake_snapshots('{lake}')",
  },
  table_changes: {
    description: `The rows of a table that changed ${SNAPSHOT_RANGE}, with \`snapshot_id\`, \`rowid\` and \`change_type\`: insert, delete, update_preimage or update_postimage.`,
    example: "SELECT * FROM ducklake_table_changes('{lake}', 'main', 'orders', 2, 4)",
  },
  table_deletions: {
    description: `The rows that were deleted from a table ${SNAPSHOT_RANGE}.`,
    example: "SELECT * FROM ducklake_table_deletions('{lake}', 'main', 'orders', 2, 4)",
  },
  table_info: {
    description: 'Every table with its id, number and size of data files and delete files.',
    example: "SELECT * FROM ducklake_table_info('{lake}')",
  },
  table_insertions: {
    description: `The rows that were inserted into a table ${SNAPSHOT_RANGE}.`,
    example: "SELECT * FROM ducklake_table_insertions('{lake}', 'main', 'orders', 2, 4)",
  },
};

/** Generated functions that are not offered: `ducklake_scan` refuses a direct call, `ducklake_commit` takes no lake. */
export const INTERNAL_FUNCTIONS: ReadonlySet<string> = new Set(['ducklake_commit', 'ducklake_scan']);

const PREFIX = 'ducklake_';

function globalFunction({ name, kind, overloads }: GeneratedFunction, text: LakeText): FunctionInfo {
  const procedure = text.procedure ?? false;
  return {
    name,
    kind,
    expression: kind !== 'table',
    relation: kind === 'table' && !procedure,
    qualified: false,
    procedure,
    lakeArgument: true,
    description: text.description,
    examples: [text.example],
    overloads: overloads.map(({ parameters, named }) => ({
      parameters: [...parameters, ...named.map((parameter): Parameter => ({ ...parameter, named: true }))],
      returns: undefined,
      varargs: undefined,
    })),
  };
}

/**
 * The global `ducklake_*` functions that take the lake's name as their first argument. A function without a text is
 * left out; `sql-ducklake-vocabulary.test.ts` fails then.
 */
export const GLOBAL_LAKE_FUNCTIONS: readonly FunctionInfo[] = DUCKLAKE_FUNCTIONS.flatMap((fn) => {
  const text = TEXTS[fn.name.slice(PREFIX.length)];
  return text && !INTERNAL_FUNCTIONS.has(fn.name) ? [globalFunction(fn, text)] : [];
});

/** The names (without `ducklake_`) that have a text; only the vocabulary test reads it, to find a text without a function. */
export const LAKE_TEXT_NAMES: readonly string[] = Object.keys(TEXTS);

function lakeFunction(
  name: string,
  parameters: readonly Parameter[],
  example: string,
  procedure = false,
): FunctionInfo {
  return {
    name,
    kind: 'table',
    expression: false,
    relation: !procedure,
    qualified: true,
    procedure,
    lakeArgument: false,
    description: TEXTS[name]?.description,
    examples: [example],
    overloads: [{ parameters, returns: undefined, varargs: undefined }],
  };
}

const QUALIFIED_RANGE: readonly Parameter[] = [
  { name: 'table_name', type: 'VARCHAR' },
  { name: 'start_snapshot', type: 'BIGINT or TIMESTAMP WITH TIME ZONE' },
  { name: 'end_snapshot', type: 'BIGINT or TIMESTAMP WITH TIME ZONE' },
];

/**
 * The functions DuckLake registers in the attached catalog: DuckDB lists none, and they work only after the lake name.
 * `test/unit/sql-language.test.ts` runs each example against a real attached lake.
 */
export const LAKE_FUNCTIONS: readonly FunctionInfo[] = [
  lakeFunction('snapshots', [], 'SELECT * FROM {lake}.snapshots()'),
  lakeFunction('current_snapshot', [], 'SELECT * FROM {lake}.current_snapshot()'),
  lakeFunction('last_committed_snapshot', [], 'SELECT * FROM {lake}.last_committed_snapshot()'),
  lakeFunction('table_info', [], 'SELECT * FROM {lake}.table_info()'),
  lakeFunction('options', [], 'SELECT * FROM {lake}.options()'),
  lakeFunction('settings', [], 'SELECT * FROM {lake}.settings()'),
  lakeFunction('table_changes', QUALIFIED_RANGE, "SELECT * FROM {lake}.table_changes('orders', 2, 4)"),
  lakeFunction('table_insertions', QUALIFIED_RANGE, "SELECT * FROM {lake}.table_insertions('orders', 2, 4)"),
  lakeFunction('table_deletions', QUALIFIED_RANGE, "SELECT * FROM {lake}.table_deletions('orders', 2, 4)"),
  lakeFunction(
    'set_option',
    [
      { name: 'option', type: 'VARCHAR' },
      { name: 'value', type: 'ANY' },
      { name: 'table_name', type: 'VARCHAR' },
      { name: 'schema', type: 'VARCHAR' },
    ],
    "CALL {lake}.set_option('data_inlining_row_limit', 0)",
    true,
  ),
  lakeFunction(
    'set_commit_message',
    [
      { name: 'author', type: 'VARCHAR' },
      { name: 'commit_message', type: 'VARCHAR' },
      { name: 'extra_info', type: 'VARCHAR' },
    ],
    "CALL {lake}.set_commit_message('me', 'Nightly import')",
    true,
  ),
  lakeFunction('merge_adjacent_files', [], 'CALL {lake}.merge_adjacent_files()', true),
];
