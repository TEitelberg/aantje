import { describe, expect, it } from 'vitest';
import { newestSnapshotQuery } from '../../src/data/attach';
import { guardRelation } from '../../src/data/guard';

/** A connection that answers the statements of the guard in order of their kind; `fail` throws for the first match. */
function connection(answers: { newest: unknown; relations: readonly string[]; fail?: RegExp }) {
  const statements: string[] = [];
  return {
    statements,
    runAndReadAll(sql: string) {
      statements.push(sql);
      if (answers.fail?.test(sql))
        return Promise.reject(new Error('Catalog Error: something else went wrong'));
      const rows =
        sql === newestSnapshotQuery()
          ? [[answers.newest]]
          : /UNION ALL SELECT '/.test(sql)
            ? answers.relations.map((kind) => [kind])
            : [];
      return Promise.resolve({ getRowsJson: () => rows });
    },
  };
}

const table = { schema: 'main', table: 't' };

describe('the guard on a stand-in connection', () => {
  it('stops the read when the file listing of a table fails (only a missing table may pass), and asks for no files of a name that no relation carries', async () => {
    const failing = connection({ newest: 3, relations: ['table'], fail: /ducklake_list_files/ });
    await expect(guardRelation(failing, table, undefined)).rejects.toThrow('something else went wrong');

    const missing = connection({ newest: 3, relations: [] });
    await expect(guardRelation(missing, table, undefined)).resolves.toBeUndefined();
    expect(missing.statements.some((sql) => sql.includes('ducklake_list_files'))).toBe(false);
  });

  it('pins the snapshot with the first statement and judges the catalog there; for Show Changes at the end of the range, where table_changes binds the name, and lists the files of the whole range from there', async () => {
    const newest = connection({ newest: 7, relations: [] });
    await guardRelation(newest, table, undefined);
    expect(newest.statements[0]).toBe(newestSnapshotQuery());
    expect(newest.statements[1]).toContain('7 >= r.begin_snapshot');

    const ranged = connection({ newest: 9, relations: ['table'] });
    await guardRelation(ranged, table, undefined, { range: { from: 1, to: 6 } });
    expect(ranged.statements[0]).toBe(newestSnapshotQuery());
    expect(ranged.statements[1]).toContain('6 >= r.begin_snapshot');
    expect(ranged.statements[1]).not.toContain('9 >= r.begin_snapshot');
    const files = ranged.statements.find((sql) => sql.includes('ducklake_data_file')) ?? '';
    expect(files).toContain('6 >= r.begin_snapshot');
    expect(files).toContain('x.begin_snapshot <= 6 AND (x.end_snapshot IS NULL OR x.end_snapshot > 1)');
  });
});
