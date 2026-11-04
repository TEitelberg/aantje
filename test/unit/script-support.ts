import { DuckDBInstance } from '@duckdb/node-api';
import { openDuckdb } from '../../src/catalog/drivers/duckdb';
import { quoteIdentifier } from '../../src/catalog/ddl';
import { createCatalogReader } from '../../src/catalog/reader';
import { firstSchemaQuery, USE_LAKE } from '../../src/data/attach';
import { CatalogTree } from '../../src/tree/model';
import type { CatalogTreeDeps } from '../../src/tree/model';
import type { TreeNode } from '../../src/tree/refs';
import { opened } from '../support/opened';
import { extensionDirectory } from './data-support';
import type { Lake } from './data-support';

/** Runs the callback with the scripts of a real lake; the catalog is closed again before the lake is written to. */
export async function scriptsOf<T>(
  lake: Lake,
  produce: (nodeAt: (...labels: string[]) => Promise<TreeNode>, tree: CatalogTree) => Promise<T>,
  viewColumns?: CatalogTreeDeps['viewColumns'],
): Promise<T> {
  const tree = new CatalogTree({
    viewColumns,
    profiles: () => [lake.profile],
    open: async () => opened(createCatalogReader(await openDuckdb({ path: lake.profile.path }))),
  });
  try {
    const nodeAt = async (...labels: string[]): Promise<TreeNode> => {
      let node = tree.roots()[0];
      for (const label of labels) {
        const child = node && (await tree.children(node)).find((candidate) => candidate.label === label);
        if (!child) {
          throw new Error(`No node "${label}" under "${node?.label}"`);
        }
        node = child;
      }
      if (!node) {
        throw new Error('The tree has no connection');
      }
      return node;
    };
    await tree.connect(lake.profile.id);
    return await produce(nodeAt, tree);
  } finally {
    await tree.dispose();
  }
}

export interface Writer {
  run(sql: string): Promise<void>;
  /** The rows of a query as JSON values. */
  rows(sql: string): Promise<unknown[][]>;
  /** Runs every statement of a script, and returns the rows of each one. */
  results(script: string): Promise<unknown[][][]>;
  /** Runs the statement in a transaction that is rolled back, and returns what the query then sees. */
  tried(statement: string, query: string): Promise<unknown[][]>;
  /** Runs the statement in a transaction that is rolled back; returns the error message, or undefined when it ran. */
  attempt(statement: string): Promise<string | undefined>;
}

/** What DuckDB says when a statement is no valid SQL or names something that is not there. */
export const NOT_UNDERSTOOD = /Parser Error|Binder Error|does not exist|not found/i;

export const fill = (text: string, values: Record<string, string>): string =>
  Object.entries(values).reduce(
    (result, [placeholder, value]) => result.replaceAll(placeholder, value),
    text,
  );

export const GENERIC_FILL = {
  '<new_column>': '"p1"',
  '<new_name>': '"p2"',
  '<new_field>': '"p3"',
  '<type>': 'INTEGER',
  '<new_type>': 'BIGINT',
  '<column>': '"id"',
};

/** The lake attached as `lake` for writing, the way the SQL editor of a read/write connection runs a script. */
export async function withWriter<T>(lake: Lake, use: (writer: Writer) => Promise<T>): Promise<T> {
  const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
  const connection = await instance.connect();
  try {
    await connection.run('LOAD ducklake');
    await connection.run(`ATTACH 'ducklake:${lake.profile.path.replaceAll("'", "''")}' AS lake`);
    // Like the session of the SQL editor: a lake without the schema main uses its first schema as the default.
    await connection.run(USE_LAKE).catch(async (error: unknown) => {
      const first = (await connection.runAndReadAll(firstSchemaQuery())).getRowsJson()[0]?.[0];
      if (typeof first !== 'string') throw error;
      await connection.run(`${USE_LAKE}.${quoteIdentifier(first)}`);
    });
    const rows = async (sql: string): Promise<unknown[][]> =>
      (await connection.runAndReadAll(sql)).getRowsJson();
    return await use({
      run: async (sql) => void (await connection.run(sql)),
      rows,
      async results(script) {
        if (!/^(?!--).+/m.test(script)) {
          return [];
        }
        const statements = await connection.extractStatements(script);
        const all: unknown[][][] = [];
        for (let index = 0; index < statements.count; index++) {
          all.push(await (await (await statements.prepare(index)).run()).getRowsJson());
        }
        return all;
      },
      async tried(statement, query) {
        await connection.run('BEGIN');
        try {
          await connection.run(statement);
          return await rows(query);
        } finally {
          await connection.run('ROLLBACK');
        }
      },
      async attempt(statement) {
        await connection.run('BEGIN');
        try {
          await connection.run(statement);
          return undefined;
        } catch (error) {
          // The transaction is aborted by the error; ROLLBACK below ends it.
          return (error as Error).message;
        } finally {
          await connection.run('ROLLBACK');
        }
      },
    });
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

export const tableNames =
  "SELECT table_name FROM duckdb_tables() WHERE database_name = 'lake' ORDER BY table_name";
export const viewNames =
  "SELECT view_name FROM duckdb_views() WHERE database_name = 'lake' AND NOT internal ORDER BY view_name";
