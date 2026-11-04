import { describe, expect, it } from 'vitest';
import { maintenanceScript } from '../../src/maintenance';
import type { MaintenanceKind } from '../../src/maintenance';
import { scriptOf } from '../../src/script-templates';
import { createLake, engineSkipReason } from './data-support';
import { scriptsOf, withWriter } from './script-support';
import type { Writer } from './script-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`The option script tests against a real DuckLake are skipped: ${skipReason}`);
}

const SETUP = ['CREATE SCHEMA s', 'CREATE TABLE s.t (a INTEGER, b INTEGER, c INTEGER)'];

/** The options of the table `s.t` as `options()` lists them, by name. */
const tableOptions = async (writer: Writer, table = 's.t'): Promise<Record<string, string>> =>
  Object.fromEntries(
    (
      await writer.rows(
        `SELECT option_name, value FROM lake.options() WHERE scope = 'TABLE' AND scope_entry = '${table}' ORDER BY 1`,
      )
    ).map(([name, value]) => [String(name), String(value)]),
  );

const statementsOf = (script: string, keyword: RegExp): string[] =>
  script
    .split('\n')
    .filter((line) => line.startsWith('-- ALTER TABLE') && keyword.test(line))
    .map((line) => line.slice(3));

describe.skipIf(skipReason !== undefined)('the table options in the scripts, run by a real DuckLake', () => {
  it('sets every table option with the SET statements of Script as ALTER and removes it again with RESET', async () => {
    const lake = await createLake(SETUP);
    try {
      const alter = await scriptsOf(lake, async (nodeAt, tree) =>
        scriptOf('alter', tree, (await nodeAt('s', 'Tables', 't')).ref),
      );
      const sets = statementsOf(alter ?? '', /\bSET \(/);
      const resets = statementsOf(alter ?? '', /\bRESET \(/);
      expect(sets.length).toBe(resets.length);
      expect(sets.length).toBeGreaterThanOrEqual(14);

      await withWriter(lake, async (writer) => {
        for (const statement of sets) {
          await writer.run(statement);
        }
        const set = await tableOptions(writer);
        expect(Object.keys(set)).toHaveLength(sets.length);
        expect(set.auto_compact).toBe('false');
        expect(set.target_file_size).toBe('512000000');
        expect(set.skip_stats_columns).toBe('1');

        // A global option is not an override of the table: RESET removes only the table's own.
        await writer.run("CALL lake.set_option('parquet_compression', 'gzip')");
        for (const statement of resets) {
          await writer.run(statement);
        }
        expect(await tableOptions(writer)).toEqual({});
        expect(
          await writer.rows("SELECT value FROM lake.options() WHERE option_name = 'parquet_compression'"),
        ).toEqual([['gzip']]);
      });
    } finally {
      await lake.remove();
    }
  });

  it('writes the options of a table as WITH in Script as CREATE, and the statement gives the same options back', async () => {
    const lake = await createLake([...SETUP, 'CREATE TABLE s.plain (a INTEGER)']);
    try {
      await withWriter(lake, async (writer) => {
        const where = "table_name => 't', schema => 's'";
        for (const [name, value] of [
          ['auto_compact', 'false'],
          ['target_file_size', "'1MiB'"],
          ['parquet_version', '2'],
          ['parquet_compression', "'zstd'"],
          ['rewrite_delete_threshold', "'0.25'"],
          ['skip_stats_columns', "['a', 'c']"],
        ]) {
          await writer.run(`CALL lake.set_option('${name}', ${value}, ${where})`);
        }
      });
      const create = await scriptsOf(lake, async (nodeAt, tree) => ({
        table: await scriptOf('create', tree, (await nodeAt('s', 'Tables', 't')).ref),
        plain: await scriptOf('create', tree, (await nodeAt('s', 'Tables', 'plain')).ref),
      }));
      expect(create.plain).not.toContain('WITH (');

      await withWriter(lake, async (writer) => {
        const before = await tableOptions(writer);
        expect(Object.keys(before)).toHaveLength(6);
        await writer.run('DROP TABLE s.t');
        expect(await tableOptions(writer)).toEqual({});

        const statement = (create.table ?? '')
          .split('\n')
          .filter((line) => !line.startsWith('--'))
          .join('\n');
        expect(statement).toContain(') WITH (');
        await writer.run(statement);
        // The new table has its own id, so the rows of options() are compared by value.
        expect(await tableOptions(writer)).toEqual(before);
      });
    } finally {
      await lake.remove();
    }
  });
});

describe.skipIf(skipReason !== undefined)(
  'the option values in the header, read from a real DuckLake',
  () => {
    const FOLLOWING: readonly MaintenanceKind[] = ['checkpoint', 'expire', 'cleanup', 'orphans'];

    /** The `--   name = value` lines of a script header. */
    const shown = (script: string | undefined): Record<string, string> =>
      Object.fromEntries(
        (script ?? '').split('\n').flatMap((line) => {
          const match = /^-- {3}(\w+) = (.*)$/.exec(line);
          return match ? [[match[1] as string, match[2] as string] as const] : [];
        }),
      );

    it('shows the five options as they are in the lake, "not set" for a lake without them, and nothing for the other scripts', async () => {
      const lake = await createLake(SETUP);
      try {
        const scripts = (kind: MaintenanceKind) =>
          scriptsOf(lake, async (nodeAt, tree) => maintenanceScript(tree, kind, (await nodeAt()).ref));

        for (const kind of FOLLOWING) {
          expect(shown(await scripts(kind)), kind).toEqual({
            expire_older_than: 'not set',
            delete_older_than: 'not set',
            rewrite_delete_threshold: 'not set',
            target_file_size: 'not set',
            auto_compact: 'not set',
          });
        }

        await withWriter(lake, async (writer) => {
          for (const [name, value] of [
            ['expire_older_than', "'30 days'"],
            ['delete_older_than', "'7 days'"],
            ['rewrite_delete_threshold', "'0.5'"],
            ['target_file_size', "'512MB'"],
            ['auto_compact', 'false'],
          ]) {
            await writer.run(`CALL lake.set_option('${name}', ${value})`);
          }
          // A table's own option is not an option of the lake.
          await writer.run(
            "CALL lake.set_option('target_file_size', '1MB', table_name => 't', schema => 's')",
          );
        });
        for (const kind of FOLLOWING) {
          expect(shown(await scripts(kind)), kind).toEqual({
            expire_older_than: '30 days',
            delete_older_than: '7 days',
            rewrite_delete_threshold: '0.500000',
            target_file_size: '512000000',
            auto_compact: 'false',
          });
        }
        expect(shown(await scripts('merge'))).toEqual({});
      } finally {
        await lake.remove();
      }
    });
  },
);
