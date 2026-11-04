import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogReader } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import type { SchemaComparison } from '../../src/compare';
import type { TableRef } from '../../src/data/types';
import { performSnapshotReportAction } from '../../src/snapshot-report/execute';
import type { ReportPort } from '../../src/shell/report-port';
import { planSnapshotReportAction } from '../../src/snapshot-report/actions';
import type { SnapshotReportActionRequest, SnapshotReportPlan } from '../../src/snapshot-report/actions';
import type { ChangeChoice } from '../../src/time-travel';
import { HISTORY_ID, HISTORY_SNAPSHOT } from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { historyFixture } from '../support/sources/history';
import { historyReport } from './snapshot-report-support';
import type { SnapshotReportData } from '../../src/snapshot-report/model';

/** What the port was asked to do; the reader behind it is the real one on the history fixture. */
interface Calls {
  readonly catalog: (number | 'latest')[];
  readonly changes: ChangeChoice[];
  readonly schemas: SchemaComparison[];
  readonly reports: string[];
  readonly rows: [TableRef, number][];
  readonly notebooks: [TableRef, number][];
  readonly sql: string[];
  readonly infos: string[];
  readonly picks: string[][];
}

let reader: CatalogReader;
let data: SnapshotReportData;

beforeAll(async () => {
  reader = createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
  data = await historyReport();
});
afterAll(() => reader.close());

function port(options: { open?: boolean; latest?: boolean; answers?: string[] } = {}): {
  port: ReportPort;
  calls: Calls;
} {
  const calls: Calls = {
    catalog: [],
    changes: [],
    schemas: [],
    reports: [],
    rows: [],
    notebooks: [],
    sql: [],
    infos: [],
    picks: [],
  };
  const answers = [...(options.answers ?? [])];
  return {
    calls,
    port: {
      connectionId: 'history',
      connectionName: 'History',
      ui: {
        pick: (items) => {
          calls.picks.push(items.map((item) => item.label));
          const wanted = answers.shift();
          return Promise.resolve(items.find((item) => item.label === wanted));
        },
        info: (message) => void calls.infos.push(message),
      },
      reader: () => (options.open === false ? undefined : reader),
      showCatalog: (snapshot) => void calls.catalog.push(snapshot),
      showsLatest: () => options.latest ?? false,
      showChanges: (choice) => Promise.resolve(void calls.changes.push(choice)),
      showSchema: (comparison) => Promise.resolve(void calls.schemas.push(comparison)),
      showReport: (markdown) => Promise.resolve(void calls.reports.push(markdown)),
      showRows: (table, snapshot) => Promise.resolve(void calls.rows.push([table, snapshot])),
      openSql: (text) => Promise.resolve(void calls.sql.push(text)),
      createNotebook: (table, snapshot) => Promise.resolve(void calls.notebooks.push([table, snapshot])),
    },
  };
}

const planned = (request: SnapshotReportActionRequest): SnapshotReportPlan => {
  const plan = planSnapshotReportAction(data, request);
  if (!plan) throw new Error('the data does not offer that action');
  return plan;
};

describe('the actions of the snapshot report', () => {
  it('shows the catalog at a snapshot, and follows the latest one, unless the tree already does', async () => {
    const shown = port();
    await performSnapshotReportAction(planned({ action: 'showCatalog', snapshot: 23 }), shown.port);
    await performSnapshotReportAction({ action: 'showLatest' }, shown.port);
    expect(shown.calls.catalog).toEqual([23, 'latest']);

    const already = port({ latest: true });
    await performSnapshotReportAction({ action: 'showLatest' }, already.port);
    expect(already.calls.catalog).toEqual([]);
    expect(already.calls.infos).toEqual([expect.stringContaining('"History"')]);
  });

  it('tells the user to connect again when the connection is closed, for every action', async () => {
    for (const plan of [
      { action: 'showLatest' },
      planned({ action: 'showCatalog', snapshot: 23 }),
      planned({ action: 'rowsChanged', snapshot: 23, table: HISTORY_ID.events }),
    ] as const) {
      const closed = port({ open: false });
      await expect(performSnapshotReportAction(plan, closed.port)).rejects.toMatchObject({
        code: 'CONNECTION_FAILED',
      });
      expect(closed.calls.catalog).toEqual([]);
    }
  });

  it('shows the rows that a snapshot changed as the range from its predecessor to it, with the name the table had then', async () => {
    const { port: host, calls } = port();
    await performSnapshotReportAction(
      planned({ action: 'rowsChanged', snapshot: 23, table: HISTORY_ID.customers }),
      host,
    );
    await performSnapshotReportAction(
      planned({
        action: 'rowsChanged',
        snapshot: HISTORY_SNAPSHOT.insertEvolved,
        table: HISTORY_ID.evolving,
      }),
      host,
    );
    expect(calls.changes).toEqual([
      { from: 22, to: 23, table: { schema: 'shop', table: 'customers' } },
      { from: 35, to: 36, table: { schema: 'main', table: 'evolved' } },
    ]);
  });

  it('says so instead of showing rows of a table that the snapshot does not have', async () => {
    const { port: host, calls } = port();
    await performSnapshotReportAction(
      {
        action: 'rowsChanged',
        snapshot: HISTORY_SNAPSHOT.dropOldStuff,
        table: { schema: 'shop', table: 'old_stuff' },
      },
      host,
    );
    expect(calls.changes).toEqual([]);
    expectMissing(calls.infos, 'shop.old_stuff', 45);
  });

  it('compares the schema of a table at two snapshots, older first, and explains a rename', async () => {
    const { port: host, calls } = port();
    await performSnapshotReportAction(
      planned({ action: 'compareSchema', snapshot: 35, table: HISTORY_ID.evolving, against: 'previous' }),
      host,
    );
    await performSnapshotReportAction(
      planned({ action: 'compareSchema', snapshot: 31, table: HISTORY_ID.evolving, against: 'latest' }),
      host,
    );
    expect(calls.schemas.map(({ summary, title }) => [summary, title])).toEqual([
      ['table renamed between @34 and @35', 'main.evolved: @34 ↔ @35'],
      ['table renamed, 2 columns added between @31 and @56', 'main.evolved: @31 ↔ @56'],
    ]);
    expect(calls.schemas[1]?.documents?.left.key).toEqual({
      connectionId: 'history',
      tableId: HISTORY_ID.evolving,
      snapshot: 31,
    });
  });

  it('says so instead of comparing the schema of a table that is missing at one of the snapshots', async () => {
    const { port: host, calls } = port();
    await performSnapshotReportAction(
      {
        action: 'compareSchema',
        subject: { kind: 'table', id: HISTORY_ID.oldStuff, schemaName: 'shop', name: 'old_stuff' },
        from: 44,
        to: 56,
      },
      host,
    );
    expect(calls.schemas).toEqual([]);
    expectMissing(calls.infos, 'shop.old_stuff', 56);
  });

  it('says so, and compares nothing, when the table is not there yet at the older snapshot', async () => {
    const { port: host, calls } = port();
    await performSnapshotReportAction(
      {
        action: 'compareSchema',
        subject: { kind: 'table', id: HISTORY_ID.customers, schemaName: 'shop', name: 'customers' },
        from: 5,
        to: 56,
      },
      host,
    );
    expect(calls.schemas).toEqual([]);
    expectMissing(calls.infos, 'shop.customers', 5);
  });

  it('compares the whole catalog at two snapshots as a report', async () => {
    const { port: host, calls } = port();
    await performSnapshotReportAction(
      planned({ action: 'compareSnapshots', snapshot: 35, against: 'previous' }),
      host,
    );
    const [report] = calls.reports;
    expect(report).toContain('History');
    expect(report).toContain('@34');
    expect(report).toContain('@35');
    expect(report).toContain('evolved');
  });

  it('opens the rows of a table at a snapshot after asking what to open, named as it was then', async () => {
    const { port: host, calls } = port({ answers: ['Top 1000 Rows', 'Create Notebook'] });
    await performSnapshotReportAction(
      planned({ action: 'query', snapshot: 30, table: HISTORY_ID.evolving }),
      host,
    );
    await performSnapshotReportAction(
      planned({ action: 'query', snapshot: 36, table: HISTORY_ID.evolving }),
      host,
    );
    expect(calls.picks).toEqual([
      ['Top 1000 Rows', 'Create Notebook', 'Open as SQL'],
      ['Top 1000 Rows', 'Create Notebook', 'Open as SQL'],
    ]);
    expect(calls.rows).toEqual([[{ schema: 'main', table: 'evolving' }, 30]]);
    expect(calls.notebooks).toEqual([[{ schema: 'main', table: 'evolved' }, 36]]);
  });

  it('opens the SELECT of a table at a snapshot as SQL, with the columns and the name that the table had then', async () => {
    const { port: host, calls } = port({ answers: ['Open as SQL'] });
    await performSnapshotReportAction(
      planned({ action: 'query', snapshot: 30, table: HISTORY_ID.evolving }),
      host,
    );
    expect(calls.sql).toHaveLength(1);
    expect(calls.sql[0]).toContain('"main"."evolving"');
    expect(calls.sql[0]).toContain('"extra"');
    expect(calls.sql[0]).toContain('30');
    expect([calls.rows, calls.notebooks]).toEqual([[], []]);
  });

  it('opens nothing when the question about what to open is cancelled', async () => {
    const { port: host, calls } = port({ answers: [] });
    await performSnapshotReportAction(
      planned({ action: 'query', snapshot: 23, table: HISTORY_ID.events }),
      host,
    );
    expect([calls.rows, calls.notebooks, calls.infos]).toEqual([[], [], []]);
  });

  it('says so, and asks nothing, when the table is not there at the snapshot to query', async () => {
    const { port: host, calls } = port();
    await performSnapshotReportAction(
      {
        action: 'query',
        snapshot: 5,
        subject: { kind: 'table', id: HISTORY_ID.customers, schemaName: 'shop', name: 'customers' },
      },
      host,
    );
    expect(calls.picks).toEqual([]);
    expectMissing(calls.infos, 'shop.customers', 5);
  });
});

/** One message that names the table and the snapshot it does not exist at. */
function expectMissing(infos: readonly string[], table: string, snapshot: number): void {
  expect(infos).toHaveLength(1);
  expect(infos[0]).toContain(`"${table}"`);
  expect(infos[0]).toMatch(new RegExp(`@${snapshot}(?![0-9])`));
}
