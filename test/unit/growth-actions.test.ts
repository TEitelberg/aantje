import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planGrowthAction } from '../../src/growth/actions';
import type { GrowthActionRequest } from '../../src/growth/actions';
import type { GrowthData } from '../../src/growth/model';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID } from '../support/expected-history';
import { historyGrowth } from './growth-support';

const catalogs = editedCatalogs();
afterAll(() => catalogs.dispose());

let data: GrowthData;
beforeAll(async () => {
  data = await historyGrowth(catalogs);
});

describe('the actions that the Growth data offers', () => {
  it('shows the catalog at a snapshot that was read', () => {
    expect(planGrowthAction(data, { action: 'showCatalog', snapshot: 23 })).toEqual({
      action: 'showCatalog',
      snapshot: 23,
    });
    expect(planGrowthAction(data, { action: 'showCatalog', snapshot: 0 })).toEqual({
      action: 'showCatalog',
      snapshot: 0,
    });
  });

  it('queries a table at a snapshot with the names the report sent, also a dropped table', () => {
    expect(planGrowthAction(data, { action: 'query', snapshot: 23, table: HISTORY_ID.events })).toEqual({
      action: 'query',
      snapshot: 23,
      subject: { kind: 'table', id: HISTORY_ID.events, schemaName: 'shop', name: 'events' },
    });
    expect(planGrowthAction(data, { action: 'query', snapshot: 44, table: HISTORY_ID.oldStuff })).toEqual({
      action: 'query',
      snapshot: 44,
      subject: { kind: 'table', id: HISTORY_ID.oldStuff, schemaName: 'shop', name: 'old_stuff' },
    });
  });

  it.each<[string, GrowthActionRequest]>([
    ['a snapshot that was not read', { action: 'showCatalog', snapshot: 999 }],
    ['no snapshot', { action: 'showCatalog' }],
    ['a catalog and a table', { action: 'showCatalog', snapshot: 23, table: 3 }],
    ['a query without a table', { action: 'query', snapshot: 23 }],
    ['a query of a table that the data does not have', { action: 'query', snapshot: 23, table: 999 }],
    ['a query of a view', { action: 'query', snapshot: 23, table: HISTORY_ID.bigEventsView }],
    ['a query at a snapshot that was not read', { action: 'query', snapshot: 999, table: 3 }],
  ])('refuses %s', (_name, request) => {
    expect(planGrowthAction(data, request)).toBeUndefined();
  });

  it('knows only the snapshots of the newest ones when older ones were not read', async () => {
    const newest = await historyGrowth(catalogs, { limit: 5 });
    expect(planGrowthAction(newest, { action: 'showCatalog', snapshot: 51 })).toBeUndefined();
    expect(planGrowthAction(newest, { action: 'showCatalog', snapshot: 52 })).toEqual({
      action: 'showCatalog',
      snapshot: 52,
    });
  });
});
