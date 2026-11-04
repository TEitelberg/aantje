import { describe, expect, it } from 'vitest';
import { maintenanceOf } from '../../src/maintenance';
import type { MaintenanceKind } from '../../src/maintenance';
import type { CatalogTree } from '../../src/tree/model';
import type { NodeRef } from '../../src/tree/refs';
import { lakeBackends } from './lake-backends';
import type { Backend, BackendLake } from './lake-backends';

// The options and the names live in the catalog tables alone, the same for every backend: one backend runs them.
const [first] = await lakeBackends();
const backend = first as Backend;

const tree: Pick<CatalogTree, 'state'> = { state: () => ({ status: 'connected', snapshot: 'latest' }) };
const schema = { id: 1, name: 's', comment: null };
const table = { id: 2, schemaId: 1, name: 't', comment: null, stats: { rows: 0, files: 0, sizeBytes: 0 } };
const connection: NodeRef = { kind: 'connection', connectionId: 'c' };
const tableRef: NodeRef = { kind: 'table', connectionId: 'c', schema, table };
const schemaRef: NodeRef = { kind: 'schema', connectionId: 'c', schema };

const KINDS: readonly MaintenanceKind[] = [
  'checkpoint',
  'merge',
  'rewrite',
  'flush',
  'expire',
  'cleanup',
  'orphans',
  'option',
];

const script = (kind: MaintenanceKind, ref: NodeRef): string => maintenanceOf(tree, kind, ref) ?? '';
const allScripts = (): string[] =>
  KINDS.flatMap((kind) => [script(kind, connection), script(kind, tableRef), script(kind, schemaRef)]);

// The `<column>` of the skip_stats_columns example is a placeholder for the user to replace.
const uncommented = (text: string): string =>
  text
    .split('\n')
    .filter((line) => line.startsWith('-- CALL '))
    .map((line) => line.slice(3))
    .join('\n')
    .replaceAll('<column>', 'a');

/** Every `set_option` call of the lake script and of the table script, run in order. */
async function setEverything(lake: BackendLake): Promise<void> {
  for (const call of [uncommented(script('option', connection)), uncommented(script('option', tableRef))]) {
    await lake.connection.run(call);
  }
}

async function lakeWithTable(): Promise<BackendLake> {
  const lake = await backend.create();
  try {
    await lake.connection.run('CREATE SCHEMA s');
    await lake.connection.run('CREATE TABLE s.t (a INTEGER)');
    return lake;
  } catch (error) {
    await lake.remove();
    throw error;
  }
}

/** The settable options as `options()` lists them: name, scope, scope entry and value. */
const optionRows = async (lake: BackendLake): Promise<string[][]> =>
  (
    await lake.connection.runAndReadAll(
      "SELECT option_name, scope, coalesce(scope_entry, ''), value FROM lake.options() WHERE option_name NOT IN ('created_by', 'data_path', 'encrypted', 'version') ORDER BY 1, 2",
    )
  ).getRowsJson() as string[][];

describe.skipIf(backend.skipReason !== undefined)('the option scripts, run by a real DuckLake', () => {
  it('sets nothing before the comment marks are removed, and every offered option with its scope after', async () => {
    const lake = await lakeWithTable();
    try {
      await lake.connection.run(script('option', connection));
      await lake.connection.run(script('option', tableRef));
      expect(await optionRows(lake)).toEqual([]);

      await setEverything(lake);
      const rows = await optionRows(lake);
      const scopes = (name: string): string[] =>
        rows.filter(([option]) => option === name).map(([, scope]) => scope as string);

      expect(scopes('expire_older_than')).toEqual(['GLOBAL']);
      expect(scopes('delete_older_than')).toEqual(['GLOBAL']);
      expect(scopes('require_commit_message')).toEqual(['GLOBAL']);
      expect(scopes('skip_stats_columns')).toEqual(['TABLE']);
      expect(scopes('auto_compact')).toEqual(['GLOBAL', 'TABLE']);
      expect(rows.length).toBeGreaterThanOrEqual(25);

      const value = (name: string, scope: string): string | undefined =>
        rows.find(([option, kind]) => option === name && kind === scope)?.[3];
      expect(value('auto_compact', 'TABLE')).toBe('false');
      expect(value('target_file_size', 'GLOBAL')).toBe('512000000');
      expect(value('parquet_row_group_size_bytes', 'TABLE')).toBe('128000000');
      expect(value('parquet_version', 'GLOBAL')).toBe('V2');
    } finally {
      await lake.remove();
    }
  });
});

const DOCUMENTED_OPTIONS = [
  'auto_compact',
  'data_inlining_row_limit',
  'delete_older_than',
  'expire_older_than',
  'hive_file_pattern',
  'parquet_compression',
  'parquet_compression_level',
  'parquet_row_group_size',
  'parquet_row_group_size_bytes',
  'parquet_version',
  'per_thread_output',
  'require_commit_message',
  'rewrite_delete_threshold',
  'skip_stats_columns',
  'sort_on_insert',
  'target_file_size',
  'write_deletion_vectors',
];

const DOCUMENTED_FUNCTIONS = [
  'ducklake_merge_adjacent_files',
  'ducklake_rewrite_data_files',
  'ducklake_flush_inlined_data',
  'ducklake_expire_snapshots',
  'ducklake_cleanup_old_files',
  'ducklake_delete_orphaned_files',
  'ducklake_set_option',
  'ducklake_options',
];

/** The functions that the scripts call by name. */
const offeredFunctions = (): Set<string> =>
  new Set(
    allScripts().flatMap((text) =>
      [...text.matchAll(/(?:CALL |SELECT \* FROM )(\w+)\(/g)].map(([, name]) => name as string),
    ),
  );

const offeredOptions = (): Set<string> =>
  new Set(
    allScripts().flatMap((text) =>
      [...text.matchAll(/set_option\('lake', '(\w+)'/g)].map(([, name]) => name as string),
    ),
  );

describe.skipIf(backend.skipReason !== undefined)(
  'the names in the scripts, against the installed DuckLake',
  () => {
    it('offers only options that options() lists once they are set and only functions that exist, and reports the documented ones it does not offer', async () => {
      const lake = await lakeWithTable();
      try {
        await setEverything(lake);
        const known = new Set((await optionRows(lake)).map(([name]) => name));
        const engineFunctions = new Set(
          (
            await lake.connection.runAndReadAll(
              "SELECT DISTINCT function_name FROM duckdb_functions() WHERE function_name LIKE 'ducklake%'",
            )
          )
            .getRowsJson()
            .map(([name]) => name as string),
        );

        expect([...offeredOptions()].filter((name) => !known.has(name))).toEqual([]);
        expect(
          [...offeredFunctions()].filter((name) => name !== 'CHECKPOINT' && !engineFunctions.has(name)),
        ).toEqual([]);

        const missing = [
          ...DOCUMENTED_OPTIONS.filter((name) => !offeredOptions().has(name)).map((name) => `option ${name}`),
          ...DOCUMENTED_FUNCTIONS.filter((name) => !offeredFunctions().has(name)).map(
            (name) => `function ${name}`,
          ),
        ];
        console.info(
          missing.length === 0
            ? 'Every documented maintenance option and function is offered by the scripts.'
            : `Documented but not offered by the scripts: ${missing.join(', ')}`,
        );
      } finally {
        await lake.remove();
      }
    });
  },
);
