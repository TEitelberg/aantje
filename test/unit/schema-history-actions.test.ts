import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogReader } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import type { SchemaComparison } from '../../src/compare';
import type { ReportPort } from '../../src/shell/report-port';
import { planSchemaHistoryAction } from '../../src/schema-history/actions';
import type { SchemaHistoryActionRequest, SchemaHistoryPlan } from '../../src/schema-history/actions';
import { performSchemaHistoryAction } from '../../src/schema-history/execute';
import type { SchemaHistoryData } from '../../src/schema-history/model';
import { HISTORY_ID } from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { historyFixture } from '../support/sources/history';
import { historySchema } from './schema-history-support';

const { evolving, oldStuff } = HISTORY_ID;
const SUBJECT = { kind: 'table', id: evolving, schemaName: 'main', name: 'evolved' } as const;

let evolved: SchemaHistoryData;
let dropped: SchemaHistoryData;
let reader: CatalogReader;

beforeAll(async () => {
  evolved = await historySchema(evolving);
  dropped = await historySchema(oldStuff);
  reader = createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
});
afterAll(() => reader.close());

describe('which actions the data of the Schema History offers', () => {
  it('shows the catalog at any snapshot of the matrix, and at no other', () => {
    expect(planSchemaHistoryAction(evolved, { action: 'showCatalog', snapshot: 30 })).toEqual({
      action: 'showCatalog',
      snapshot: 30,
    });
    expect(planSchemaHistoryAction(evolved, { action: 'showCatalog', snapshot: 27 })).toBeUndefined();
    expect(planSchemaHistoryAction(evolved, { action: 'showCatalog' })).toBeUndefined();
    expect(planSchemaHistoryAction(dropped, { action: 'showCatalog', snapshot: 45 })).toEqual({
      action: 'showCatalog',
      snapshot: 45,
    });
  });

  it('compares the schema with the version before, older snapshot first, and with the newest snapshot', () => {
    expect(
      planSchemaHistoryAction(evolved, { action: 'compareSchema', snapshot: 30, against: 'previous' }),
    ).toEqual({
      action: 'compareSchema',
      subject: SUBJECT,
      from: 29,
      to: 30,
    });
    expect(
      planSchemaHistoryAction(evolved, { action: 'compareSchema', snapshot: 30, against: 'latest' }),
    ).toEqual({
      action: 'compareSchema',
      subject: SUBJECT,
      from: 30,
      to: 56,
    });
    expect(
      planSchemaHistoryAction(evolved, { action: 'compareSchema', snapshot: 35, against: 'latest' }),
    ).toMatchObject({
      from: 35,
      to: 56,
    });
  });

  it('offers no comparison where there is nothing to compare with', () => {
    const compare = (data: SchemaHistoryData, request: Omit<SchemaHistoryActionRequest, 'action'>) =>
      planSchemaHistoryAction(data, { action: 'compareSchema', ...request });
    // The creation has no version before it.
    expect(compare(evolved, { snapshot: 26, against: 'previous' })).toBeUndefined();
    // A drop leaves no schema to compare, and a dropped table has no newest schema.
    expect(compare(dropped, { snapshot: 45, against: 'previous' })).toBeUndefined();
    expect(compare(dropped, { snapshot: 43, against: 'latest' })).toBeUndefined();
    // A snapshot that is not in the matrix, a missing or unknown partner.
    expect(compare(evolved, { snapshot: 27, against: 'previous' })).toBeUndefined();
    expect(compare(evolved, { snapshot: 30 })).toBeUndefined();
    expect(compare(evolved, { against: 'previous' })).toBeUndefined();
  });

  it('queries the table at a snapshot at which it exists', () => {
    expect(planSchemaHistoryAction(evolved, { action: 'query', snapshot: 29 })).toEqual({
      action: 'query',
      subject: SUBJECT,
      snapshot: 29,
    });
    expect(planSchemaHistoryAction(dropped, { action: 'query', snapshot: 43 })).toMatchObject({
      action: 'query',
    });
    expect(planSchemaHistoryAction(dropped, { action: 'query', snapshot: 45 })).toBeUndefined();
    expect(planSchemaHistoryAction(evolved, { action: 'query', snapshot: 27 })).toBeUndefined();
  });

  it('scripts the ALTER only for a table that exists now', () => {
    expect(planSchemaHistoryAction(evolved, { action: 'scriptAlter' })).toEqual({
      action: 'scriptAlter',
      subject: SUBJECT,
    });
    expect(planSchemaHistoryAction(dropped, { action: 'scriptAlter' })).toBeUndefined();
  });

  it('offers nothing that needs a name when the catalog has no row for the schema of the table', () => {
    const nameless: SchemaHistoryData = { ...evolved, schema: null };
    expect(planSchemaHistoryAction(nameless, { action: 'query', snapshot: 29 })).toBeUndefined();
    expect(
      planSchemaHistoryAction(nameless, { action: 'compareSchema', snapshot: 30, against: 'previous' }),
    ).toBeUndefined();
    expect(planSchemaHistoryAction(nameless, { action: 'scriptAlter' })).toBeUndefined();
    expect(planSchemaHistoryAction(nameless, { action: 'showCatalog', snapshot: 29 })).toBeDefined();
  });
});

interface Calls {
  readonly catalog: (number | 'latest')[];
  readonly schemas: SchemaComparison[];
  readonly sql: string[];
  readonly infos: string[];
  readonly picks: string[][];
}

/** What the port was asked to do; the reader behind it is the real one on the history fixture. */
function port(options: { open?: boolean; answers?: string[] } = {}): { port: ReportPort; calls: Calls } {
  const calls: Calls = { catalog: [], schemas: [], sql: [], infos: [], picks: [] };
  const answers = [...(options.answers ?? [])];
  const unused = () => Promise.reject(new Error('the Schema History never asks for this'));
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
      showsLatest: () => false,
      showChanges: unused,
      showSchema: (comparison) => Promise.resolve(void calls.schemas.push(comparison)),
      showReport: unused,
      showRows: unused,
      openSql: (text) => Promise.resolve(void calls.sql.push(text)),
      createNotebook: unused,
    },
  };
}

const planned = (data: SchemaHistoryData, request: SchemaHistoryActionRequest): SchemaHistoryPlan => {
  const plan = planSchemaHistoryAction(data, request);
  if (!plan) throw new Error('the data does not offer that action');
  return plan;
};

describe('the actions of the Schema History', () => {
  it('shows the catalog at the snapshot', async () => {
    const shown = port();
    await performSchemaHistoryAction(planned(evolved, { action: 'showCatalog', snapshot: 30 }), shown.port);
    expect(shown.calls.catalog).toEqual([30]);
  });

  it('opens the comparison of the two schemas in the diff editor with the summary of the column changes', async () => {
    const shown = port();
    await performSchemaHistoryAction(
      planned(evolved, { action: 'compareSchema', snapshot: 30, against: 'previous' }),
      shown.port,
    );
    expect(shown.calls.schemas).toHaveLength(1);
    expect(shown.calls.schemas[0]?.summary).toBe('1 column type changed between @29 and @30');
    expect(shown.calls.schemas[0]?.title).toBe('main.evolving: @29 ↔ @30');

    const rename = port();
    await performSchemaHistoryAction(
      planned(evolved, { action: 'compareSchema', snapshot: 35, against: 'previous' }),
      rename.port,
    );
    expect(rename.calls.schemas[0]?.summary).toBe('table renamed between @34 and @35');
    expect(rename.calls.schemas[0]?.title).toBe('main.evolved: @34 ↔ @35');
  });

  it('asks what to open for a query, and names the table as it was called at the snapshot', async () => {
    const shown = port({ answers: ['Open as SQL'] });
    await performSchemaHistoryAction(planned(evolved, { action: 'query', snapshot: 29 }), shown.port);
    expect(shown.calls.picks).toEqual([['Top 1000 Rows', 'Create Notebook', 'Open as SQL']]);
    expect(shown.calls.sql).toHaveLength(1);
    expect(shown.calls.sql[0]).toContain('FROM "main"."evolving" AT (VERSION => 29)');

    const cancelled = port();
    await performSchemaHistoryAction(planned(evolved, { action: 'query', snapshot: 29 }), cancelled.port);
    expect(cancelled.calls.sql).toEqual([]);
  });

  it('opens the ALTER template of the newest state in a SQL editor, with every statement commented out', async () => {
    const shown = port();
    await performSchemaHistoryAction(planned(evolved, { action: 'scriptAlter' }), shown.port);

    const [script] = shown.calls.sql;
    expect(script).toContain('-- ALTER TABLE "main"."evolved" RENAME TO <new_name>;');
    expect(script).toContain('-- Column 2 of 5');
    expect(script).toContain('-- ALTER TABLE "main"."evolved" RENAME COLUMN "title" TO <new_name>;');
    expect(script).toContain('-- ALTER TABLE "main"."evolved" ADD COLUMN "info".<new_field> <type>;');
    expect(script).not.toContain('"extra"');
    expect(script?.split('\n').filter((line) => line !== '' && !line.startsWith('--'))).toEqual([]);
  });

  it('tells the user to connect again when the connection is closed, for every action', async () => {
    for (const request of [
      { action: 'showCatalog', snapshot: 30 },
      { action: 'compareSchema', snapshot: 30, against: 'previous' },
      { action: 'query', snapshot: 30 },
      { action: 'scriptAlter' },
    ] as const) {
      const closed = port({ open: false });
      await expect(performSchemaHistoryAction(planned(evolved, request), closed.port)).rejects.toMatchObject({
        code: 'CONNECTION_FAILED',
      });
    }
  });
});
