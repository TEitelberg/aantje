import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { historyFixture } from '../support/sources/history';
import { extensionDirectory } from './data-support';
import type { DataFixture } from './data-support';

/**
 * A private copy of the history fixture (catalog and Parquet files) whose `data_path` points to the copy, like
 * `copyDataFixture` does for test/fixtures/data: the stored path is relative to the working directory of the reader.
 */
export async function copyHistoryFixture(kind: 'sqlite' | 'duckdb'): Promise<DataFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'aantje-history-'));
  const file = `history.${kind}`;
  await cp(historyFixture[kind], join(directory, file));
  await cp(join(historyFixture.directory, `${kind}-files`), join(directory, `${kind}-files`), {
    recursive: true,
  });
  const dataPath = `${join(directory, `${kind}-files`).replaceAll('\\', '/')}/`;

  const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
  const connection = await instance.connect();
  try {
    if (kind === 'sqlite') {
      await connection.run('LOAD sqlite');
    }
    const path = join(directory, file).replaceAll("'", "''");
    await connection.run(`ATTACH '${path}' AS meta${kind === 'sqlite' ? ' (TYPE sqlite)' : ''}`);
    await connection.run(
      `UPDATE meta.ducklake_metadata SET value = '${dataPath.replaceAll("'", "''")}' WHERE key = 'data_path'`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  return {
    profile: { id: kind, name: kind, kind, path: join(directory, file) },
    directory,
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}
