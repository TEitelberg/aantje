import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACTION_IDS } from '../../src/activity/actions';
import type { ActivityData } from '../../src/activity/model';
import { activityKind } from '../../src/activity/kind';
import { isActivityMessage, isActivityView } from '../../src/activity/protocol';
import { POINT_KINDS } from '../../src/snapshot-report/model';
import { editedCatalogs } from '../support/edited-catalog';
import { historyActivity } from './activity-support';
import { shellAccepts } from './panel-support';
import { snapshot, tableChange } from './snapshot-report-support';

type ActionId = (typeof ACTION_IDS)[number];

/** A request of every action with exactly the fields that it needs. */
const REQUESTS: Record<ActionId, Record<string, unknown>> = {
  showSnapshotReport: { type: 'action', action: 'showSnapshotReport' },
  showCatalog: { type: 'action', action: 'showCatalog', snapshot: 23 },
  rowsChanged: { type: 'action', action: 'rowsChanged', snapshot: 23, table: 3 },
  compareSnapshots: { type: 'action', action: 'compareSnapshots', snapshot: 23, against: 'previous' },
};

const catalogs = editedCatalogs();
afterAll(() => catalogs.dispose());

/** The requests that the report shell does something with, for the kind of this report. */
const accepts = shellAccepts(activityKind, await historyActivity(catalogs));

describe('what the extension accepts from the Activity page', () => {
  it('accepts ready and refresh, Open as Markdown with and without a view, and every action with exactly its fields', () => {
    expect(Object.keys(REQUESTS).toSorted()).toEqual([...ACTION_IDS].toSorted());
    for (const request of [
      { type: 'ready' },
      { type: 'refresh' },
      { type: 'markdown' },
      {
        type: 'markdown',
        view: { author: 'ann', table: 't3', kinds: ['insert'], text: 'x', range: { from: 0, to: 56 } },
      },
      { type: 'markdown', view: { kinds: [], text: '', range: { from: 0, to: 0 } } },
      ...Object.values(REQUESTS),
      { ...REQUESTS.compareSnapshots, against: 'latest' },
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
        { other: 5 },
        { table: 3 },
        { author: 'ann' },
      ]) {
        if (Object.keys(extra).every((key) => !(key in request))) {
          expect(accepts({ ...request, ...extra }), `${action} + ${JSON.stringify(extra)}`).toBe(false);
        }
      }
    }
  });

  it('does not take fields from the prototype, and rejects actions and messages no page may send', () => {
    const inherited: Record<string, unknown> = Object.assign(Object.create({ snapshot: 5 }) as object, {
      type: 'action',
      action: 'showCatalog',
    });
    expect(inherited.snapshot).toBe(5);
    expect(accepts(inherited)).toBe(false);
    expect(
      accepts(Object.assign(Object.create({ action: 'showSnapshotReport' }) as object, { type: 'action' })),
    ).toBe(false);
    for (const action of [
      'quit',
      'workbench.action.quit',
      'aantje.removeConnection',
      '',
      'showcatalog',
      'ShowCatalog',
      'showLatest',
      'query',
      'compareSchema',
      '__proto__',
      'constructor',
    ]) {
      expect(accepts({ type: 'action', action, snapshot: 1, table: 2, against: 'previous' }), action).toBe(
        false,
      );
    }
    for (const value of [
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
      { type: 'markdown', view: { kinds: ['exploded'], text: '', range: { from: 0, to: 1 } } },
      { type: 'markdown', view: { kinds: POINT_KINDS, text: 7, range: { from: 0, to: 1 } } },
      { type: 'markdown', view: { kinds: POINT_KINDS, text: '' } },
      { type: 'markdown', view: { kinds: POINT_KINDS, text: '', range: { from: -1, to: 1 } } },
      { type: 'markdown', view: { kinds: POINT_KINDS, text: '', range: { from: 0, to: 1 }, author: 7 } },
      Object.create({ type: 'ready' }),
      { type: 'activity', data: {} },
      { type: 'action' },
    ]) {
      expect(accepts(value), JSON.stringify(value)).toBe(false);
    }
    const view = { kinds: POINT_KINDS, text: '', range: { from: 0, to: 1 } };
    expect(isActivityView(view)).toBe(true);
    expect(isActivityView({ ...view, kinds: ['insert', 'nonsense'] })).toBe(false);
  });
});

describe('what the Activity page accepts from the extension', () => {
  let message: { type: 'activity'; data: ActivityData };
  beforeAll(async () => {
    message = { type: 'activity', data: await historyActivity(catalogs) };
  });

  it('accepts the activity of a real catalog, and names, authors and messages of any text', () => {
    expect(message.data.snapshots).toHaveLength(57);
    expect(isActivityMessage(message)).toBe(true);
    const hostile = '<img src=x onerror=alert(1)>\n"; DROP TABLE';
    const data: ActivityData = {
      ...message.data,
      connection: hostile,
      snapshots: [
        snapshot(1, [tableChange(3, 'inserted', hostile, hostile)], {
          author: hostile,
          commitMessage: hostile,
        }),
      ],
    };
    expect(isActivityMessage({ type: 'activity', data })).toBe(true);
  });

  it('rejects a malformed activity and what is no activity message', () => {
    for (const field of ['connection', 'latest', 'snapshots', 'more']) {
      const { [field]: _removed, ...rest } = message.data as unknown as Record<string, unknown>;
      expect(isActivityMessage({ type: 'activity', data: rest }), `without ${field}`).toBe(false);
    }
    for (const [field, value] of [
      ['connection', 7],
      ['latest', -1],
      ['latest', '56'],
      ['snapshots', {}],
      ['snapshots', [null]],
      ['snapshots', [{ id: 1 }]],
      ['more', 'yes'],
    ] as const) {
      expect(
        isActivityMessage({ type: 'activity', data: { ...message.data, [field]: value } }),
        `${field} = ${JSON.stringify(value)}`,
      ).toBe(false);
    }
    for (const value of [
      null,
      undefined,
      'activity',
      { type: 'activity' },
      { type: 'snapshotReport', data: {} },
    ]) {
      expect(isActivityMessage(value), JSON.stringify(value)).toBe(false);
    }
  });
});
