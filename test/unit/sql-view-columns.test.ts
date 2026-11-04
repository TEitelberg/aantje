import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDuckdb } from '../../src/catalog/drivers/duckdb';
import { createCatalogReader } from '../../src/catalog/reader';
import type { ConnectionProfile } from '../../src/connections/profile';
import { describeRelation } from '../../src/data/engine';
import type { DataAccess, RelationColumn, TableRef } from '../../src/data/types';
import { AantjeError } from '../../src/errors';
import { catalogOfReader } from '../../src/sql/catalog';
import type { SqlCatalog } from '../../src/sql/catalog';
import type { Completions } from '../../src/sql/completion';
import { catalogCache, trustedViewColumns } from '../../src/sql/editor';
import { openLanguageService } from '../../src/sql/language';
import { LATEST_SNAPSHOT } from '../support/expected';
import { createLake, engineSkipReason, extensionDirectory } from './data-support';
import { marked, openSales } from './sql-language-support';
import type { OpenCatalog } from './sql-language-support';

const skipReason = await engineSkipReason();

const service = openLanguageService();
let sales: OpenCatalog;
beforeAll(async () => {
  sales = await openSales();
});
afterAll(async () => {
  await service.dispose();
  await sales.close();
});

const profile: ConnectionProfile = {
  id: 'lake',
  name: 'Lake',
  kind: 'sqlite',
  path: 'D:\\data\\lake.sqlite',
};
const BIG_ORDERS: readonly RelationColumn[] = [
  { name: 'id', type: 'INTEGER', nullable: false },
  { name: 'amount', type: 'DECIMAL(10,2)', nullable: true },
];

/** The views of the sales fixture as completion binds them, with a fake trust and a fake engine behind the real path. */
function fixtureViews(options: {
  trusted: boolean;
  describe?: (signal: AbortSignal | undefined) => Promise<readonly RelationColumn[]>;
}) {
  const trust = { trusted: options.trusted };
  const described: { access: DataAccess; table: TableRef }[] = [];
  const warnings: string[] = [];
  const viewsOf = trustedViewColumns({
    store: { get: (id) => (id === profile.id ? profile : undefined) },
    trust: { isTrusted: () => trust.trusted },
    dataAccess: (asked, snapshot) => Promise.resolve({ profile: asked, snapshot, s3: {} }),
    describe: (access, table, signal) => {
      described.push({ access, table });
      return options.describe?.(signal) ?? Promise.resolve(BIG_ORDERS);
    },
    log: { warn: (message) => warnings.push(message) },
  });
  const catalog = catalogOfReader(
    sales.reader,
    LATEST_SNAPSHOT,
    'lake',
    viewsOf(profile.id, new AbortController().signal),
  );
  return { trust, described, warnings, viewsOf, catalog };
}

async function complete(text: string, catalog: SqlCatalog): Promise<Completions> {
  const cursor = marked(text);
  const result = await service.complete(cursor.text, cursor.offset, catalog);
  if (!result) throw new Error(`No completion in ${JSON.stringify(text)}`);
  return result;
}

const labels = (result: Completions): string[] => result.items.map(({ label }) => label);
const hints = (result: Completions) => result.items.filter(({ kind }) => kind === 'hint');

describe('the columns of a view in completion', () => {
  it('binds a view of a trusted connection once per snapshot in the background, through the explorer path, and offers its columns from then on', async () => {
    const { catalog, described } = fixtureViews({ trusted: true });
    const text = 'select v.| from sales.big_orders v';

    // The first request does not wait for the engine; its list says that it lacks the columns until the read ends.
    const first = await complete(text, catalog);
    expect(labels(first)).toEqual([]);
    expect(first.pending).toBeInstanceOf(Promise);
    await first.pending;
    const after = await complete(text, catalog);
    expect(labels(after)).toEqual(['id', 'amount']);
    expect(after.pending).toBeUndefined();
    expect((await complete('select o.| from sales.orders o', catalog)).pending).toBeUndefined();
    const everywhere = await complete(
      'select | from sales.orders o join sales.big_orders v on true',
      catalog,
    );
    expect(everywhere.items.filter(({ kind }) => kind === 'column').map(({ label }) => label)).toEqual([
      'o.id',
      'customer',
      'attrs',
      'o.amount',
      'created',
      'v.id',
      'v.amount',
    ]);
    expect(hints(everywhere)).toEqual([]);
    const cursor = marked('select am|ount from sales.big_orders');
    expect((await service.hover(cursor.text, cursor.offset, catalog))?.markdown).toContain('DECIMAL(10,2)');

    expect(described).toHaveLength(1);
    expect(described[0]?.table).toEqual({ schema: 'sales', table: 'big_orders' });
    expect(described[0]?.access).toMatchObject({ viewsTrusted: true, snapshot: LATEST_SNAPSHOT });
  });

  it('offers one hint instead of the columns while the views are not trusted, binds nothing and asks nothing, and reads them once trusted', async () => {
    const { catalog, described, trust } = fixtureViews({ trusted: false });

    const qualified = await complete('select v.| from sales.big_orders v', catalog);
    expect(qualified.items.map(({ kind, insertText }) => [kind, insertText])).toEqual([['hint', '']]);
    expect(qualified.pending).toBeUndefined();
    const typing = await complete(
      'select am| from sales.orders o join sales.big_orders v on true join sales.big_orders w on true',
      catalog,
    );
    expect(hints(typing).map(({ insertText }) => insertText)).toEqual(['am']);
    expect(typing.items.slice(0, 6).map(({ kind }) => kind)).toEqual([
      ...Array<string>(5).fill('column'),
      'hint',
    ]);
    expect(hints(await complete('select * from sales.orders where |', catalog))).toEqual([]);
    expect(described).toEqual([]);

    trust.trusted = true;
    await vi.waitFor(async () =>
      expect(labels(await complete('select v.| from sales.big_orders v', catalog))).toEqual(['id', 'amount']),
    );
    trust.trusted = false;
    expect(hints(await complete('select v.| from sales.big_orders v', catalog))).toHaveLength(1);
    expect(described).toHaveLength(1);
  });

  it('offers no columns of a view that cannot be bound and logs that once, but not a read that the dropped catalog aborted', async () => {
    const broken = fixtureViews({
      trusted: true,
      describe: () =>
        Promise.reject(new AantjeError('QUERY_FAILED', 'Table with name orders does not exist')),
    });
    for (let request = 0; request < 3; request += 1) {
      const result = await complete('select v.| from sales.big_orders v', broken.catalog);
      expect(result.items).toEqual([]);
      await vi.waitFor(() => expect(broken.warnings).toHaveLength(1));
    }
    expect(broken.described).toHaveLength(1);
    expect(broken.warnings[0]).toContain('sales.big_orders');

    // Like the engine: the read ends when its signal aborts.
    const ended: string[] = [];
    const aborted = fixtureViews({
      trusted: true,
      describe: (signal) =>
        new Promise((_, reject) =>
          signal?.addEventListener('abort', () => {
            ended.push('aborted');
            reject(new AantjeError('ABORTED', 'Cancelled.'));
          }),
        ),
    });
    const cache = catalogCache({
      reader: () => sales.reader,
      snapshot: () => LATEST_SNAPSHOT,
      views: aborted.viewsOf,
    });
    const catalog = cache.of(profile.id);
    if (!catalog) throw new Error('No catalog.');
    await complete('select v.| from sales.big_orders v', catalog);
    await vi.waitFor(() => expect(aborted.described).toHaveLength(1));
    cache.invalidate();
    expect(ended).toEqual(['aborted']);
    await new Promise((settled) => setTimeout(settled, 10));
    expect(aborted.warnings).toEqual([]);
  });
});

describe.skipIf(skipReason)('the columns of a view on a real lake', () => {
  it('offers the columns that DuckDB binds at the newest snapshot, and at the one that AT (VERSION => n) names', async () => {
    const lake = await createLake([
      'CREATE TABLE base (a INTEGER, b VARCHAR)',
      'CREATE VIEW v AS SELECT a FROM base',
      'CREATE OR REPLACE VIEW v AS SELECT a, b, a + 1 AS c FROM base',
    ]);
    const reader = createCatalogReader(await openDuckdb({ path: lake.profile.path }));
    const warnings: string[] = [];
    try {
      const viewsOf = trustedViewColumns({
        store: { get: () => lake.profile },
        trust: { isTrusted: () => true },
        dataAccess: (asked, snapshot) =>
          Promise.resolve({ profile: asked, snapshot, s3: {}, extensionDirectory }),
        describe: describeRelation,
        log: { warn: (message) => warnings.push(message) },
      });
      const { latestSnapshot } = await reader.info();
      const catalog = catalogOfReader(
        reader,
        latestSnapshot,
        'lake',
        viewsOf(lake.profile.id, new AbortController().signal),
      );
      const columnsOf = async (text: string): Promise<string[][]> =>
        (await complete(text, catalog)).items.map(({ label, detail }) => [label, detail ?? '']);

      await vi.waitFor(
        async () =>
          expect(await columnsOf('select x.| from v x')).toEqual([
            ['a', 'INTEGER'],
            ['b', 'VARCHAR'],
            ['c', 'INTEGER'],
          ]),
        { timeout: 60_000, interval: 100 },
      );
      await vi.waitFor(
        async () =>
          expect(await columnsOf(`select x.| from v x at (version => ${latestSnapshot - 1})`)).toEqual([
            ['a', 'INTEGER'],
          ]),
        { timeout: 60_000, interval: 100 },
      );
      expect(warnings).toEqual([]);
    } finally {
      await reader.close();
      await lake.remove();
    }
  }, 120_000);
});
