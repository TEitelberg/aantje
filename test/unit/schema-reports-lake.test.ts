import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityOlderNote } from '../../src/activity/model';
import { readActivity } from '../../src/activity/read';
import { readGrowth } from '../../src/growth/read';
import { growthModelOf, growthOlderNote, hasExpired, seriesOf } from '../../src/growth/model';
import { storageMarkdown } from '../../src/storage-report/markdown';
import { readStorage } from '../../src/storage-report/read';
import type { ReportScope } from '../../src/shell/scope';
import { lakeBackends } from './lake-backends';
import type { BackendLake } from './lake-backends';

const backends = await lakeBackends();

// Two schemas written in turn: the reports of one must hold its tables and its snapshots and nothing of the other.
describe.each(backends)('the reports of one schema on a lake with $name metadata', (backend) => {
  describe.skipIf(backend.skipReason !== undefined)('two schemas', () => {
    let lake: BackendLake;
    let shop: ReportScope;
    let crm: ReportScope;

    const sql = (text: string): Promise<unknown> => lake.connection.run(text);

    async function withReader<T>(use: (reader: Awaited<ReturnType<BackendLake['reader']>>) => Promise<T>) {
      const reader = await lake.reader();
      try {
        return await use(reader);
      } finally {
        await reader.close();
      }
    }

    beforeAll(async () => {
      lake = await backend.create();
      await sql('CREATE SCHEMA shop');
      await sql('CREATE SCHEMA crm');
      await sql('CREATE TABLE shop.events(id INTEGER)');
      await sql('CREATE TABLE crm.contacts(id INTEGER)');
      for (let part = 0; part < 3; part++) {
        await sql(`INSERT INTO shop.events SELECT range FROM range(${100 * (part + 1)})`);
        await sql(`INSERT INTO crm.contacts SELECT range FROM range(${10 * (part + 1)})`);
      }
      await sql('CREATE TABLE shop.gone(id INTEGER)');
      await sql('INSERT INTO shop.gone VALUES (1)');
      await sql('DROP TABLE shop.gone');
      await sql("CALL ducklake_merge_adjacent_files('lake', 'contacts', schema => 'crm')");
      await sql('DELETE FROM crm.contacts WHERE id < 5');
      const schemas = await withReader(async (reader) =>
        reader.schemas((await reader.info()).latestSnapshot),
      );
      const scopeOf = (name: string): ReportScope => ({
        kind: 'schema',
        id: schemas.find((schema) => schema.name === name)?.id ?? -1,
        name,
      });
      shop = scopeOf('shop');
      crm = scopeOf('crm');
    });
    afterAll(() => lake?.remove());

    // The first two numbers of a note, in the order of the text.
    const numbersIn = (text: string): number[] =>
      [...text.matchAll(/[0-9]+/g)].slice(0, 2).map(([digits]) => Number(digits));

    const names = (tables: readonly { schema: string; name: string }[]): string[] =>
      tables.map(({ schema, name }) => `${schema}.${name}`).toSorted();

    it('the Storage report counts the tables, files, rows and growth of the schema only', async () => {
      const [whole, mine, other] = await withReader(async (reader) => {
        const snapshot = (await reader.info()).latestSnapshot;
        const read = (scope?: ReportScope) =>
          readStorage(reader, 'Lake', snapshot, new Date(), undefined, scope);
        return [await read(), await read(shop), await read(crm)];
      });

      expect(names(mine.tables)).toEqual(['shop.events']);
      expect(names(other.tables)).toEqual(['crm.contacts']);
      expect(mine.storage.dataFiles.count + other.storage.dataFiles.count).toBe(
        whole.storage.dataFiles.count,
      );
      expect(mine.storage.deleteFiles.count + other.storage.deleteFiles.count).toBe(
        whole.storage.deleteFiles.count,
      );
      expect(mine.rows + other.rows).toBe(whole.rows);
      expect(mine.storage.dataFiles.count).toBe(mine.tables.reduce((sum, table) => sum + table.files, 0));
      expect(mine.growth.at(-1)?.files).toBe(mine.storage.dataFiles.count);
      expect(mine.growth.at(-1)?.sizeBytes).toBe(
        mine.storage.dataFiles.sizeBytes + mine.storage.deleteFiles.sizeBytes,
      );
      expect(other.growth.some((point) => point.compaction)).toBe(true);
      expect(mine.growth.some((point) => point.compaction)).toBe(false);
      expect(mine.storage.scheduledForDeletion).toEqual(whole.storage.scheduledForDeletion);
      expect(mine.storage.dataPath).toBe(whole.storage.dataPath);
      expect(storageMarkdown(mine)).not.toContain('crm');
    });

    it('the Activity report lists the snapshots that changed the schema, with their changes to it', async () => {
      const [whole, mine] = await withReader(async (reader) => [
        await readActivity(reader, 'Lake'),
        await readActivity(reader, 'Lake', undefined, shop),
      ]);

      expect(mine.scope).toEqual(shop);
      expect(mine.snapshots.length).toBeGreaterThan(0);
      expect(mine.snapshots.length).toBeLessThan(whole.snapshots.length);
      const touched = mine.snapshots.flatMap(({ changes }) => changes);
      expect(touched.length).toBeGreaterThan(0);
      expect(
        touched.every(
          (change) => change.schemaName === 'shop' || (change.object === 'schema' && change.name === 'shop'),
        ),
      ).toBe(true);
      expect(mine.snapshots.map(({ id }) => id)).toEqual(
        whole.snapshots
          .filter(({ changes }) =>
            changes.some((change) => change.schemaName === 'shop' || change.name === 'shop'),
          )
          .map(({ id }) => id),
      );
    });

    it('the Growth report has the tables and the changes of the schema, including a dropped table', async () => {
      const [whole, mine] = await withReader(async (reader) => [
        await readGrowth(reader, 'Lake', null),
        await readGrowth(reader, 'Lake', null, undefined, undefined, shop),
      ]);

      expect(names(mine.tables)).toEqual(['shop.events']);
      const events = whole.tables.find(({ name }) => name === 'events')?.id;
      expect(
        mine.changes.every(
          ({ tableId }) => tableId === events || !whole.tables.some(({ id }) => id === tableId),
        ),
      ).toBe(true);
      expect(
        mine.changes.some(
          ({ tableId }) => tableId === whole.tables.find(({ name }) => name === 'contacts')?.id,
        ),
      ).toBe(false);
      const steps = seriesOf(mine, growthModelOf(mine), undefined);
      expect(steps.at(-1)?.total.rows).toBe(600);
      const lakeSteps = seriesOf(whole, growthModelOf(whole), undefined);
      expect(lakeSteps.at(-1)?.total.rows).toBeGreaterThan(600);
    });

    it('the notes of the Growth and Activity reports of a schema count the snapshots that were read, and no expiry is told where only the snapshots of the schema have gaps', async () => {
      const [whole, mine, limited, activity] = await withReader(async (reader) => [
        await readGrowth(reader, 'Lake', null),
        await readGrowth(reader, 'Lake', null, undefined, undefined, crm),
        await readGrowth(reader, 'Lake', null, undefined, 4, shop),
        await readActivity(reader, 'Lake', undefined, crm),
      ]);

      // Nothing expired. The snapshots of crm do not start at 0 and have gaps, which is no sign of expiry.
      expect(hasExpired(whole)).toBe(false);
      expect(hasExpired(mine)).toBe(false);
      expect(mine.read).toBe(whole.snapshots.length);
      expect(mine.snapshots.length).toBeLessThan(mine.read ?? 0);

      expect(limited.more).toBe(true);
      expect(limited.read).toBe(4);
      expect(numbersIn(growthOlderNote(limited))).toEqual([4, limited.snapshots.length]);
      expect(activity.read).toBe(whole.snapshots.length);
      expect(numbersIn(activityOlderNote({ ...activity, more: true }))).toEqual([
        activity.read,
        activity.snapshots.length,
      ]);
      // The lake needs no count of its own.
      expect(whole.read).toBeUndefined();
    });
  });
});
