import { createRequire } from 'node:module';
import { openDuckdb } from '../../../src/catalog/drivers/duckdb';
import { fixturePath } from '../fixtures';
import type { CatalogSource } from './types';

/** The native binding is a platform package that may be missing; then the DuckDB suites are skipped. */
function bindingProblem(): string | undefined {
  try {
    createRequire(import.meta.url)('@duckdb/node-api');
    return undefined;
  } catch (error) {
    return `DuckDB native binding cannot be loaded: ${(error as Error).message}`;
  }
}

export const duckdbSource: CatalogSource = {
  name: 'duckdb',
  skipReason: bindingProblem,
  open: () => openDuckdb({ path: fixturePath('ducklake.duckdb') }),
};
