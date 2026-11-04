import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import type { Driver } from '../../src/catalog/drivers/driver';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogReader } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { wasmPath } from './fixtures';

export interface EditedCatalogs {
  /** A reader on a private copy of the SQLite catalog `source` after `statements` ran on it; the source stays as it is. */
  open(source: string, ...statements: string[]): Promise<CatalogReader>;
  /** Closes every reader and deletes the copies. */
  dispose(): Promise<void>;
}

/** Edited copies of the checked-in SQLite catalogs, for what the generated fixtures do not show. */
export function editedCatalogs(): EditedCatalogs {
  const directory = mkdtempSync(join(tmpdir(), 'aantje-edited-'));
  const opened: Driver[] = [];
  let copies = 0;
  return {
    async open(source, ...statements) {
      const wasm = readFileSync(wasmPath);
      const SQL = await initSqlJs({
        wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
      });
      const db = new SQL.Database(readFileSync(source));
      for (const statement of statements) {
        db.run(statement);
      }
      const path = join(directory, `copy-${copies++}.sqlite`);
      writeFileSync(path, db.export());
      db.close();
      const driver = await openSqlite({ path, wasmPath });
      opened.push(driver);
      return createCatalogReader(driver);
    },
    async dispose() {
      await Promise.all(opened.map((driver) => driver.close()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
