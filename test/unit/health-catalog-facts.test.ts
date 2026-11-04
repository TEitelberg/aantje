import { describe, expect, it } from 'vitest';
import { catalogFindings, LARGE_INLINED_ROWS } from '../../src/health/catalog-checks';
import type { HealthCatalogFacts } from '../../src/health/catalog-checks';

const MANY_SNAPSHOTS = 10_000;

const NOW = new Date('2026-10-31T12:00:00.000Z');
const WEEK_MS = 7 * 86_400_000;

const facts = (extra: Partial<HealthCatalogFacts> = {}): HealthCatalogFacts => ({
  now: NOW,
  scope: { kind: 'lake' },
  latest: 40,
  tables: new Map([[3, { schema: 'shop', name: 'events' }]]),
  specVersion: '1.1',
  dataPath: '/lake/',
  snapshotCount: 41,
  limit: 50,
  ...extra,
});

const idsOf = (extra: Partial<HealthCatalogFacts>): string[] =>
  catalogFindings(facts(extra)).findings.map((item) => item.id);

describe('the thresholds of the catalog hints', () => {
  it('hints at expiring snapshots from 10 001 on, not at 10 000', () => {
    expect(idsOf({ snapshotCount: MANY_SNAPSHOTS })).toEqual([]);
    expect(idsOf({ snapshotCount: MANY_SNAPSHOTS + 1 })).toEqual(['catalog.many-snapshots']);
  });

  it('hints at flushing inlined data from 10 001 rows on, not at 10 000', () => {
    const inlined = (rows: number): Partial<HealthCatalogFacts> => ({
      maintenance: {
        snapshotGaps: { count: 0, missing: 0, first: [] },
        smallFiles: [],
        inlined: [{ tableId: 3, rows }],
      },
    });

    expect(idsOf(inlined(LARGE_INLINED_ROWS))).toEqual([]);
    expect(idsOf(inlined(LARGE_INLINED_ROWS + 1))).toEqual(['catalog.large-inlined-data:table:3']);
  });

  it('turns the small files of a table into a warning from 1 000 small files on', () => {
    const small = (count: number): Partial<HealthCatalogFacts> => ({
      maintenance: {
        snapshotGaps: { count: 0, missing: 0, first: [] },
        smallFiles: [{ tableId: 3, files: count + 10, small: count, smallBytes: count }],
        inlined: [],
      },
    });

    expect(catalogFindings(facts(small(999))).findings.map((item) => item.severity)).toEqual(['info']);
    expect(catalogFindings(facts(small(1_000))).findings.map((item) => item.severity)).toEqual(['warning']);
  });

  it('calls the cleanup overdue after seven days, not at seven days', () => {
    const scheduled = (waitedMs: number): Partial<HealthCatalogFacts> => ({
      scheduled: {
        count: 2,
        oldestScheduledAt: new Date(NOW.getTime() - waitedMs).toISOString(),
        split: null,
      },
    });

    expect(idsOf(scheduled(WEEK_MS))).toEqual(['catalog.cleanup-pending']);
    expect(idsOf(scheduled(WEEK_MS + 1))).toEqual(['catalog.cleanup-overdue']);
  });

  it('reports a single file that waits for the cleanup', () => {
    expect(
      idsOf({ scheduled: { count: 1, oldestScheduledAt: '2026-10-31T11:00:00.000Z', split: null } }),
    ).toEqual(['catalog.cleanup-pending']);
    expect(idsOf({ scheduled: { count: 0, oldestScheduledAt: null, split: null } })).toEqual([]);
  });
});

describe('the data path', () => {
  it.each([null, ''])('is missing when the catalog has %j', (dataPath) => {
    const found = catalogFindings(facts({ dataPath })).findings;

    expect(found.map((item) => [item.id, item.severity])).toEqual([['catalog.data-path-missing', 'error']]);
  });
});
