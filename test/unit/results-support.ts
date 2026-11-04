import { previewTable } from '../../src/data/engine';
import type { GridData } from '../../src/data/types';
import { openSqlSession } from '../../src/sql/session';
import type { SqlEvent } from '../../src/sql/session';
import { createLake, extensionDirectory } from './data-support';
import { events } from './sql-support';

export const HOSTILE = '<img src=x onerror=alert(1)>';
/** The statement text of statement 3 and the name of its column: markup, to be shown as text. */
export const HOSTILE_SQL = `SELECT '<b>x</b>' AS "<i>${HOSTILE}</i>"`;
/** The most rows a result of the real run keeps, so that its range statement is cut. */
export const MAX_ROWS = 10;

/**
 * A script of seven statements: DDL, INSERT, a SELECT with BIGINT, DECIMAL, STRUCT, MAP, NULL and hostile text, a
 * SELECT with hostile names, a SELECT of 25 rows (cut to MAX_ROWS), a statement that fails and one that never starts.
 */
export const SCRIPT = [
  'CREATE TABLE made (a INTEGER)',
  'INSERT INTO made VALUES (1),(2)',
  'SELECT * FROM t ORDER BY id',
  HOSTILE_SQL,
  'SELECT i FROM range(25) r(i)',
  'SELECT * FROM nope',
  'SELECT 1',
].join(';\n');

export interface RealRun {
  readonly script: string;
  readonly events: readonly SqlEvent[];
  /** What the data preview shows of the table `t`, which statement 2 selects. */
  readonly preview: GridData;
}

let cached: Promise<RealRun> | undefined;

/** The events of a real session on a real DuckLake; one run is shared by all the tests of a file. */
export function realRun(): Promise<RealRun> {
  cached ??= (async () => {
    const lake = await createLake([
      'CREATE TABLE t (id INTEGER, big BIGINT, amount DECIMAL(10,2), customer STRUCT(name VARCHAR, tags VARCHAR[]), attrs MAP(VARCHAR, INTEGER), note VARCHAR)',
      `INSERT INTO t VALUES (1, 9007199254740993, 1.50, {'name':'a','tags':['x']}, MAP {'k': 1}, 'one'), (2, NULL, 2.50, NULL, NULL, NULL), (3, 3, 3.00, {'name':'c','tags':[]}, MAP {}, '${HOSTILE}')`,
    ]);
    try {
      const access = { profile: lake.profile, s3: {}, extensionDirectory };
      // A DuckDB file is locked by a writable session: read the preview first.
      const preview = await previewTable(access, { schema: 'main', table: 't' });
      const session = await openSqlSession({ access, mode: 'read-write' });
      try {
        return { script: SCRIPT, events: await events(session, SCRIPT, { maxRows: MAX_ROWS }), preview };
      } finally {
        await session.close();
      }
    } finally {
      await lake.remove();
    }
  })();
  return cached;
}
