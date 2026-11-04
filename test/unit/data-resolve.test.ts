import { describe, expect, it } from 'vitest';
import type { SchemaInfo, SnapshotId, ViewInfo } from '../../src/catalog/model';
import type { ConnectionProfile } from '../../src/connections/profile';
import { resolveViewColumns } from '../../src/data/resolve';
import type { DataAccess, RelationColumn, TableRef } from '../../src/data/types';
import { AantjeError } from '../../src/errors';

const profile: ConnectionProfile = {
  id: 'lake',
  name: 'Lake',
  kind: 'sqlite',
  path: 'D:\\data\\lake.sqlite',
};
const sales: SchemaInfo = { id: 1, name: 'sales', comment: null };
const bigOrders: ViewInfo = {
  id: 4,
  schemaId: 1,
  name: 'big_orders',
  comment: null,
  sql: 'SELECT * FROM sales.orders',
  dialect: 'duckdb',
  columnAliases: [],
};
const COLUMNS: readonly RelationColumn[] = [{ name: 'id', type: 'INTEGER', nullable: false }];

/** The steps of one resolution, in the order they happened. */
function setup(options: { confirm?: () => Promise<void>; known?: boolean } = {}) {
  const steps: string[] = [];
  const described: { access: DataAccess; table: TableRef; signal: AbortSignal | undefined }[] = [];
  const requested: { profile: ConnectionProfile; snapshot: SnapshotId | undefined }[] = [];
  const resolve = resolveViewColumns({
    store: { get: (id) => (options.known === false || id !== profile.id ? undefined : profile) },
    confirm: async (asked) => {
      steps.push(`confirm ${asked.name}`);
      await options.confirm?.();
    },
    dataAccess: (asked, snapshot) => {
      steps.push('access');
      requested.push({ profile: asked, snapshot });
      return Promise.resolve({ profile: asked, snapshot, s3: {} });
    },
    describe: (access, table, signal) => {
      steps.push('describe');
      described.push({ access, table, signal });
      return Promise.resolve(COLUMNS);
    },
  });
  return { resolve, steps, described, requested };
}

describe('resolving the columns of a view', () => {
  it('asks the user first, then reads the access, then describes the view by schema and name at the shown snapshot (also 0) with the signal passed on', async () => {
    const { resolve, steps, described, requested } = setup();
    const signal = new AbortController().signal;

    const columns = await resolve('lake', sales, bigOrders, 7, signal);
    await resolve('lake', sales, bigOrders, 0, signal);

    expect(columns).toBe(COLUMNS);
    expect(steps.slice(0, 3)).toEqual(['confirm Lake', 'access', 'describe']);
    expect(requested).toEqual([
      { profile, snapshot: 7 },
      { profile, snapshot: 0 },
    ]);
    expect(described[0]?.table).toEqual({ schema: 'sales', table: 'big_orders' });
    expect(described[0]?.access.snapshot).toBe(7);
    expect(described[0]?.signal).toBe(signal);
  });

  it('starts neither the access nor the engine when the user declines, and fails for a connection that is gone without asking anything', async () => {
    const declined = setup({
      confirm: () => Promise.reject(new AantjeError('ABORTED', 'You did not trust it.')),
    });
    await expect(
      declined.resolve('lake', sales, bigOrders, 13, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(declined.steps).toEqual(['confirm Lake']);

    const gone = setup({ known: false });
    await expect(
      gone.resolve('lake', sales, bigOrders, 13, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'INVALID_PROFILE',
    });
    expect(gone.steps).toEqual([]);
  });
});
