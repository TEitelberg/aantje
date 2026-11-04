import { expect, it, vi } from 'vitest';
import { openCatalog } from '../../src/catalog/open';
import { fixturePath, wasmPath } from '../support/fixtures';

const loaded = vi.hoisted(() => ({ postgres: false, duckdb: false }));

vi.mock('../../src/catalog/drivers/postgres', () => {
  loaded.postgres = true;
  return { openPostgres: vi.fn() };
});
vi.mock('../../src/catalog/drivers/duckdb', () => {
  loaded.duckdb = true;
  return { openDuckdb: vi.fn() };
});

it('opens a SQLite catalog without loading the PostgreSQL and DuckDB driver modules', async () => {
  const { reader } = await openCatalog(
    { id: 'lake', name: 'Lake', kind: 'sqlite', path: fixturePath('ducklake.sqlite') },
    { wasmPath },
  );
  await reader.close();

  expect(loaded).toEqual({ postgres: false, duckdb: false });
});
