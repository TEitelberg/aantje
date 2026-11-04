import { describe, expect, it } from 'vitest';
import { maintenanceOf } from '../../src/maintenance';
import { scriptTarget } from '../../src/script-target';
import type { ReportTable } from '../../src/script-target';
import type { CatalogTree } from '../../src/tree/model';

const tree = { state: () => ({ snapshot: 'latest' as const }) } as unknown as CatalogTree;
const events: ReportTable = { id: 7, schemaId: 2, schema: 'shop', name: 'events' };

describe('scriptTarget', () => {
  it('targets the connection when the plan has no table', () => {
    expect(scriptTarget('lake-1', { kind: 'expire' })).toEqual({
      kind: 'expire',
      ref: { kind: 'connection', connectionId: 'lake-1' },
    });
  });

  it('targets the table as a tree node, with zero statistics unless the table carries them', () => {
    const bare = scriptTarget('lake-1', { kind: 'merge', table: events });
    const measured = scriptTarget('lake-1', {
      kind: 'merge',
      table: { ...events, rows: 10, files: 3, sizeBytes: 2048 },
    });

    expect(bare.ref).toMatchObject({
      kind: 'table',
      connectionId: 'lake-1',
      schema: { id: 2, name: 'shop' },
      table: { id: 7, schemaId: 2, name: 'events', stats: { rows: 0, files: 0, sizeBytes: 0 } },
    });
    expect(measured.ref).toMatchObject({ table: { stats: { rows: 10, files: 3, sizeBytes: 2048 } } });
  });

  it('gives a script that names the table with its schema and quotes the names', () => {
    const { kind, ref } = scriptTarget('lake-1', {
      kind: 'rewrite',
      table: { ...events, schema: "my'schema", name: "ev'ents" },
    });

    const calls = maintenanceOf(tree, kind, ref)
      ?.split('\n')
      .filter((line) => line.startsWith('CALL '));

    expect(calls).toEqual(["CALL ducklake_rewrite_data_files('lake', 'ev''ents', schema => 'my''schema');"]);
  });
});
