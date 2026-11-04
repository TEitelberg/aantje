import { openSqlite } from '../../../src/catalog/drivers/sqlite';
import { fixturePath, wasmPath } from '../fixtures';
import type { CatalogSource } from './types';

export const sqliteSource: CatalogSource = {
  name: 'sqlite',
  skipReason: () => undefined,
  open: () => openSqlite({ path: fixturePath('ducklake.sqlite'), wasmPath }),
};
