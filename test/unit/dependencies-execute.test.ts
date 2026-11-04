import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CatalogReader } from '../../src/catalog/model';
import { planDependenciesAction } from '../../src/dependencies/actions';
import { findNode, performDependenciesAction } from '../../src/dependencies/execute';
import type { DependenciesPort } from '../../src/dependencies/execute';
import type { DependenciesData } from '../../src/dependencies/model';
import type { DependenciesActionId } from '../../src/dependencies/protocol';
import { objectData, readGraph } from '../../src/dependencies/read';
import { CatalogTree } from '../../src/tree/model';
import type { TreeNode } from '../../src/tree/refs';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID, HISTORY_SNAPSHOT } from '../support/expected-history';
import { historyFixture } from '../support/sources/history';
import { sharedParser } from './dependencies-support';

const catalogs = editedCatalogs();
const parser = sharedParser();
let tree: CatalogTree;
let events: DependenciesData;
let opened: string[];
let told: string[];
let revealed: TreeNode[];
let statistics: unknown[];
let dependencies: string[];

const port = (): DependenciesPort => ({
  connectionId: 'h',
  tree,
  reveal: (node) => {
    revealed.push(node);
    return Promise.resolve();
  },
  showStatistics: (target, snapshot) => {
    statistics.push({ target, snapshot });
    return Promise.resolve();
  },
  showDependencies: (node, snapshot) => {
    dependencies.push(`${node.kind}:${node.name}@${snapshot}`);
    return Promise.resolve();
  },
  openSql: (text) => {
    opened.push(text);
    return Promise.resolve();
  },
  info: (message) => void told.push(message),
});

beforeAll(async () => {
  const reader = await catalogs.open(historyFixture.sqlite);
  tree = new CatalogTree({
    profiles: () => [{ id: 'h', name: 'History', kind: 'sqlite', path: 'unused' }],
    open: async () => ({ reader, info: await reader.info() }),
  });
  await tree.connect('h');
  const graph = await readGraph(reader, parser, 56);
  const data = objectData(graph, 'History', 56, { kind: 'table', id: HISTORY_ID.events });
  if (!data) {
    throw new Error('The table is there.');
  }
  events = data;
});
afterAll(async () => {
  await tree.dispose();
  await catalogs.dispose();
  await parser.dispose();
});

const run = async (action: DependenciesActionId, name: string, data = events): Promise<void> => {
  opened = [];
  told = [];
  revealed = [];
  statistics = [];
  dependencies = [];
  const plan = planDependenciesAction(data, {
    action,
    node: data.nodes.findIndex((node) => node.name === name),
  });
  if (!plan) {
    throw new Error(`No plan for ${action} ${name}`);
  }
  await performDependenciesAction(plan, 56, port());
};

describe('the scripts of the actions of an object', () => {
  it('opens the DROP script of the table in a SQL editor and runs nothing', async () => {
    await run('scriptDrop', 'events');
    expect(opened).toEqual([
      ['-- Drops the table. Run it in a read/write SQL session.', 'DROP TABLE "shop"."events";'].join('\n'),
    ]);
  });

  it('opens the DROP script of a view and of a macro, which has no table-like name', async () => {
    await run('scriptDrop', 'big_events');
    expect(opened[0]).toContain('DROP VIEW "shop"."big_events";');
    await run('scriptDrop', 'recent_events');
    expect(opened[0]).toContain('DROP MACRO TABLE "shop"."recent_events";');
  });

  it('opens the CREATE and ALTER scripts that the tree offers for the same object', async () => {
    await run('scriptCreate', 'big_events');
    expect(opened[0]).toContain('CREATE VIEW "shop"."big_events" AS');
    await run('scriptAlter', 'big_events');
    expect(opened[0]).toContain('CREATE OR REPLACE VIEW "shop"."big_events" AS');
    await run('scriptCreate', 'recent_events');
    expect(opened[0]).toContain('CREATE OR REPLACE MACRO "shop"."recent_events"');
    await run('scriptAlter', 'events');
    expect(opened[0]).toContain('ALTER TABLE "shop"."events"');
    await run('scriptCreate', 'events');
    expect(opened[0]).toContain('CREATE TABLE "shop"."events"');
  });

  it('says that an object is not there instead of opening an empty script, when the snapshot does not have it', async () => {
    const gone = {
      ...events,
      nodes: [
        ...events.nodes,
        { kind: 'view' as const, id: HISTORY_ID.tmpView, schemaId: 1, schema: 'shop', name: 'tmp_view' },
      ],
    };
    await run('scriptDrop', 'tmp_view', gone);
    expect(opened).toEqual([]);
    expect(told).toEqual([expect.stringMatching(/"shop\.tmp_view".*@56(?![0-9])/)]);
  });

  it('refuses when the connection is closed', async () => {
    const closed = new CatalogTree({
      profiles: () => [{ id: 'h', name: 'History', kind: 'sqlite', path: 'unused' }],
      open: () => Promise.reject(new Error('never opened')),
    });
    const plan = planDependenciesAction(events, { action: 'scriptDrop', node: events.target ?? 0 });
    if (!plan) {
      throw new Error('The table is there.');
    }
    await expect(performDependenciesAction(plan, 56, { ...port(), tree: closed })).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });
  });
});

describe('the scripts are written for the snapshot of the report, whatever the tree shows', () => {
  let reader: CatalogReader;

  /** The report of an object at a snapshot, and the script of one action for it. */
  const scriptAt = async (
    snapshot: number,
    id: number,
    action: DependenciesActionId,
  ): Promise<string | undefined> => {
    const data = objectData(await readGraph(reader, parser, snapshot), 'History', snapshot, {
      kind: 'table',
      id,
    });
    const plan = data && planDependenciesAction(data, { action, node: data.target ?? -1 });
    if (!plan) {
      throw new Error('The table is there.');
    }
    opened = [];
    told = [];
    await performDependenciesAction(plan, snapshot, port());
    return opened[0];
  };

  beforeAll(async () => {
    reader = await catalogs.open(historyFixture.sqlite);
  });
  afterEach(() => tree.selectSnapshot('h', 'latest'));

  it('writes the columns that the table had at the snapshot of the report, not at the snapshot that the tree shows', async () => {
    const then = (await reader.columns(HISTORY_ID.evolving, HISTORY_SNAPSHOT.addExtraColumn)).map(
      ({ name }) => name,
    );
    const now = (await reader.columns(HISTORY_ID.evolving, 56)).map(({ name }) => name);
    const onlyNow = now.filter((name) => !then.includes(name));
    expect(onlyNow.length).toBeGreaterThan(0);
    for (const action of ['scriptCreate', 'scriptAlter'] as const) {
      const script = (await scriptAt(HISTORY_SNAPSHOT.addExtraColumn, HISTORY_ID.evolving, action)) ?? '';
      expect(then.every((name) => script.includes(`"${name}"`))).toBe(true);
      expect(onlyNow.some((name) => script.includes(`"${name}"`))).toBe(false);
    }
  });

  it('writes the script of a table that the tree does not show at all', async () => {
    const script = await scriptAt(HISTORY_SNAPSHOT.insertOldStuff, HISTORY_ID.oldStuff, 'scriptCreate');
    expect(script).toContain('CREATE TABLE "shop"."old_stuff"');
    expect(told).toEqual([]);
  });

  it('says that DROP and ALTER act on the newest state when the report is of an older snapshot, however the tree is set', async () => {
    const note = (snapshot: number): string =>
      `-- This script was made for snapshot @${snapshot}; this statement acts on the newest state.`;
    expect(await scriptAt(HISTORY_SNAPSHOT.addExtraColumn, HISTORY_ID.evolving, 'scriptDrop')).toContain(
      note(HISTORY_SNAPSHOT.addExtraColumn),
    );
    expect(await scriptAt(HISTORY_SNAPSHOT.addExtraColumn, HISTORY_ID.evolving, 'scriptDrop')).not.toContain(
      'The tree shows',
    );
    expect(await scriptAt(HISTORY_SNAPSHOT.addExtraColumn, HISTORY_ID.evolving, 'scriptAlter')).toContain(
      `-- This script was made for snapshot @${HISTORY_SNAPSHOT.addExtraColumn}; these statements act on the newest state.`,
    );
    tree.selectSnapshot('h', HISTORY_SNAPSHOT.insertOldStuff);
    expect(await scriptAt(56, HISTORY_ID.events, 'scriptDrop')).not.toContain('acts on the newest state');
    expect(await scriptAt(HISTORY_SNAPSHOT.addExtraColumn, HISTORY_ID.evolving, 'scriptDrop')).toContain(
      note(HISTORY_SNAPSHOT.addExtraColumn),
    );
  });
});

describe('the other actions of an object', () => {
  it('shows the table in the tree with the node of the tree itself, and a macro in its Macros folder', async () => {
    await run('showInTree', 'events');
    expect(revealed.map(({ ref }) => ref.kind === 'table' && ref.table.id)).toEqual([HISTORY_ID.events]);
    await run('showInTree', 'big_events');
    expect(revealed.map(({ ref }) => ref.kind === 'view' && ref.view.id)).toEqual([HISTORY_ID.bigEventsView]);
    await run('showInTree', 'recent_events');
    expect(revealed.map(({ ref }) => ref.kind === 'macro' && ref.macro.id)).toEqual([
      HISTORY_ID.recentEventsMacro,
    ]);
  });

  it('says so when the tree does not show the object', async () => {
    const gone = {
      ...events,
      nodes: [
        ...events.nodes,
        { kind: 'table' as const, id: 999, schemaId: 1, schema: 'shop', name: 'nowhere' },
      ],
    };
    await run('showInTree', 'nowhere', gone);
    expect(revealed).toEqual([]);
    expect(told).toEqual([expect.stringContaining('"shop.nowhere"')]);
    expect(
      await findNode(tree, 'h', { kind: 'scalarMacro', id: 999, schemaId: 1, schema: 'shop', name: 'x' }),
    ).toBeUndefined();
    for (const node of events.nodes) {
      expect(await findNode(tree, 'nobody', node)).toBeUndefined();
    }
    expect(events.nodes.some(({ kind }) => kind === 'tableMacro')).toBe(true);
  });

  it('shows the statistics of the table at the snapshot of the report', async () => {
    await run('showStatistics', 'events');
    expect(statistics).toEqual([
      {
        target: { connectionId: 'h', tableId: HISTORY_ID.events, schema: 'shop', table: 'events' },
        snapshot: 56,
      },
    ]);
  });

  it('opens the report of the other object', async () => {
    await run('showDependencies', 'big_events');
    expect(dependencies).toEqual(['view:big_events@56']);
  });
});
