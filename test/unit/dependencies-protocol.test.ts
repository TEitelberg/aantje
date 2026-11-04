import { afterAll, describe, expect, it } from 'vitest';
import { planDependenciesAction } from '../../src/dependencies/actions';
import type { DependenciesData } from '../../src/dependencies/model';
import {
  isDependenciesAction,
  isDependenciesMessage,
  isDependenciesView,
} from '../../src/dependencies/protocol';
import { lakeData, objectData, readGraph } from '../../src/dependencies/read';
import { restoreDependenciesChoices, saveChoices } from '../../src/dependencies/state';
import { isShellRequest } from '../../src/shell/protocol';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID } from '../support/expected-history';
import { historyFixture } from '../support/sources/history';
import { SHOP, addView, sharedParser } from './dependencies-support';

const ACTION_IDS = [
  'showInTree',
  'showStatistics',
  'showDependencies',
  'scriptCreate',
  'scriptAlter',
  'scriptDrop',
];

const catalogs = editedCatalogs();
const parser = sharedParser();

const graph = await readGraph(
  await catalogs.open(
    historyFixture.sqlite,
    addView(100, SHOP, 'v_gone', 'SELECT * FROM old_stuff'),
    addView(101, SHOP, 'v_spark', 'SELECT 1', 'spark'),
  ),
  parser,
  56,
);
const objectOfEvents = objectData(graph, 'History', 56, { kind: 'table', id: HISTORY_ID.events });
if (!objectOfEvents) {
  throw new Error('The table is there.');
}
const events: DependenciesData = objectOfEvents;
const lake: DependenciesData = lakeData(graph, 'History', 56);

afterAll(async () => {
  await catalogs.dispose();
  await parser.dispose();
});

const message = (data: unknown) => ({ type: 'dependencies', data });

describe('the page checks the data it is sent', () => {
  it('accepts the data of an object and of the lake as the extension builds it', () => {
    expect(isDependenciesMessage(message(events))).toBe(true);
    expect(isDependenciesMessage(message(lake))).toBe(true);
    expect(events.nodes.length).toBeGreaterThan(1);
    expect(lake.broken.length + lake.unresolved.length).toBe(2);
    for (const kind of ['relation', 'scalarMacro', 'tableMacro']) {
      expect(isDependenciesMessage(message({ ...lake, broken: [{ ...lake.broken[0], kind }] })), kind).toBe(
        true,
      );
    }
  });

  it('rejects broken data, dangling indexes and what is no dependencies message', () => {
    const rows: [string, unknown][] = [
      ['another type', { type: 'storage', data: events }],
      ['no data', { type: 'dependencies' }],
      ['a data field of the wrong type', message({ ...events, snapshot: 'last' })],
      ['a missing field', message({ ...events, edges: undefined })],
      [
        'a kind of object that nobody knows',
        message({ ...events, nodes: [{ ...events.nodes[0], kind: 'index' }] }),
      ],
      [
        'a reason that nobody knows',
        message({ ...lake, unresolved: [{ node: 0, reason: 'magic', detail: '' }] }),
      ],
      [
        'an edge to a node that does not exist',
        message({ ...events, edges: [{ from: 0, to: 99, kind: 'reads' }] }),
      ],
      [
        'a broken reference of a node that does not exist',
        message({ ...lake, broken: [{ ...lake.broken[0], from: 99 }] }),
      ],
      [
        'an unresolved text of a node that does not exist',
        message({ ...lake, unresolved: [{ ...lake.unresolved[0], node: 99 }] }),
      ],
      ['a connection that is no text', message({ ...events, connection: 1 })],
      ['a count of the parsed objects that is no number', message({ ...events, parsed: '3' })],
      ['a count of the objects that is negative', message({ ...events, objects: -1 })],
      ['a count of the isolated objects that is fractional', message({ ...lake, isolated: 1.5 })],
      ['a detail that is no text', message({ ...lake, unresolved: [{ ...lake.unresolved[0], detail: 1 }] })],
      [
        'a broken reference of an unknown kind',
        message({ ...lake, broken: [{ ...lake.broken[0], kind: 'view' }] }),
      ],
      [
        'a broken reference without a name',
        message({ ...lake, broken: [{ ...lake.broken[0], name: undefined }] }),
      ],
      ['a target that is no node', message({ ...events, target: 99 })],
      ['a negative index', message({ ...events, edges: [{ from: -1, to: 0, kind: 'reads' }] })],
      ['a fractional index', message({ ...events, target: 0.5 })],
      ['an edge of an unknown kind', message({ ...events, edges: [{ from: 0, to: 1, kind: 'owns' }] })],
      ['a list', [message(events)]],
      ['a text', 'dependencies'],
    ];
    for (const [name, value] of rows) {
      expect(isDependenciesMessage(value), name).toBe(false);
    }
    // No field is taken from the prototype.
    const inherited: unknown = Object.create({ type: 'dependencies', data: events });
    expect(isDependenciesMessage(inherited)).toBe(false);
  });
});

describe('what the extension accepts from the page', () => {
  it('accepts every action with the index of one object and nothing else, and rejects the rest', () => {
    for (const action of ACTION_IDS) {
      expect(isDependenciesAction({ type: 'action', action, node: 3 }), action).toBe(true);
    }
    const rows: [string, unknown][] = [
      ['an action that nobody knows', { type: 'action', action: 'dropTable', node: 0 }],
      ['a command id', { type: 'action', action: 'aantje.scriptDrop', node: 0 }],
      ['no object', { type: 'action', action: 'scriptDrop' }],
      ['a text for the object', { type: 'action', action: 'scriptDrop', node: '0' }],
      ['a negative object', { type: 'action', action: 'scriptDrop', node: -1 }],
      ['a fractional object', { type: 'action', action: 'scriptDrop', node: 0.5 }],
      ['a field next to the object', { type: 'action', action: 'scriptDrop', node: 0, sql: 'DROP TABLE x' }],
      ['another type', { type: 'command', action: 'scriptDrop', node: 0 }],
      ['an inherited object', Object.create({ type: 'action', action: 'scriptDrop', node: 0 }) as object],
    ];
    for (const [name, value] of rows) {
      expect(isDependenciesAction(value), name).toBe(false);
    }
  });

  it('accepts Open as Markdown with a view of the right shape or without, and nothing else', () => {
    const accepts = (value: unknown) => isShellRequest(value, isDependenciesView);
    expect(accepts({ type: 'markdown' })).toBe(true);
    expect(accepts({ type: 'markdown', view: { direction: 'dependsOn', depth: 3, text: 'x' } })).toBe(true);
    for (const view of [
      { direction: 'sideways', depth: 3, text: '' },
      { direction: 'usedBy', depth: 6, text: '' },
      { direction: 'usedBy', depth: 0, text: '' },
      { direction: 'usedBy', depth: 2 },
      'usedBy',
      { markdown: '# injected' },
    ]) {
      expect(accepts({ type: 'markdown', view }), JSON.stringify(view)).toBe(false);
    }
    expect(accepts({ type: 'markdown', markdown: '# injected' })).toBe(false);
  });
});

describe('which action the extension carries out', () => {
  const index = (name: string): number => events.nodes.findIndex((node) => node.name === name);

  it('names the object of the request from the data it sent', () => {
    const plan = planDependenciesAction(events, { action: 'scriptDrop', node: index('big_events') });
    expect(plan?.action).toBe('scriptDrop');
    expect(plan?.node).toMatchObject({ kind: 'view', id: HISTORY_ID.bigEventsView, schema: 'shop' });
  });

  it('offers the statistics of a table only', () => {
    expect(
      planDependenciesAction(events, { action: 'showStatistics', node: index('events') })?.node.kind,
    ).toBe('table');
    expect(
      planDependenciesAction(events, { action: 'showStatistics', node: index('big_events') }),
    ).toBeUndefined();
    expect(
      planDependenciesAction(events, { action: 'showStatistics', node: index('recent_events') }),
    ).toBeUndefined();
  });

  it('ignores an object that is no number or that the data does not have', () => {
    for (const node of ['0', 'length', '1e0', null, events.nodes.length, 99, -1, 0.5, Number.NaN]) {
      expect(
        planDependenciesAction(events, { action: 'showInTree', node: node as unknown as number }),
        String(node),
      ).toBeUndefined();
    }
  });
});

describe('the choices that a hidden page keeps', () => {
  it('come back for the same report, with the selected object found again by its name', () => {
    const selected = events.nodes.findIndex((node) => node.name === 'big_events');
    const saved = saveChoices(events, { direction: 'dependsOn', depth: 2, text: 'ev', selected });
    expect(saved).toMatchObject({
      target: `table:${HISTORY_ID.events}`,
      selected: `view:${HISTORY_ID.bigEventsView}`,
    });
    expect(restoreDependenciesChoices(saved, events)).toEqual({
      direction: 'dependsOn',
      depth: 2,
      text: 'ev',
      selected,
    });
  });

  it('are dropped for another connection or another object, or when nothing valid was saved', () => {
    const saved = saveChoices(events, { direction: 'usedBy', depth: 5, text: '', selected: 1 });
    expect(restoreDependenciesChoices(saved, { ...events, connection: 'Other' })).toBeUndefined();
    expect(restoreDependenciesChoices(saved, lake)).toBeUndefined();
    expect(restoreDependenciesChoices(undefined, events)).toBeUndefined();
    expect(restoreDependenciesChoices({ direction: 'usedBy' }, events)).toBeUndefined();
  });

  it('keep the report and drop only the selection when the selected object is gone', () => {
    const selected = events.nodes.findIndex((node) => node.name === 'big_events');
    const saved = saveChoices(events, { direction: 'dependsOn', depth: 4, text: 'x', selected });
    const target = events.nodes[events.target ?? -1];
    expect(target?.name).toBe('events');
    const alone = {
      ...events,
      nodes: target ? [target] : [],
      target: 0,
      edges: [],
      broken: [],
      unresolved: [],
    };
    expect(restoreDependenciesChoices(saved, alone)).toStrictEqual({
      direction: 'dependsOn',
      depth: 4,
      text: 'x',
      selected: undefined,
    });
  });
});
