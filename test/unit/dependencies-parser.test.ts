import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openSqlParser } from '../../src/dependencies/parser';

const directory = mkdtempSync(join(tmpdir(), 'aantje-parser-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('the parser of the dependency analysis', () => {
  it('parses a SELECT into the document of DuckDB, never runs what it is given, and opens again after it was closed', async () => {
    const parser = openSqlParser();
    const target = join(directory, 'written.csv').replaceAll('\\', '/');
    try {
      const document = JSON.parse(await parser.serialize('SELECT * FROM shop.events')) as {
        error: boolean;
        statements: { node: { from_table: { table_name: string; schema_name: string } } }[];
      };
      expect(document.error).toBe(false);
      expect(document.statements[0]?.node.from_table).toMatchObject({
        table_name: 'events',
        schema_name: 'shop',
      });

      // A COPY to a file is refused as not a SELECT, and the file is not written; nor by a second statement.
      const copy = JSON.parse(await parser.serialize(`COPY (SELECT 1) TO '${target}'`)) as { error: boolean };
      expect(copy.error).toBe(true);
      await parser.serialize(`SELECT * FROM read_csv('${target}'); COPY (SELECT 2) TO '${target}'`);
      expect(existsSync(target)).toBe(false);

      await parser.dispose();
      await parser.dispose();
      expect((JSON.parse(await parser.serialize('SELECT 2')) as { error: boolean }).error).toBe(false);
    } finally {
      await parser.dispose();
    }
  });

  it('names the built-in functions, and among them the ones that can follow FROM', async () => {
    const parser = openSqlParser();
    try {
      const { all, table } = await parser.functions();
      expect([all.has('abs'), all.has('query_table'), all.has('gross')]).toEqual([true, true, false]);
      expect([table.has('range'), table.has('duckdb_tables'), table.has('abs')]).toEqual([true, true, false]);
    } finally {
      await parser.dispose();
    }
  });
});
