import { beforeEach, describe, expect, it, vi } from 'vitest';
import { folderNodeId, treeNodeId } from '../../src/search';
import type { TableActionEnv } from '../../src/shell/table-actions.vscode';
import type { TreeNode } from '../../src/tree/refs';

const information = vi.hoisted(() => [] as string[]);

vi.mock('vscode', () => ({
  window: {
    showInformationMessage: (message: string) => {
      information.push(message);
      return Promise.resolve(undefined);
    },
  },
}));

const { performTableAction, revealEntry } = await import('../../src/shell/table-actions.vscode');

const events = { id: 7, schemaId: 2, schema: 'shop', name: 'events' };
const entry = { kind: 'table' as const, id: 7, schemaId: 2, schemaName: 'shop', name: 'events' };

/** A tree with one connection, one schema and one table, as `findEntryNode` walks it. */
function treeWith(table: boolean) {
  const node = (id: string, ref: object) => ({ id, ref }) as unknown as TreeNode;
  const connection = node('lake-1', { kind: 'connection', connectionId: 'lake-1' });
  const schema = node('lake-1/s2', { kind: 'schema', connectionId: 'lake-1', schema: { id: 2 } });
  const folder = node(folderNodeId('lake-1', entry), { kind: 'folder' });
  const leaf = node(treeNodeId('lake-1', entry), { kind: 'table' });
  const children = new Map<TreeNode, TreeNode[]>([
    [connection, [schema]],
    [schema, [folder]],
    [folder, table ? [leaf] : []],
  ]);
  return {
    leaf,
    tree: {
      roots: () => [connection],
      children: (parent: TreeNode) => Promise.resolve(children.get(parent) ?? []),
      state: () => ({ snapshot: 'latest' as const }),
      reader: () => undefined,
    },
  };
}

function setup(table = true) {
  const { leaf, tree } = treeWith(table);
  const revealed: [TreeNode, unknown][] = [];
  const statistics: [unknown, number][] = [];
  const sql: [string, string][] = [];
  const env = {
    tree,
    view: {
      reveal: (shown: TreeNode, options: unknown) => {
        revealed.push([shown, options]);
        return Promise.resolve();
      },
    },
    openSql: (connectionId: string, text: string) => {
      sql.push([connectionId, text]);
      return Promise.resolve();
    },
    showStatistics: (target: unknown, snapshot: number) => {
      statistics.push([target, snapshot]);
      return Promise.resolve();
    },
  } as unknown as TableActionEnv;
  return { env, leaf, revealed, statistics, sql };
}

beforeEach(() => {
  information.length = 0;
});

describe('performTableAction', () => {
  it('shows the statistics of the table at the snapshot of the report', async () => {
    const { env, statistics } = setup();

    await performTableAction(env, 'lake-1', { action: 'showStatistics', table: events }, 12);

    expect(statistics).toEqual([
      [{ connectionId: 'lake-1', tableId: 7, schema: 'shop', table: 'events' }, 12],
    ]);
  });

  it('selects and focuses the node of the table in the tree', async () => {
    const { env, leaf, revealed } = setup();

    await performTableAction(env, 'lake-1', { action: 'revealTable', table: events }, 12);

    expect(revealed).toEqual([[leaf, { select: true, focus: true }]]);
    expect(information).toEqual([]);
  });

  it('says that the tree does not show a table that is not in it at the snapshot it shows', async () => {
    const { env, revealed } = setup(false);

    await performTableAction(env, 'lake-1', { action: 'revealTable', table: events }, 12);

    expect(revealed).toEqual([]);
    expect(information).toEqual([
      'The tree does not show "shop.events". It may not exist at the snapshot that the tree shows.',
    ]);
  });

  it('opens the maintenance script of the lake, or of the table, in an SQL document of the connection', async () => {
    const { env, sql } = setup();

    await performTableAction(env, 'lake-1', { action: 'script', kind: 'expire' }, 12);
    await performTableAction(env, 'lake-1', { action: 'script', kind: 'merge', table: events }, 12);

    expect(sql.map(([connectionId]) => connectionId)).toEqual(['lake-1', 'lake-1']);
    expect(sql[0]?.[1]).toContain(
      "CALL ducklake_expire_snapshots('lake', older_than => now() - INTERVAL 30 DAY",
    );
    expect(sql[1]?.[1]).toContain("CALL ducklake_merge_adjacent_files('lake', 'events', schema => 'shop');");
  });
});

describe('revealEntry', () => {
  it('names the table in the message when the entry is missing', async () => {
    const { env } = setup();

    await revealEntry(env, 'lake-1', undefined, 'shop.gone');

    expect(information).toEqual([
      'The tree does not show "shop.gone". It may not exist at the snapshot that the tree shows.',
    ]);
  });
});
