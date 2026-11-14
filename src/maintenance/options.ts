import { quoteLiteral } from '../catalog/ddl';
import type { ColumnInfo, MetadataEntry } from '../catalog/model';
import { LAKE } from '../data/attach';
import { commented } from '../ddl-script/check';

type Scope = 'global' | 'schema' | 'table';

/** An option of `set_option` as the Set Option scripts offer it: the example value is an SQL literal. */
interface MaintenanceOption {
  readonly name: string;
  readonly value: string;
  readonly scopes: readonly Scope[];
  readonly note: string;
}

const EVERYWHERE: readonly Scope[] = ['global', 'schema', 'table'];

/** The options that DuckLake documents as settable, in the order of the scripts; the read-only ones (created_by, data_path, encrypted, version) are not offered. */
export const OPTIONS: readonly MaintenanceOption[] = [
  {
    name: 'expire_older_than',
    value: "'30 days'",
    scopes: ['global'],
    note: 'How old a snapshot must be before ducklake_expire_snapshots expires it (a global option only; no default, nothing expires)',
  },
  {
    name: 'delete_older_than',
    value: "'7 days'",
    scopes: ['global'],
    note: 'How long a file that nothing needs waits before ducklake_cleanup_old_files deletes it (a global option only; the documentation names 2 days as the default)',
  },
  {
    name: 'target_file_size',
    value: "'512MB'",
    scopes: EVERYWHERE,
    note: 'The size that written Parquet files aim at (default 512 MiB)',
  },
  {
    name: 'data_inlining_row_limit',
    value: '10',
    scopes: EVERYWHERE,
    note: 'The most rows of one insert that DuckLake keeps in the catalog instead of a file (default 10)',
  },
  {
    name: 'parquet_compression',
    value: "'zstd'",
    scopes: EVERYWHERE,
    note: 'The Parquet compression (default snappy)',
  },
  {
    name: 'rewrite_delete_threshold',
    value: "'0.5'",
    scopes: EVERYWHERE,
    note: 'The share of deleted rows from which ducklake_rewrite_data_files rewrites a file (default 0.95)',
  },
  {
    name: 'auto_compact',
    value: 'false',
    scopes: EVERYWHERE,
    note: 'Whether CHECKPOINT and the compaction calls touch the table; false makes them skip it even when it is named (default true)',
  },
  {
    name: 'hive_file_pattern',
    value: 'false',
    scopes: EVERYWHERE,
    note: 'Whether partitioned files go into Hive-style directories such as year=2025 (default true)',
  },
  {
    name: 'parquet_compression_level',
    value: '5',
    scopes: EVERYWHERE,
    note: 'The level of the Parquet compression (default 3)',
  },
  {
    name: 'parquet_row_group_size',
    value: '100000',
    scopes: EVERYWHERE,
    note: 'The rows of a Parquet row group (default 122880)',
  },
  {
    name: 'parquet_row_group_size_bytes',
    value: "'128MB'",
    scopes: EVERYWHERE,
    note: 'The size of a Parquet row group in bytes (no default)',
  },
  {
    name: 'parquet_version',
    value: '2',
    scopes: EVERYWHERE,
    note: 'The Parquet format version, 1 or 2 (default 1)',
  },
  {
    name: 'per_thread_output',
    value: 'true',
    scopes: EVERYWHERE,
    note: 'Whether each thread writes its own file (default false)',
  },
  {
    name: 'sort_on_insert',
    value: 'false',
    scopes: EVERYWHERE,
    note: 'Whether an insert sorts the rows by the sort order of the table (default true)',
  },
  {
    name: 'write_deletion_vectors',
    value: 'true',
    scopes: EVERYWHERE,
    note: 'Whether deletes are written as deletion vectors (experimental; default false)',
  },
  {
    name: 'require_commit_message',
    value: 'true',
    scopes: ['global'],
    note: 'Whether every commit needs a message (a global option only; default false)',
  },
  {
    name: 'skip_stats_columns',
    value: "'<column>'",
    scopes: ['table'],
    note: 'The columns of the table for which DuckLake keeps no file statistics (a table option only; default none)',
  },
];

const offered = (scope: Scope): readonly MaintenanceOption[] =>
  OPTIONS.filter((option) => option.scopes.includes(scope));

// The global function takes the lake by name; `lake.set_option` is looked up in the schema `main`, which a lake can lack.
const setOption = (args: string): string => commented(`CALL ducklake_set_option('${LAKE}', ${args});`);

/** The option template of the lake: a comment and a commented `set_option` call per option that can be global. */
export function lakeOptionLines(): string[] {
  return offered('global').flatMap(({ name, value, note }) => [
    `-- ${note}`,
    setOption(`'${name}', ${value}`),
  ]);
}

/** The option template of a schema: the options that can be set for a schema, each with `schema`. */
export function schemaOptionLines(schemaName: string): string[] {
  return offered('schema').flatMap(({ name, value, note }) => [
    `-- ${note}`,
    setOption(`'${name}', ${value}, schema => ${quoteLiteral(schemaName)}`),
  ]);
}

/** The option template of a table: the options that can be set for a table, each with `table_name` and `schema`. */
export function tableOptionLines(schemaName: string, tableName: string): string[] {
  const where = `table_name => ${quoteLiteral(tableName)}, schema => ${quoteLiteral(schemaName)}`;
  return offered('table').flatMap(({ name, value, note }) => [
    `-- ${note}`,
    setOption(`'${name}', ${value}, ${where}`),
  ]);
}

/** An option of a table as a clause of `CREATE TABLE .. WITH (..)`; the value is an SQL literal. */
export interface TableOption {
  readonly name: string;
  readonly value: string;
}

const SIZE_OPTIONS = new Set(['target_file_size', 'parquet_row_group_size_bytes']);
const PLAIN_VALUE = /^(?:true|false|-?\d+(?:\.\d+)?)$/;

// DuckLake stores a size as a number of bytes, parquet_version as `V2` and the columns of skip_stats_columns as ids; the clause wants them as `'…B'`, `2` and names.
function clauseValue(name: string, stored: string, columns: readonly ColumnInfo[]): string | undefined {
  if (name === 'skip_stats_columns') {
    const names = stored
      .split(',')
      .map((id) => columns.find((column) => column.id === Number(id))?.name)
      .filter((column): column is string => column !== undefined);
    return names.length === 0 ? undefined : `[${names.map(quoteLiteral).join(', ')}]`;
  }
  if (SIZE_OPTIONS.has(name) && /^\d+$/.test(stored)) {
    return quoteLiteral(`${stored}B`);
  }
  const value = name === 'parquet_version' ? stored.replace(/^V/i, '') : stored;
  return PLAIN_VALUE.test(value) ? value : quoteLiteral(value);
}

/** The options that are set for one table, from the rows of `ducklake_metadata`; the table options that DuckLake documents only. */
export function tableOptionsOf(
  entries: readonly MetadataEntry[],
  tableId: number,
  columns: readonly ColumnInfo[],
): TableOption[] {
  const names = new Set(offered('table').map(({ name }) => name));
  return entries
    .filter((entry) => entry.scope === 'table' && entry.scopeId === tableId && names.has(entry.key))
    .flatMap(({ key, value }) => {
      const clause = clauseValue(key, value, columns);
      return clause === undefined ? [] : [{ name: key, value: clause }];
    });
}

/** `SET` and `RESET` statements of the table options, commented out, each under its note; the columns give `skip_stats_columns` a real example. */
export function alterOptionLines(table: string, columns: readonly ColumnInfo[]): string[] {
  const [column] = columns;
  return offered('table').flatMap(({ name, value, note }) => [
    `-- ${note}`,
    commented(
      `ALTER TABLE ${table} SET (${name} = ${name === 'skip_stats_columns' && column ? `[${quoteLiteral(column.name)}]` : value});`,
    ),
    commented(`ALTER TABLE ${table} RESET (${name});`),
  ]);
}
