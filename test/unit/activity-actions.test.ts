import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planActivityAction } from '../../src/activity/actions';
import type { ActivityActionRequest, ActivityPlan } from '../../src/activity/actions';
import { performActivityAction } from '../../src/activity/execute';
import type { ActivityData } from '../../src/activity/model';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogReader } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import type { ReportPort } from '../../src/shell/report-port';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID } from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { historyFixture } from '../support/sources/history';
import { historyActivity } from './activity-support';

const catalogs = editedCatalogs();
let data: ActivityData;
let reader: CatalogReader;

beforeAll(async () => {
  data = await historyActivity(catalogs);
  reader = createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
});
afterAll(async () => {
  await catalogs.dispose();
  await reader.close();
});

describe('which actions the data of the Activity offers', () => {
  it('opens the snapshot report whatever else is asked', () => {
    expect(planActivityAction(data, { action: 'showSnapshotReport' })).toEqual({
      action: 'showSnapshotReport',
    });
  });

  it('shows the catalog at a snapshot that was sent, and at no other', () => {
    expect(planActivityAction(data, { action: 'showCatalog', snapshot: 25 })).toEqual({
      action: 'showCatalog',
      snapshot: 25,
    });
    expect(planActivityAction(data, { action: 'showCatalog', snapshot: 99 })).toBeUndefined();
    expect(planActivityAction(data, { action: 'showCatalog' })).toBeUndefined();
  });

  it('shows the rows that a snapshot changed in a table, where it inserted or deleted rows and did not drop it', () => {
    expect(
      planActivityAction(data, { action: 'rowsChanged', snapshot: 23, table: HISTORY_ID.events }),
    ).toEqual({
      action: 'rowsChanged',
      snapshot: 23,
      table: { schema: 'shop', table: 'events' },
    });
    // Snapshot 5 only altered the table, snapshot 45 dropped one, and snapshot 24 has the table of another.
    expect(
      planActivityAction(data, { action: 'rowsChanged', snapshot: 5, table: HISTORY_ID.events }),
    ).toBeUndefined();
    expect(
      planActivityAction(data, { action: 'rowsChanged', snapshot: 45, table: HISTORY_ID.oldStuff }),
    ).toBeUndefined();
    expect(
      planActivityAction(data, { action: 'rowsChanged', snapshot: 24, table: HISTORY_ID.events }),
    ).toBeUndefined();
    expect(planActivityAction(data, { action: 'rowsChanged', snapshot: 23 })).toBeUndefined();
  });

  it('compares the catalog with the snapshot before, or the latest, older snapshot first', () => {
    expect(
      planActivityAction(data, { action: 'compareSnapshots', snapshot: 30, against: 'previous' }),
    ).toEqual({
      action: 'compareSnapshots',
      from: 29,
      to: 30,
    });
    expect(planActivityAction(data, { action: 'compareSnapshots', snapshot: 30, against: 'latest' })).toEqual(
      {
        action: 'compareSnapshots',
        from: 30,
        to: 56,
      },
    );
    expect(
      planActivityAction(data, { action: 'compareSnapshots', snapshot: 0, against: 'previous' }),
    ).toBeUndefined();
    expect(
      planActivityAction(data, { action: 'compareSnapshots', snapshot: 56, against: 'latest' }),
    ).toBeUndefined();
    expect(planActivityAction(data, { action: 'compareSnapshots', snapshot: 30 })).toBeUndefined();
  });

  it('offers nothing that the snapshot report would not offer, for any action that the page cannot name', () => {
    for (const action of ['query', 'compareSchema', 'showLatest']) {
      expect(
        planActivityAction(data, {
          action,
          snapshot: 23,
          table: 3,
          against: 'previous',
        } as unknown as ActivityActionRequest),
      ).toBeUndefined();
    }
  });
});

interface Calls {
  readonly catalog: (number | 'latest')[];
  readonly reports: string[];
  readonly rows: [unknown, number][];
  readonly snapshotReports: number[];
}

/** What the port was asked to do; the reader behind it is the real one on the history fixture. */
function port(options: { open?: boolean } = {}): { port: ReportPort; calls: Calls } {
  const calls: Calls = { catalog: [], reports: [], rows: [], snapshotReports: [] };
  const unused = () => Promise.reject(new Error('the Activity never asks for this'));
  return {
    calls,
    port: {
      connectionId: 'history',
      connectionName: 'History',
      ui: { pick: () => Promise.resolve(undefined), info: () => undefined },
      reader: () => (options.open === false ? undefined : reader),
      showCatalog: (snapshot) => void calls.catalog.push(snapshot),
      showsLatest: () => false,
      showChanges: (choice) => Promise.resolve(void calls.rows.push([choice.table, choice.to])),
      showSchema: unused,
      showReport: (markdown) => Promise.resolve(void calls.reports.push(markdown)),
      showRows: unused,
      openSql: unused,
      createNotebook: unused,
    },
  };
}

const planned = (request: ActivityActionRequest): ActivityPlan => {
  const plan = planActivityAction(data, request);
  if (!plan) throw new Error('the data does not offer that action');
  return plan;
};

describe('the actions of the Activity', () => {
  it('shows the catalog at the snapshot', async () => {
    const shown = port();
    await performActivityAction(planned({ action: 'showCatalog', snapshot: 25 }), shown.port, () =>
      Promise.resolve(),
    );
    expect(shown.calls.catalog).toEqual([25]);
  });

  it('opens the snapshot report through the callback of the command, and does not read the catalog for it', async () => {
    const shown = port();
    let opened = 0;
    await performActivityAction(planned({ action: 'showSnapshotReport' }), shown.port, () =>
      Promise.resolve(void opened++),
    );
    expect(opened).toBe(1);
    expect(shown.calls.catalog).toEqual([]);
  });

  it('opens the report of the comparison of two snapshots', async () => {
    const shown = port();
    await performActivityAction(
      planned({ action: 'compareSnapshots', snapshot: 30, against: 'previous' }),
      shown.port,
      () => Promise.resolve(),
    );
    expect(shown.calls.reports).toHaveLength(1);
    expect(shown.calls.reports[0]).toContain('@29 to @30');
    expect(shown.calls.reports[0]).toContain('type of `n` changed from `int32` to `int64`');
  });

  it('shows the rows that a snapshot changed in a table', async () => {
    const shown = port();
    await performActivityAction(
      planned({ action: 'rowsChanged', snapshot: 23, table: HISTORY_ID.events }),
      shown.port,
      () => Promise.resolve(),
    );
    expect(shown.calls.rows).toEqual([[{ schema: 'shop', table: 'events' }, 23]]);
  });

  it('tells the user to connect again when the connection is closed, for every action', async () => {
    for (const request of [
      { action: 'showSnapshotReport' },
      { action: 'showCatalog', snapshot: 25 },
      { action: 'rowsChanged', snapshot: 23, table: HISTORY_ID.events },
      { action: 'compareSnapshots', snapshot: 30, against: 'previous' },
    ] as const) {
      const closed = port({ open: false });
      let opened = 0;
      await expect(
        performActivityAction(planned(request), closed.port, () => Promise.resolve(void opened++)),
      ).rejects.toMatchObject({
        code: 'CONNECTION_FAILED',
      });
      expect(opened).toBe(0);
    }
  });
});
