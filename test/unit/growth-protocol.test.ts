import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { growthKind } from '../../src/growth/kind';
import { isGrowthMessage, isGrowthView } from '../../src/growth/protocol';
import type { GrowthData } from '../../src/growth/model';
import { editedCatalogs } from '../support/edited-catalog';
import { historyGrowth } from './growth-support';
import { shellAccepts } from './panel-support';

const ACTION_IDS = ['showCatalog', 'query'] as const;
type ActionId = (typeof ACTION_IDS)[number];

/** A request of every action with exactly the fields that it needs. */
const REQUESTS: Record<ActionId, Record<string, unknown>> = {
  showCatalog: { type: 'action', action: 'showCatalog', snapshot: 23 },
  query: { type: 'action', action: 'query', snapshot: 23, table: 3 },
};

const catalogs = editedCatalogs();
afterAll(() => catalogs.dispose());

let data: GrowthData;
let accepts: (message: unknown) => boolean;
beforeAll(async () => {
  data = await historyGrowth(catalogs);
  /** The requests that the report shell does something with, for the kind of this report. */
  accepts = shellAccepts(growthKind, data);
});

describe('what the extension accepts from the Growth page', () => {
  it('accepts ready and refresh, Open as Markdown with and without a view, and every action with exactly its fields', () => {
    expect(Object.keys(REQUESTS).toSorted()).toEqual([...ACTION_IDS].toSorted());
    for (const request of [
      { type: 'ready' },
      { type: 'refresh' },
      { type: 'markdown' },
      { type: 'markdown', view: { metric: 'rows' } },
      { type: 'markdown', view: { table: 3, metric: 'bytes' } },
      { type: 'markdown', view: { table: 0, metric: 'files' } },
      ...Object.values(REQUESTS),
    ]) {
      expect(accepts(request), JSON.stringify(request)).toBe(true);
    }
  });

  it('rejects an action without a field, with a field of the wrong kind, or with a field nobody uses', () => {
    for (const [action, request] of Object.entries(REQUESTS)) {
      for (const field of Object.keys(request).filter((key) => key !== 'type' && key !== 'action')) {
        const { [field]: _removed, ...rest } = request;
        expect(accepts(rest), `${action} without ${field}`).toBe(false);
        for (const value of [-1, 1.5, Number.NaN, Infinity, '3', null, undefined, {}, [3], true]) {
          expect(
            accepts({ ...request, [field]: value }),
            `${action}: ${field} = ${JSON.stringify(value) ?? 'undefined'}`,
          ).toBe(false);
        }
      }
      for (const extra of [
        { command: 'workbench.action.quit' },
        { commandId: 'aantje.removeConnection' },
        { text: 'DROP TABLE x' },
        { against: 'previous' },
        { table: 3 },
      ]) {
        if (Object.keys(extra).every((key) => !(key in request))) {
          expect(accepts({ ...request, ...extra }), `${action} + ${JSON.stringify(extra)}`).toBe(false);
        }
      }
    }
  });

  it('does not take fields from the prototype, and ignores actions and messages no page may send', () => {
    const inherited: Record<string, unknown> = Object.assign(Object.create({ snapshot: 5 }) as object, {
      type: 'action',
      action: 'showCatalog',
    });
    expect(inherited.snapshot).toBe(5);
    expect(accepts(inherited)).toBe(false);
    for (const action of [
      'quit',
      'workbench.action.quit',
      'aantje.removeConnection',
      '',
      'showcatalog',
      'showLatest',
      'rowsChanged',
      'compareSnapshots',
      '__proto__',
      'constructor',
    ]) {
      expect(accepts({ type: 'action', action, snapshot: 1, table: 2 }), action).toBe(false);
    }
    for (const message of [
      null,
      undefined,
      'ready',
      7,
      [],
      {},
      { type: 'READY' },
      { type: 'ready', extra: true },
      { type: 'refresh', snapshot: 3 },
      { type: 'markdown', markdown: '# text' },
      { type: 'markdown', view: 'rows' },
      { type: 'markdown', view: { metric: 'speed' } },
      { type: 'markdown', view: {} },
      { type: 'markdown', view: { table: '3', metric: 'rows' } },
      { type: 'markdown', view: { table: -1, metric: 'rows' } },
      { type: 'markdown', view: { metric: 'rows', text: 'x' } },
      { type: 'command', command: 'aantje.removeConnection' },
    ]) {
      expect(accepts(message), JSON.stringify(message)).toBe(false);
    }
  });
});

describe('what the Growth page accepts from the extension', () => {
  const message = (): { type: string; data: Record<string, unknown> } =>
    JSON.parse(JSON.stringify({ type: 'growth', data })) as { type: string; data: Record<string, unknown> };

  it('takes the data that the real reader read, also as JSON, with a focus table and changes that fall', () => {
    expect(isGrowthMessage({ type: 'growth', data })).toBe(true);
    expect(isGrowthMessage(message())).toBe(true);
    expect(growthKind.message(data)).toEqual({ type: 'growth', data });
    expect(isGrowthMessage({ type: 'growth', data: { ...data, focus: 9 } })).toBe(true);
    const changes = [
      { tableId: 1, snapshot: null, rows: 5, sizeBytes: 50, files: 1, partialFiles: 0 },
      { tableId: 1, snapshot: 4, rows: -3, sizeBytes: -30, files: -1, partialFiles: -1 },
    ];
    expect(isGrowthMessage({ type: 'growth', data: { ...data, changes } })).toBe(true);
  });

  it('rejects malformed data and what is no growth message', () => {
    for (const [field, value] of [
      ['connection', 3],
      ['focus', '9'],
      ['focus', undefined],
      ['latest', -1],
      ['latest', 1.5],
      ['more', 'no'],
      ['snapshots', [{}]],
      ['snapshots', 'all'],
      ['tables', [{ id: 1, schema: 'a' }]],
      ['tables', [{ id: '1', schema: 'a', name: 'b' }]],
      ['changes', [{ tableId: 1, snapshot: 1, rows: 1.5, sizeBytes: 0, files: 0, partialFiles: 0 }]],
      ['changes', [{ tableId: 1, snapshot: -3, rows: 1, sizeBytes: 0, files: 0, partialFiles: 0 }]],
      ['changes', [{ tableId: 1, snapshot: 1, rows: 1, sizeBytes: 0, files: 0 }]],
      ['changes', [{ tableId: 1, snapshot: 1, rows: Number.NaN, sizeBytes: 0, files: 0, partialFiles: 0 }]],
      ['inlinedMore', 1],
      ['inlinedFailed', 1],
    ] as const) {
      expect(
        isGrowthMessage({ type: 'growth', data: { ...data, [field]: value } }),
        `${field} = ${JSON.stringify(value)}`,
      ).toBe(false);
    }
    for (const value of [
      null,
      undefined,
      'growth',
      [],
      {},
      { type: 'growth' },
      { type: 'activity', data: {} },
    ]) {
      expect(isGrowthMessage(value), JSON.stringify(value)).toBe(false);
    }
    const inherited = Object.create({ data }) as Record<string, unknown>;
    inherited.type = 'growth';
    expect(isGrowthMessage(inherited)).toBe(false);
  });

  it('takes a view of Open as Markdown that names a table and a value and nothing else', () => {
    expect(isGrowthView({ metric: 'rows' })).toBe(true);
    expect(isGrowthView({ table: 4, metric: 'files' })).toBe(true);
    expect(isGrowthView({ table: 4, metric: 'files', range: { from: 0, to: 1 } })).toBe(false);
    expect(isGrowthView({ table: 4 })).toBe(false);
    expect(isGrowthView(undefined)).toBe(false);
  });
});
