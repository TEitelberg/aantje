import { expect, it, vi } from 'vitest';

const loaded = vi.hoisted(() => ({ duckdb: false }));

vi.mock('@duckdb/node-api', () => {
  loaded.duckdb = true;
  return {};
});
// The extension module only uses the editor API when it is activated.
vi.mock('vscode', () => ({}));

it('loads the whole extension without loading the native DuckDB binding', async () => {
  const extension = await import('../../src/extension');

  expect(typeof extension.activate).toBe('function');
  expect(loaded.duckdb).toBe(false);
});
