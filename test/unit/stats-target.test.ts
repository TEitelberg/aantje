import { describe, expect, it } from 'vitest';
import type { ColumnInfo, SchemaInfo, TableInfo, ViewInfo } from '../../src/catalog/model';
import { statisticsKey, statisticsTargetOf, statisticsTitle } from '../../src/stats/target';
import type { NodeRef } from '../../src/tree/refs';

const schema: SchemaInfo = { id: 1, name: 'shop', comment: null };
const table: TableInfo = {
  id: 3,
  schemaId: 1,
  name: 'events',
  comment: null,
  stats: { rows: 0, files: 0, sizeBytes: 0 },
};
const view: ViewInfo = {
  id: 13,
  schemaId: 1,
  name: 'big_events',
  comment: null,
  sql: 'SELECT 1',
  dialect: 'duckdb',
  columnAliases: [],
};
const column: ColumnInfo = {
  id: 1,
  name: 'id',
  type: 'int32',
  nullable: true,
  defaultValue: null,
  comment: null,
  children: [],
};

describe('statisticsTargetOf', () => {
  const target = { connectionId: 'c', tableId: 3, schema: 'shop', table: 'events' };

  it('finds the table of a table node and of its Statistics folder', () => {
    expect(statisticsTargetOf({ kind: 'table', connectionId: 'c', schema, table })).toEqual(target);
    expect(
      statisticsTargetOf({ kind: 'folder', connectionId: 'c', folder: 'statistics', schema, table }),
    ).toEqual(target);
  });

  it('finds nothing on any other node: the other folders, columns, views and the rest', () => {
    const others: NodeRef[] = [
      { kind: 'connection', connectionId: 'c' },
      { kind: 'schema', connectionId: 'c', schema },
      { kind: 'folder', connectionId: 'c', folder: 'tables', schema, tables: [table] },
      { kind: 'folder', connectionId: 'c', folder: 'columns', schema, table, columns: [column] },
      { kind: 'column', connectionId: 'c', schema, table, column, path: ['id'] },
      { kind: 'view', connectionId: 'c', schema, view },
      { kind: 'detail', connectionId: 'c' },
      { kind: 'message', connectionId: 'c', text: 'x' },
    ];
    expect(others.map(statisticsTargetOf)).toEqual(others.map(() => undefined));
  });
});

describe('statisticsKey', () => {
  const target = { connectionId: 'c', tableId: 3, schema: 'shop', table: 'events' };

  it('is the same for the same connection, table and snapshot, whatever the table is called', () => {
    expect(statisticsKey(target, 56)).toBe(statisticsKey({ ...target, table: 'renamed' }, 56));
  });

  it('differs by connection, table and snapshot', () => {
    const keys = [
      statisticsKey(target, 56),
      statisticsKey(target, 55),
      statisticsKey({ ...target, tableId: 4 }, 56),
      statisticsKey({ ...target, connectionId: 'd' }, 56),
    ];
    expect(new Set(keys).size).toBe(4);
  });

  it('cannot be imitated by a connection id that looks like the rest of the key', () => {
    expect(statisticsKey({ ...target, connectionId: 'c",3' }, 56)).not.toBe(
      statisticsKey({ ...target, connectionId: 'c' }, 56),
    );
  });
});

describe('statisticsTitle', () => {
  it('names the table, the snapshot and the connection', () => {
    expect(
      statisticsTitle({ connectionId: 'c', tableId: 3, schema: 'shop', table: 'events' }, 'History', 56),
    ).toBe('Statistics of shop.events @56 · History');
  });
});
