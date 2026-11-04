import { beforeAll, describe, expect, it } from 'vitest';
import { CELL_KINDS } from '../../src/schema-history/model';
import type { SchemaHistoryData } from '../../src/schema-history/model';
import { schemaHistoryKind } from '../../src/schema-history/kind';
import { isSchemaHistoryMessage, isSchemaHistoryView } from '../../src/schema-history/protocol';
import { shellAccepts } from './panel-support';
import { historySchema } from './schema-history-support';

/** The requests that the report shell does something with, for the kind of this report. */
const accepts = shellAccepts(schemaHistoryKind, await historySchema());

const ACTION_IDS = ['showCatalog', 'compareSchema', 'query', 'scriptAlter'] as const;
type ActionId = (typeof ACTION_IDS)[number];

/** A request of every action with exactly the fields that it needs. */
const REQUESTS: Record<ActionId, Record<string, unknown>> = {
  showCatalog: { type: 'action', action: 'showCatalog', snapshot: 30 },
  compareSchema: { type: 'action', action: 'compareSchema', snapshot: 30, against: 'previous' },
  query: { type: 'action', action: 'query', snapshot: 30 },
  scriptAlter: { type: 'action', action: 'scriptAlter' },
};

describe('what the extension accepts from the Schema History page', () => {
  it('accepts ready and refresh, Open as Markdown with and without a view, and every action with exactly its fields', () => {
    expect(Object.keys(REQUESTS).toSorted()).toEqual([...ACTION_IDS].toSorted());
    for (const request of [
      { type: 'ready' },
      { type: 'refresh' },
      { type: 'markdown' },
      { type: 'markdown', view: { kinds: ['added', 'moved'], text: 'n', range: { from: 26, to: 35 } } },
      { type: 'markdown', view: { kinds: [], text: '' } },
      ...Object.values(REQUESTS),
      { ...REQUESTS.compareSchema, against: 'latest' },
    ]) {
      expect(accepts(request), JSON.stringify(request)).toBe(true);
    }
  });

  it('rejects an action without a field, with a field of the wrong kind, or with a field nobody uses', () => {
    for (const [action, request] of Object.entries(REQUESTS)) {
      for (const field of Object.keys(request).filter((key) => key !== 'type' && key !== 'action')) {
        const { [field]: _removed, ...rest } = request;
        expect(accepts(rest), `${action} without ${field}`).toBe(false);
        for (const value of [
          -1,
          1.5,
          Number.NaN,
          Infinity,
          '3',
          null,
          undefined,
          {},
          [3],
          true,
          'run',
          'other',
        ]) {
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
        { connection: 'other' },
        { other: 5 },
        { table: 3 },
        { column: 6 },
      ]) {
        if (Object.keys(extra).every((key) => !(key in request))) {
          expect(accepts({ ...request, ...extra }), `${action} + ${JSON.stringify(extra)}`).toBe(false);
        }
      }
    }
  });

  it('does not take fields from the prototype of the request', () => {
    const inherited: Record<string, unknown> = Object.assign(Object.create({ snapshot: 5 }) as object, {
      type: 'action',
      action: 'showCatalog',
    });
    expect(inherited.snapshot).toBe(5);
    expect(accepts(inherited)).toBe(false);
    expect(
      accepts(Object.assign(Object.create({ action: 'scriptAlter' }) as object, { type: 'action' })),
    ).toBe(false);
  });

  it('rejects actions no page may ask for, and everything that is no request', () => {
    for (const action of [
      'quit',
      'workbench.action.quit',
      'aantje.removeConnection',
      '',
      'showcatalog',
      'ShowCatalog',
      'showLatest',
      'rowsChanged',
      '__proto__',
      'constructor',
      'toString',
    ]) {
      expect(accepts({ type: 'action', action, snapshot: 1, against: 'previous' }), action).toBe(false);
    }
    for (const value of [
      null,
      undefined,
      'ready',
      7,
      [],
      [{ type: 'ready' }],
      {},
      { type: 'READY' },
      { type: 'ready', extra: true },
      { type: 'refresh', snapshot: 3 },
      { type: 'markdown', markdown: '# text' },
      { type: 'markdown', view: { kinds: ['exploded'], text: '' } },
      { type: 'markdown', view: { kinds: CELL_KINDS, text: 7 } },
      { type: 'markdown', view: { kinds: CELL_KINDS, text: '', range: { from: 1 } } },
      { type: 'markdown', view: { kinds: CELL_KINDS, text: '', range: { from: -1, to: 2 } } },
      { type: 'markdown', view: { kinds: CELL_KINDS } },
      Object.create({ type: 'ready' }),
      { type: 'schemaHistory', data: {} },
      { type: 'action' },
      { action: 'scriptAlter' },
    ]) {
      expect(accepts(value), JSON.stringify(value)).toBe(false);
    }
    expect(isSchemaHistoryView({ kinds: CELL_KINDS, text: 'x' })).toBe(true);
    expect(isSchemaHistoryView({ kinds: ['added', 'nonsense'], text: 'x' })).toBe(false);
  });
});

describe('what the Schema History page accepts from the extension', () => {
  let message: { type: 'schemaHistory'; data: SchemaHistoryData };
  beforeAll(async () => {
    message = { type: 'schemaHistory', data: await historySchema() };
  });

  const check = (data: unknown) => isSchemaHistoryMessage({ type: 'schemaHistory', data });
  const without = (object: unknown, field: string) => {
    const { [field]: _removed, ...rest } = object as Record<string, unknown>;
    return rest;
  };

  it('accepts the history of a real table and names, messages and defaults of any text', () => {
    expect(message.data.columns).toHaveLength(9);
    expect(isSchemaHistoryMessage(message)).toBe(true);
    const hostile = '<img src=x onerror=alert(1)>\n"; DROP TABLE';
    const data: SchemaHistoryData = {
      ...message.data,
      connection: hostile,
      schema: hostile,
      name: hostile,
      snapshots: [
        {
          id: 1,
          time: null,
          author: hostile,
          message: hostile,
          events: [{ kind: 'renamed', name: hostile, from: hostile }],
          previous: null,
          exists: true,
        },
      ],
      columns: [
        {
          id: 1,
          parent: null,
          path: [hostile],
          formerNames: [hostile],
          now: hostile,
          cells: [{ snapshot: 1, kind: 'defaultChanged', text: hostile }],
        },
      ],
    };
    expect(check(data)).toBe(true);
  });

  it('rejects a history, a snapshot or a column with a missing or a malformed field', () => {
    for (const field of [
      'connection',
      'tableId',
      'schema',
      'name',
      'latest',
      'exists',
      'more',
      'snapshots',
      'columns',
    ]) {
      expect(check(without(message.data, field)), `history without ${field}`).toBe(false);
    }
    for (const [field, value] of [
      ['connection', 7],
      ['tableId', -1],
      ['tableId', '12'],
      ['schema', 7],
      ['name', null],
      ['latest', 1.5],
      ['exists', 'yes'],
      ['more', 0],
      ['snapshots', {}],
      ['snapshots', [null]],
      ['columns', 'id'],
      ['columns', [null]],
    ] as const) {
      expect(check({ ...message.data, [field]: value }), `history ${field} = ${JSON.stringify(value)}`).toBe(
        false,
      );
    }

    const snapshot = message.data.snapshots[0] as unknown as Record<string, unknown>;
    const withSnapshot = (changed: unknown) => check({ ...message.data, snapshots: [changed] });
    for (const field of ['id', 'time', 'author', 'message', 'events', 'previous', 'exists']) {
      expect(withSnapshot(without(snapshot, field)), `snapshot without ${field}`).toBe(false);
    }
    for (const [field, value] of [
      ['id', -1],
      ['time', 7],
      ['author', 7],
      ['previous', -3],
      ['exists', 1],
      ['events', [{ kind: 'exploded', name: 'x', from: null }]],
      ['events', [{ kind: 'created', name: 7, from: null }]],
      ['events', [{ kind: 'created', name: 'x' }]],
    ] as const) {
      expect(
        withSnapshot({ ...snapshot, [field]: value }),
        `snapshot ${field} = ${JSON.stringify(value)}`,
      ).toBe(false);
    }

    const column = message.data.columns[0] as unknown as Record<string, unknown>;
    const withColumn = (changed: unknown) => check({ ...message.data, columns: [changed] });
    for (const field of ['id', 'parent', 'path', 'formerNames', 'now', 'cells']) {
      expect(withColumn(without(column, field)), `column without ${field}`).toBe(false);
    }
    for (const [field, value] of [
      ['id', 1.5],
      ['parent', '3'],
      ['path', 'id'],
      ['path', [1]],
      ['formerNames', [null]],
      ['now', 7],
      ['cells', [{ snapshot: 26, kind: 'added' }]],
      ['cells', [{ snapshot: -1, kind: 'added', text: 'x' }]],
      ['cells', [{ snapshot: 26, kind: 'exploded', text: 'x' }]],
      ['cells', [{ snapshot: 26, kind: 'added', text: 7 }]],
    ] as const) {
      expect(withColumn({ ...column, [field]: value }), `column ${field} = ${JSON.stringify(value)}`).toBe(
        false,
      );
    }
  });

  it('rejects what is no schema history message', () => {
    for (const value of [
      null,
      undefined,
      'schemaHistory',
      { type: 'schemaHistory' },
      { type: 'snapshotReport', data: {} },
    ]) {
      expect(isSchemaHistoryMessage(value), JSON.stringify(value)).toBe(false);
    }
  });
});
