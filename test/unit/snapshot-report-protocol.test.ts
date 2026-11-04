import { beforeAll, describe, expect, it } from 'vitest';
import type { ChangeObject } from '../../src/catalog/changes';
import type { ResolvedAction } from '../../src/catalog/model';
import type { SnapshotReportData } from '../../src/snapshot-report/model';
import { isShellRequest } from '../../src/shell/protocol';
import {
  isSnapshotReportAction,
  isSnapshotReportMessage,
  isSnapshotReportView,
} from '../../src/snapshot-report/protocol';
import { historyReport, snapshot, tableChange } from './snapshot-report-support';

/** What the shell lets through from the page: `ready`, `refresh`, Open as Markdown with a view of the right shape, or a known action with exactly its fields. */
const isSnapshotReportRequest = (value: unknown): boolean =>
  isShellRequest(value, isSnapshotReportView) || isSnapshotReportAction(value);

const ACTION_IDS = [
  'showCatalog',
  'showLatest',
  'rowsChanged',
  'compareSchema',
  'compareSnapshots',
  'query',
] as const;
type ActionId = (typeof ACTION_IDS)[number];

/** A request of every action with exactly the fields that it needs. */
const REQUESTS: Record<ActionId, Record<string, unknown>> = {
  showCatalog: { type: 'action', action: 'showCatalog', snapshot: 23 },
  showLatest: { type: 'action', action: 'showLatest' },
  rowsChanged: { type: 'action', action: 'rowsChanged', snapshot: 23, table: 3 },
  compareSchema: { type: 'action', action: 'compareSchema', snapshot: 23, table: 3, against: 'previous' },
  compareSnapshots: { type: 'action', action: 'compareSnapshots', snapshot: 23, against: 'latest' },
  query: { type: 'action', action: 'query', snapshot: 23, table: 3 },
};

describe('what the extension accepts from the report page', () => {
  it('accepts ready and refresh, and every action with exactly its fields', () => {
    expect(Object.keys(REQUESTS).toSorted()).toEqual([...ACTION_IDS].toSorted());
    expect(isSnapshotReportRequest({ type: 'ready' })).toBe(true);
    expect(isSnapshotReportRequest({ type: 'refresh' })).toBe(true);
    for (const request of Object.values(REQUESTS)) {
      expect(isSnapshotReportRequest(request), JSON.stringify(request)).toBe(true);
    }
    expect(
      isSnapshotReportRequest({
        type: 'action',
        action: 'compareSchema',
        snapshot: 1,
        table: 2,
        against: 'other',
        other: 5,
      }),
    ).toBe(true);
    expect(
      isSnapshotReportRequest({
        type: 'action',
        action: 'compareSnapshots',
        snapshot: 1,
        against: 'other',
        other: 0,
      }),
    ).toBe(true);
  });

  it('rejects an action without a field, with a field of the wrong kind, or with a field nobody uses', () => {
    for (const [action, request] of Object.entries(REQUESTS)) {
      for (const field of Object.keys(request).filter((key) => key !== 'type' && key !== 'action')) {
        const { [field]: _removed, ...rest } = request;
        expect(isSnapshotReportRequest(rest), `${action} without ${field}`).toBe(false);
        for (const value of [-1, 1.5, Number.NaN, Infinity, '3', null, undefined, {}, [3], true, 'run']) {
          expect(
            isSnapshotReportRequest({ ...request, [field]: value }),
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
      ]) {
        if (Object.keys(extra).every((key) => !(key in request))) {
          expect(
            isSnapshotReportRequest({ ...request, ...extra }),
            `${action} + ${JSON.stringify(extra)}`,
          ).toBe(false);
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
    expect(isSnapshotReportRequest(inherited)).toBe(false);
    const withInheritedAction = Object.assign(Object.create({ action: 'showLatest' }) as object, {
      type: 'action',
    });
    expect(isSnapshotReportRequest(withInheritedAction)).toBe(false);
  });

  it('rejects the second snapshot unless the comparison goes to it, and a comparison to it without it', () => {
    const base = { type: 'action', action: 'compareSnapshots', snapshot: 1 };
    expect(isSnapshotReportRequest({ ...base, against: 'previous', other: 5 })).toBe(false);
    expect(isSnapshotReportRequest({ ...base, against: 'latest', other: 5 })).toBe(false);
    expect(isSnapshotReportRequest({ ...base, against: 'other' })).toBe(false);
    expect(isSnapshotReportRequest({ ...base, against: 'other', other: -1 })).toBe(false);
  });

  it('rejects actions no page may ask for, and everything that is no request', () => {
    for (const action of [
      'quit',
      'workbench.action.quit',
      'aantje.removeConnection',
      '',
      'showcatalog',
      'ShowCatalog',
      '__proto__',
      'constructor',
      'toString',
    ]) {
      expect(isSnapshotReportRequest({ type: 'action', action, snapshot: 1, table: 2 }), action).toBe(false);
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
      { type: 'REFRESH' },
      Object.create({ type: 'ready' }),
      Object.create({ type: 'refresh' }),
      { type: 'statistics' },
      { type: 'action' },
      { action: 'showLatest' },
      { type: 'snapshotReport', data: {} },
    ]) {
      expect(isSnapshotReportRequest(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('what the report page accepts from the extension', () => {
  let message: { type: 'snapshotReport'; data: SnapshotReportData };
  beforeAll(async () => {
    message = { type: 'snapshotReport', data: await historyReport() };
  });

  const check = (data: unknown) => isSnapshotReportMessage({ type: 'snapshotReport', data });
  const without = (object: unknown, field: string) => {
    const { [field]: _removed, ...rest } = object as Record<string, unknown>;
    return rest;
  };

  it('accepts the report of a real catalog, and names and messages of any text', () => {
    expect(message.data.snapshots).toHaveLength(57);
    expect(isSnapshotReportMessage(message)).toBe(true);
    const hostile = '<img src=x onerror=alert(1)>\n"; DROP TABLE';
    expect(
      check({
        ...message.data,
        connection: hostile,
        snapshots: [
          snapshot(1, [tableChange(3, 'inserted', hostile, hostile)], {
            author: hostile,
            commitMessage: hostile,
          }),
        ],
      }),
    ).toBe(true);
  });

  it('rejects a report, a snapshot or a change with a missing or a malformed field', () => {
    for (const field of ['connection', 'latest', 'snapshots', 'more']) {
      expect(check(without(message.data, field)), `report without ${field}`).toBe(false);
    }
    for (const [field, value] of [
      ['connection', 7],
      ['latest', -1],
      ['latest', '56'],
      ['snapshots', {}],
      ['snapshots', [null]],
      ['more', 'yes'],
    ] as const) {
      expect(check({ ...message.data, [field]: value }), `report ${field} = ${JSON.stringify(value)}`).toBe(
        false,
      );
    }

    const first = message.data.snapshots[0] as unknown as Record<string, unknown>;
    for (const field of ['id', 'time', 'author', 'commitMessage', 'changes']) {
      expect(
        check({ ...message.data, snapshots: [without(first, field)] }),
        `snapshot without ${field}`,
      ).toBe(false);
    }

    const change = message.data.snapshots[0]?.changes[0] as unknown as Record<string, unknown>;
    const withChange = (changed: unknown) =>
      check({ ...message.data, snapshots: [{ ...first, changes: [changed] }] });
    for (const field of ['action', 'object', 'objectId', 'schemaName', 'name', 'raw']) {
      expect(withChange(without(change, field)), `change without ${field}`).toBe(false);
    }
    for (const [field, value] of [
      ['action', 'explode'],
      ['action', 7],
      ['object', 'database'],
      ['object', 3],
      ['objectId', -1],
      ['objectId', '3'],
      ['schemaName', 7],
      ['name', {}],
      ['raw', null],
    ] as const) {
      expect(withChange({ ...change, [field]: value }), `change ${field} = ${JSON.stringify(value)}`).toBe(
        false,
      );
    }
  });

  it('accepts every kind of change and object that a reader can name', () => {
    const actions: Record<ResolvedAction, true> = {
      created: true,
      dropped: true,
      altered: true,
      renamed: true,
      inserted: true,
      deleted: true,
      inlined_insert: true,
      inlined_delete: true,
      flushed_inlined: true,
      compacted: true,
      merged: true,
      rewritten: true,
      expired: true,
      unknown: true,
    };
    const objects: Record<ChangeObject, true> = {
      schema: true,
      table: true,
      view: true,
      scalar_macro: true,
      table_macro: true,
      snapshot_tag: true,
      snapshot: true,
    };
    for (const action of Object.keys(actions)) {
      for (const object of [null, ...Object.keys(objects)]) {
        const change = { action, object, objectId: null, schemaName: null, name: null, raw: 'x' };
        const snapshots = [{ id: 1, time: 't', author: null, commitMessage: null, changes: [change] }];
        expect(check({ ...message.data, snapshots }), `${action} ${object}`).toBe(true);
      }
    }
  });

  it('rejects what is no report message, and takes nothing from the prototype', () => {
    expect(isSnapshotReportMessage({ type: 'statistics', data: message.data })).toBe(false);
    expect(isSnapshotReportMessage({ data: message.data })).toBe(false);
    expect(isSnapshotReportMessage(Object.create(message))).toBe(false);
    expect(check(Object.create(message.data) as object)).toBe(false);
    for (const value of [
      null,
      undefined,
      'snapshotReport',
      [],
      {},
      { type: 'statistics', data: {} },
      { type: 'ready' },
    ]) {
      expect(isSnapshotReportMessage(value), JSON.stringify(value)).toBe(false);
    }
  });
});
