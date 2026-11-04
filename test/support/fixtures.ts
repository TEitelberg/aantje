import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Absolute path of a checked-in fixture catalog (see test/fixtures/README.md). */
export function fixturePath(name: 'ducklake.sqlite' | 'ducklake.duckdb'): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

/** The sql.js WebAssembly binary, as the SQLite driver needs it. */
export const wasmPath = createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm');
