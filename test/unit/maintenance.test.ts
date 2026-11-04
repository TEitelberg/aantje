import { describe, expect, it } from 'vitest';
import { setupStatements } from '../../src/data/attach';
import { SCHEMA_SCRIPT_TABLES, maintenanceOf, maintenanceScript } from '../../src/maintenance';
import type { MaintenanceKind } from '../../src/maintenance';
import type { LakeOptions } from '../../src/maintenance-header';
import type { CatalogTree } from '../../src/tree/model';
import type { NodeRef } from '../../src/tree/refs';

const schema = { id: 1, name: 'sales', comment: null };
const table = {
  id: 2,
  schemaId: 1,
  name: 'orders',
  comment: null,
  stats: { rows: 0, files: 0, sizeBytes: 0 },
};

const connection: NodeRef = { kind: 'connection', connectionId: 'c' };
const orders: NodeRef = { kind: 'table', connectionId: 'c', schema, table };

/** The tree as far as the scripts ask: whether it shows the latest snapshot or a pinned one. */
const treeAt = (snapshot: number | 'latest'): Pick<CatalogTree, 'state'> => ({
  state: () => ({ status: 'connected', snapshot }),
});
const follows = treeAt('latest');

const NO_OPTIONS: LakeOptions = {
  expire_older_than: null,
  delete_older_than: null,
  rewrite_delete_threshold: null,
  target_file_size: null,
  auto_compact: null,
};
const pinned = treeAt(12);

const ALL: readonly MaintenanceKind[] = [
  'checkpoint',
  'merge',
  'rewrite',
  'flush',
  'expire',
  'cleanup',
  'orphans',
  'option',
];

const HEADER = `-- Maintenance of the DuckLake. The SQL editor of aantje attaches the lake as "lake", so the statements below use that name.
-- Run them in a read/write SQL session.`;

describe('the maintenance scripts', () => {
  it('writes a dry run first and the real call commented out for everything that destroys data', () => {
    const calls = (kind: MaintenanceKind, options?: LakeOptions | null): string[] =>
      (maintenanceOf(follows, kind, connection, options) ?? '')
        .split('\n')
        .filter((line) => /^(-- )?CALL /.test(line));
    expect(calls('expire')).toEqual([
      "CALL ducklake_expire_snapshots('lake', older_than => now() - INTERVAL 30 DAY, dry_run => true);",
      "-- CALL ducklake_expire_snapshots('lake', older_than => now() - INTERVAL 30 DAY);",
    ]);
    const set = { ...NO_OPTIONS, expire_older_than: '15 days', delete_older_than: '' };
    expect(calls('expire', set)).toEqual([
      "CALL ducklake_expire_snapshots('lake', dry_run => true);",
      "-- CALL ducklake_expire_snapshots('lake');",
      "-- CALL ducklake_expire_snapshots('lake', older_than => now() - INTERVAL 7 DAY);",
    ]);
    expect(calls('orphans')).toEqual([
      "CALL ducklake_delete_orphaned_files('lake', dry_run => true);",
      "-- CALL ducklake_delete_orphaned_files('lake');",
      "-- CALL ducklake_delete_orphaned_files('lake', older_than => now() - INTERVAL 7 DAY);",
    ]);
    expect(calls('orphans', set)).toEqual([
      "CALL ducklake_delete_orphaned_files('lake', older_than => now() - INTERVAL 2 DAY, dry_run => true);",
      "-- CALL ducklake_delete_orphaned_files('lake', older_than => now() - INTERVAL 2 DAY);",
    ]);

    for (const kind of ['expire', 'cleanup', 'orphans'] as const) {
      const lines = (maintenanceOf(follows, kind, connection) ?? '').split('\n');
      const active = lines.filter((line) => line.startsWith('CALL '));
      expect(active, kind).toHaveLength(1);
      expect(active[0], kind).toContain('dry_run => true');
      expect(
        lines.filter((line) => line.startsWith('-- CALL ')),
        kind,
      ).toHaveLength(kind === 'expire' ? 1 : 2);
    }
    // Only Clean Up Old Files and Delete Orphaned Files delete files even in a read-only session, and say so.
    const warns = (kind: MaintenanceKind) =>
      (maintenanceOf(follows, kind, connection) ?? '').includes('even in a read-only session');
    expect(ALL.filter(warns)).toEqual(['cleanup', 'orphans']);
  });

  it('writes the scripts of the connection: one plain call, a template that is all comments, and Checkpoint, naming the lake as the SQL editor attaches it', () => {
    expect(maintenanceOf(follows, 'merge', connection)).toBe(`${HEADER}
-- Merges small adjacent data files into larger ones (what OPTIMIZE does in other systems; DuckLake has no OPTIMIZE statement).
-- Optional named parameters: min_file_size, max_file_size, max_compacted_files, newer_than, older_than; table_name and schema limit it to one table.
CALL ducklake_merge_adjacent_files('lake');`);

    const option = (maintenanceOf(follows, 'option', connection) ?? '').split('\n');
    expect(option.filter((line) => !line.startsWith('--'))).toEqual([]);
    expect(option).toContain("-- CALL ducklake_set_option('lake', 'expire_older_than', '30 days');");

    // The alias comes from the ATTACH statement of a read/write session.
    const attach = setupStatements(
      { profile: { id: 'p', name: 'p', kind: 'sqlite', path: 'x.sqlite' }, s3: {} },
      { readOnly: false },
    ).find((statement) => statement.startsWith('ATTACH'));
    const alias = / AS ([a-z]+)/.exec(attach ?? '')?.[1];
    expect(alias).toBe('lake');
    expect(maintenanceOf(follows, 'checkpoint', connection)).toMatch(/^CHECKPOINT lake;$/m);
    for (const kind of ALL) {
      expect(maintenanceOf(follows, kind, connection), kind).toMatch(
        /^-- Maintenance of the DuckLake\. .*"lake"/,
      );
    }
    // The maintenance acts on the whole lake: the snapshot that the tree shows is not part of it.
    expect(maintenanceOf(pinned, 'merge', connection)).not.toContain('@12');
  });

  it('writes the scripts of a table with the schema and the table as string literals, and only for the entries that a table has', () => {
    expect(maintenanceOf(follows, 'merge', orders)).toBe(`${HEADER}
-- Merges small adjacent data files of the table into larger ones (what OPTIMIZE does in other systems; DuckLake has no OPTIMIZE statement).
-- Optional named parameters: min_file_size, max_file_size, max_compacted_files, newer_than, older_than.
CALL ducklake_merge_adjacent_files('lake', 'orders', schema => 'sales');`);
    expect(maintenanceOf(follows, 'rewrite', orders)).toContain(
      "\nCALL ducklake_rewrite_data_files('lake', 'orders', schema => 'sales');",
    );
    expect(maintenanceOf(follows, 'flush', orders)).toContain(
      "\nCALL ducklake_flush_inlined_data('lake', schema_name => 'sales', table_name => 'orders');",
    );
    expect(maintenanceOf(follows, 'option', orders)).toContain(
      "\n-- CALL ducklake_set_option('lake', 'target_file_size', '512MB', table_name => 'orders', schema => 'sales');",
    );
    for (const kind of ALL) {
      const text = maintenanceOf(follows, kind, orders);
      if (['merge', 'rewrite', 'flush', 'option'].includes(kind)) {
        expect(text, kind).toBeDefined();
      } else {
        expect(text, kind).toBeUndefined();
      }
    }
    // A tree that shows an older snapshot says so in the script of a table, which acts on the newest state.
    expect(maintenanceOf(pinned, 'merge', orders)).toContain('@12');
    expect(maintenanceOf(pinned, 'option', orders)).toContain('@12');
    expect(maintenanceOf(follows, 'merge', orders)).not.toContain('@12');
  });

  it('keeps the quotes and the line breaks of a hostile name inside the string literal, and out of every comment', () => {
    const hostile: NodeRef = {
      kind: 'table',
      connectionId: 'c',
      schema: { ...schema, name: "s'; DROP SCHEMA victim; --" },
      table: { ...table, name: "t'\nDROP TABLE victim; --" },
    };
    const text = maintenanceOf(follows, 'merge', hostile) ?? '';
    expect(text).toContain(
      "\nCALL ducklake_merge_adjacent_files('lake', 't''\nDROP TABLE victim; --', schema => 's''; DROP SCHEMA victim; --');",
    );
    // Outside the literal the name appears nowhere: not in the comments above the call.
    expect(text.split('\nCALL ')[0]).not.toMatch(/victim/);

    const option = maintenanceOf(follows, 'option', hostile) ?? '';
    expect(option.split('\n').every((line) => line === '' || line.startsWith('--'))).toBe(true);
    expect(option).toContain("table_name => 't''\n-- DROP TABLE victim; --'");
  });

  it('writes nothing for a view, a folder or a message', () => {
    const refs: NodeRef[] = [
      {
        kind: 'view',
        connectionId: 'c',
        schema,
        view: {
          id: 3,
          schemaId: 1,
          name: 'v',
          comment: null,
          sql: 'SELECT 1',
          dialect: 'duckdb',
          columnAliases: [],
        },
      },
      { kind: 'folder', connectionId: 'c', folder: 'tables', schema, tables: [] },
      { kind: 'message', connectionId: 'c', text: 'x' },
    ];
    for (const ref of refs) {
      for (const kind of ALL) {
        expect(maintenanceOf(follows, kind, ref), `${ref.kind} ${kind}`).toBeUndefined();
      }
    }
  });
});

describe('the maintenance scripts of a schema', () => {
  const shop: NodeRef = { kind: 'schema', connectionId: 'c', schema };

  it('merges and rewrites with one call per table, and flushes and sets options for the schema as a whole', () => {
    const lines = (kind: MaintenanceKind, tables: readonly string[] = []): string[] =>
      (maintenanceOf(follows, kind, shop, undefined, tables) ?? '').split('\n');

    expect(lines('merge', ['events', 'orders']).filter((line) => line.startsWith('CALL '))).toEqual([
      "CALL ducklake_merge_adjacent_files('lake', 'events', schema => 'sales');",
      "CALL ducklake_merge_adjacent_files('lake', 'orders', schema => 'sales');",
    ]);
    expect(lines('rewrite', ['events']).filter((line) => line.startsWith('CALL '))).toEqual([
      "CALL ducklake_rewrite_data_files('lake', 'events', schema => 'sales');",
    ]);
    expect(lines('flush').filter((line) => line.startsWith('CALL '))).toEqual([
      "CALL ducklake_flush_inlined_data('lake', schema_name => 'sales');",
    ]);
    const option = lines('option');
    expect(option.every((line) => line === '' || line.startsWith('--'))).toBe(true);
    expect(option).toContain(
      "-- CALL ducklake_set_option('lake', 'auto_compact', false, schema => 'sales');",
    );
    expect(option.join('\n')).not.toMatch(
      /expire_older_than|delete_older_than|require_commit_message|skip_stats_columns/,
    );
    for (const kind of ['checkpoint', 'expire', 'cleanup', 'orphans'] as const) {
      expect(maintenanceOf(follows, kind, shop), kind).toBeUndefined();
    }
  });

  it('says so for a schema without tables, cuts a long list and keeps hostile names inside their literals', () => {
    const none = maintenanceOf(follows, 'merge', shop) ?? '';
    expect(none).toContain('-- The schema has no table.');
    expect(none).not.toContain('\nCALL ');

    const many = Array.from({ length: SCHEMA_SCRIPT_TABLES + 3 }, (_, index) => `t${index}`);
    const cut = maintenanceOf(follows, 'merge', shop, undefined, many) ?? '';
    expect(cut.split('\n').filter((line) => line.startsWith('CALL '))).toHaveLength(SCHEMA_SCRIPT_TABLES);
    expect(cut).toContain('-- 3 more tables of the schema are not listed.');

    const hostile: NodeRef = {
      kind: 'schema',
      connectionId: 'c',
      schema: { ...schema, name: "s'; DROP SCHEMA victim; --" },
    };
    const text = maintenanceOf(follows, 'rewrite', hostile, undefined, ["t'\nDROP TABLE victim; --"]) ?? '';
    expect(text).toContain(
      "\nCALL ducklake_rewrite_data_files('lake', 't''\nDROP TABLE victim; --', schema => 's''; DROP SCHEMA victim; --');",
    );
    expect(text.split('\nCALL ')[0]).not.toMatch(/victim/);
  });

  it('reads the tables of the schema at the newest snapshot for the script of the menu', async () => {
    const asked: [number, number][] = [];
    const tree = {
      state: () => ({ status: 'connected', snapshot: 12, latestSnapshot: 30 }),
      reader: () => ({
        info: () => Promise.reject(new Error('not needed')),
        tables: (schemaId: number, snapshot: number) => {
          asked.push([schemaId, snapshot]);
          return Promise.resolve([{ name: 'events' }, { name: 'orders' }]);
        },
      }),
    } as never;

    const text = (await maintenanceScript(tree, 'merge', shop)) ?? '';

    expect(asked).toEqual([[1, 30]]);
    expect(text.split('\n').filter((line) => line.startsWith('CALL '))).toHaveLength(2);
    expect(text).toContain('@12');
  });
});

describe('the option values in the header of the scripts that follow the options', () => {
  const entry = (key: string, value: string) => ({ key, value, scope: null, scopeId: null });
  const readerOf = (metadata: () => Promise<unknown>) =>
    ({ state: () => ({ status: 'connected', snapshot: 'latest' }), reader: () => ({ metadata }) }) as never;
  const listed = (text: string | undefined) =>
    (text ?? '').split('\n').filter((line) => /^-- {3}\w+ = /.test(line));

  it('lists them for Checkpoint, Expire, Clean Up and Orphans only, and keeps a value from the catalog out of the comment unless it is plain', async () => {
    const tree = readerOf(() =>
      Promise.resolve([entry('expire_older_than', '30 days'), entry('delete_older_than', '1\nDROP TABLE x')]),
    );
    for (const kind of ['checkpoint', 'expire', 'cleanup', 'orphans'] as const) {
      const lines = listed(await maintenanceScript(tree, kind, connection));
      expect(lines, kind).toContain('--   expire_older_than = 30 days');
      expect(lines, kind).toContain('--   delete_older_than = set (not shown)');
      expect(lines, kind).toContain('--   auto_compact = not set');
    }
    expect(listed(await maintenanceScript(tree, 'merge', connection))).toEqual([]);
    expect(listed(maintenanceOf(follows, 'expire', connection))).toEqual([]);
  });

  it('says that the values are not available when the catalog cannot be read, and Checkpoint names the setting that overrides target_file_size', async () => {
    const failing = readerOf(() => Promise.reject(new Error('closed')));
    for (const tree of [failing, { state: follows.state, reader: () => undefined } as never]) {
      const text = (await maintenanceScript(tree, 'checkpoint', connection)) ?? '';
      expect(listed(text)).toEqual([]);
      expect(text).toContain('not available');
      expect(text).toContain('ducklake_target_file_size');
    }
  });
});
