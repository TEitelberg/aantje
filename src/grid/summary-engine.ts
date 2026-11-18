// The statistics of the rows that the results panel loaded, for a statement that may not run again (it does more than
// read, or its run was cancelled): DuckDB computes them as well, in a private in-memory DuckDB of the extension, never
// in the page and never in the session of the editor, whose transaction and tables stay as they were.
import { quoteIdentifier } from '../catalog/ddl';
import type { GridColumn, GridValue } from '../data/types';
import { loadEngine } from '../duckdb/engine';
import type { ColumnSummary } from './column-summary';
import { summarize } from './summary-queries';

// The types that the text of the grid casts back to exactly; any other column stays text (VARCHAR).
const CASTABLE =
  /^(U?(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|FLOAT|DOUBLE|DECIMAL\(\d+,\d+\)|BOOLEAN|DATE|TIME( WITH TIME ZONE)?|TIMESTAMP(_S|_MS|_NS)?|TIMESTAMP WITH TIME ZONE|UUID|VARCHAR)$/;

const textOf = (value: GridValue): string => (typeof value === 'string' ? value : String(value));

/**
 * Summarizes the loaded rows: they go as text into a table of a fresh DuckDB, are cast back to the types of their
 * columns where DuckDB can, and get the same queries as a whole result. A column that stays text is summarized as
 * text; a struct, map, list or array (JSON text here) only counts its NULLs, as it would in its own type.
 */
export async function summarizeLoaded(
  columns: readonly GridColumn[],
  rows: readonly (readonly GridValue[])[],
  reason: 'writes' | 'cancelled',
): Promise<ColumnSummary> {
  const engine = await loadEngine('; the statistics of the columns need it.');
  const instance = await engine.DuckDBInstance.create(':memory:', { enable_external_access: 'false' });
  const connection = await instance.connect();
  try {
    const positions = columns.map((_, index) => quoteIdentifier(`c${index + 1}`));
    await connection.run(`CREATE TABLE loaded (${positions.map((name) => `${name} VARCHAR`).join(', ')})`);
    const appender = await connection.createAppender('loaded');
    for (const row of rows) {
      columns.forEach((_, index) => {
        const value = row[index] ?? null;
        if (value === null) appender.appendNull();
        else appender.appendVarchar(textOf(value));
      });
      appender.endRow();
    }
    appender.flushSync();
    appender.closeSync();
    const typed = columns.map(({ type }, index) => {
      const name = positions[index] ?? '';
      return CASTABLE.test(type) ? `TRY_CAST(${name} AS ${type}) AS ${name}` : name;
    });
    // The type that each column has in the table above decides its figures.
    const known = columns.map(({ name, type, kind }) => ({
      name,
      type: CASTABLE.test(type) || kind === 'nested' ? type : 'VARCHAR',
    }));
    const found = await summarize(
      async (sql) => (await connection.runAndReadAll(sql)).getRowsJson(),
      `SELECT ${typed.join(', ')} FROM loaded`,
      known,
    );
    return {
      cover: { kind: 'loaded', rows: rows.length, reason },
      columns: found.columns.map((stats, index) => ({
        ...stats,
        type: columns[index]?.type ?? stats.type,
      })),
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
