import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogReader, ColumnInfo } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { HISTORY_ID, HISTORY_LATEST_SNAPSHOT, HISTORY_SNAPSHOT } from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { historyFixture, historySources } from '../support/sources/history';

const { evolving, customers, oldStuff, events } = HISTORY_ID;

const EVOLVING_VERSIONS = [26, 28, 29, 30, 31, 32, 33, 34, 35];
const EVOLVING_LAST_OUTLINE =
  'id:int32 title:varchar info:struct[a:int32 b:varchar c:float64!] n:int64 flag:boolean=true';

/** Names, types and defaults of a column tree, nested fields in brackets. */
const outline = (columns: readonly ColumnInfo[]): string =>
  columns
    .map(
      (column) =>
        `${column.name}:${column.type}${column.nullable ? '' : '!'}${column.defaultValue === null ? '' : `=${column.defaultValue}`}${
          column.children.length > 0 ? `[${outline(column.children)}]` : ''
        }`,
    )
    .join(' ');

for (const source of historySources) {
  const skipReason = source.skipReason();
  describe.skipIf(skipReason !== undefined)(
    `schemaHistory on the history fixture, ${source.name}${skipReason === undefined ? '' : ` (skipped: ${skipReason})`}`,
    () => {
      let reader: CatalogReader;

      beforeAll(async () => {
        reader = createCatalogReader(await source.open());
      });
      afterAll(() => reader.close());

      it('lists a version of main.evolving for every snapshot that created, renamed or changed it, oldest first, with the columns the reader reads at every snapshot, time and author, and the newest ones only with a limit', async () => {
        const { versions, more } = await reader.schemaHistory(evolving);
        expect(versions.map(({ snapshot }) => snapshot)).toEqual(EVOLVING_VERSIONS);
        expect(versions.map(({ table }) => table?.name)).toEqual([
          ...Array.from({ length: 8 }, () => 'evolving'),
          'evolved',
        ]);
        expect(versions.every(({ table }) => table?.schemaName === 'main')).toBe(true);
        expect(more).toBe(false);

        for (
          let snapshot = HISTORY_SNAPSHOT.createEvolving;
          snapshot <= HISTORY_LATEST_SNAPSHOT;
          snapshot++
        ) {
          const version = versions.findLast((candidate) => candidate.snapshot <= snapshot);
          expect(outline(version?.columns ?? []), `@${snapshot}`).toBe(
            outline(await reader.columns(evolving, snapshot)),
          );
        }
        expect(outline(versions[0]?.columns ?? [])).toBe(
          'id:int32 name:varchar info:struct[a:int32 b:varchar] n:int32',
        );
        expect(outline(versions.at(-1)?.columns ?? [])).toBe(EVOLVING_LAST_OUTLINE);

        for (const version of versions) {
          expect(Date.parse(version.time ?? '')).not.toBeNaN();
          expect(version.time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z$/);
          expect(version.author).toBeNull();
        }

        const page = await reader.schemaHistory(evolving, 3);
        expect(page.versions.map(({ snapshot }) => snapshot)).toEqual([33, 34, 35]);
        expect(page.more).toBe(true);
        expect((await reader.schemaHistory(evolving, EVOLVING_VERSIONS.length)).more).toBe(false);
      });

      it('has a version when only the comment of a column changed', async () => {
        const { versions } = await reader.schemaHistory(customers);
        expect(versions.map(({ snapshot }) => snapshot)).toEqual([
          HISTORY_SNAPSHOT.createCustomers,
          HISTORY_SNAPSHOT.commentOnTier,
        ]);
        expect(versions.map(({ columns }) => columns.map(({ comment }) => comment))).toEqual([
          [null, null, null],
          [null, null, 'bronze, silver or gold'],
        ]);
      });

      it('ends a dropped table with a version without table and columns, has only the creation for an unchanged table and nothing for an id that is not a table', async () => {
        const { versions } = await reader.schemaHistory(oldStuff);
        expect(
          versions.map(({ snapshot, table, columns }) => [snapshot, table?.name ?? null, columns.length]),
        ).toEqual([
          [HISTORY_SNAPSHOT.createOldStuff, 'old_stuff', 1],
          [HISTORY_SNAPSHOT.dropOldStuff, null, 0],
        ]);
        expect((await reader.schemaHistory(events)).versions.map(({ snapshot }) => snapshot)).toEqual([
          HISTORY_SNAPSHOT.createEvents,
        ]);
        expect(await reader.schemaHistory(HISTORY_ID.shopSchema)).toEqual({ versions: [], more: false });
      });
    },
  );
}

describe('schemaHistory on the catalog after the snapshots expired', () => {
  it('keeps the versions and knows no time for the snapshots that are gone', async () => {
    const expired = createCatalogReader(await openSqlite({ path: historyFixture.expired, wasmPath }));
    try {
      const { versions } = await expired.schemaHistory(evolving);
      expect(versions.map(({ snapshot }) => snapshot)).toEqual(EVOLVING_VERSIONS);
      expect(versions.map(({ time }) => time === null)).toEqual(EVOLVING_VERSIONS.map(() => true));
      expect(outline(versions.at(-1)?.columns ?? [])).toBe(EVOLVING_LAST_OUTLINE);
    } finally {
      await expired.close();
    }
  });
});
