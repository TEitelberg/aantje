import { expect, it, vi } from 'vitest';
import { describeRelation, previewTable } from '../../src/data/engine';
import { AantjeError } from '../../src/errors';

const loaded = vi.hoisted(() => ({ duckdb: 0 }));

// The module that stands in for the native binding: it counts how often it is loaded and refuses to start an instance.
vi.mock('@duckdb/node-api', () => {
  loaded.duckdb++;
  return {
    DuckDBInstance: { create: () => Promise.reject(new Error('stop here, this is a stand-in')) },
  };
});

const access = { profile: { id: 'lake', name: 'Lake', kind: 'sqlite', path: 'x.sqlite' }, s3: {} } as const;
const orders = { schema: 'sales', table: 'orders' };

// A documented decision (data-access.md, "Load the native engine ... the same lazy load"): the extension starts
// where there is no binding, because nothing loads it before data is read.
it('loads the native DuckDB binding only when data is read, and only once', async () => {
  expect(loaded.duckdb).toBe(0);

  await expect(previewTable(access, orders)).rejects.toBeInstanceOf(AantjeError);
  expect(loaded.duckdb).toBe(1);

  await expect(describeRelation(access, orders)).rejects.toBeInstanceOf(AantjeError);
  expect(loaded.duckdb).toBe(1);
});
