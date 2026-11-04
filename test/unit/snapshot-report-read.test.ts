import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readActivity } from '../../src/activity/read';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogReader } from '../../src/catalog/model';
import { info } from '../../src/catalog/queries/objects';
import { createCatalogReader } from '../../src/catalog/reader';
import { readGrowth } from '../../src/growth/read';
import { readSnapshotReport } from '../../src/snapshot-report/read';
import { HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { recording } from '../support/recording-driver';
import { historyFixture } from '../support/sources/history';

let reader: CatalogReader;
beforeAll(async () => {
  reader = createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
});
afterAll(async () => {
  await reader.close();
});

const ids = (snapshots: readonly { id: number }[]): number[] => snapshots.map(({ id }) => id);

describe('reading the snapshots for the report', () => {
  it('reads the newest snapshots with the latest snapshot of the catalog and whether there are older ones', async () => {
    const read = await readSnapshotReport(reader, 5);
    expect(ids(read.snapshots)).toEqual([56, 55, 54, 53, 52]);
    expect([read.latest, read.more, read.snapshots.length]).toEqual([HISTORY_LATEST_SNAPSHOT, true, 5]);
  });

  it('says there are no older snapshots when the limit reaches the oldest one', async () => {
    const read = await readSnapshotReport(reader, 100);
    expect(read.snapshots).toHaveLength(HISTORY_LATEST_SNAPSHOT + 1);
    expect(read.more).toBe(false);
  });
});

describe('the newest snapshot of the reports that list snapshots', () => {
  it('is the newest snapshot they read, without asking the catalog for its info', async () => {
    const driver = recording(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
    const catalog = createCatalogReader(driver);
    try {
      const latest = [
        (await readSnapshotReport(catalog, 5)).latest,
        (await readActivity(catalog, 'History')).latest,
        (await readGrowth(catalog, 'History', null, undefined, 5)).latest,
      ];

      expect(latest).toEqual([HISTORY_LATEST_SNAPSHOT, HISTORY_LATEST_SNAPSHOT, HISTORY_LATEST_SNAPSHOT]);
      expect(driver.count(info())).toBe(0);
    } finally {
      await catalog.close();
    }
  });
});
