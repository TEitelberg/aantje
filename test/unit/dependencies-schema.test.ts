import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schemaData } from '../../src/dependencies/read';
import type { DependencyGraph } from '../../src/dependencies/graph';
import { dependenciesMarkdown } from '../../src/dependencies/markdown';
import { edgeList, graphOf, nameOf, sharedParser } from './dependencies-support';
import { lakeBackends } from './lake-backends';
import type { BackendLake } from './lake-backends';

const parser = sharedParser();
afterAll(() => parser.dispose());

const backends = await lakeBackends();

describe.each(backends)('the dependencies of one schema on a lake with $name metadata', (backend) => {
  describe.skipIf(backend.skipReason !== undefined)('three schemas', () => {
    let lake: BackendLake;
    let graph: DependencyGraph;

    beforeAll(async () => {
      lake = await backend.create();
      for (const text of [
        'CREATE SCHEMA a',
        'CREATE SCHEMA b',
        'CREATE SCHEMA c',
        'CREATE TABLE b.base AS SELECT 1 AS x',
        'CREATE TABLE c.other AS SELECT 2 AS x',
        'CREATE TABLE a.alone AS SELECT 3 AS x',
        'CREATE VIEW a.v_in AS SELECT * FROM b.base',
        'CREATE VIEW b.v_out AS SELECT * FROM a.v_in',
        'CREATE VIEW c.v_elsewhere AS SELECT * FROM c.other',
      ]) {
        await lake.connection.run(text);
      }
      const reader = await lake.reader();
      try {
        graph = await graphOf(reader, parser);
      } finally {
        await reader.close();
      }
    });
    afterAll(() => lake?.remove());

    it('lists the objects of the schema that take part and the objects next to them', () => {
      const schema = graph.nodes.find((node) => node.schema === 'a');
      const data = schemaData(graph, 'Lake', 5, { id: schema?.schemaId ?? -1, name: 'a' });

      expect(data.scope).toEqual({ kind: 'schema', id: schema?.schemaId, name: 'a' });
      expect(data.target).toBeNull();
      expect(edgeList(data)).toEqual(['a.v_in reads b.base', 'b.v_out reads a.v_in']);
      expect(data.nodes.map((_, index) => nameOf(data, index)).toSorted()).toEqual([
        'a.v_in',
        'b.base',
        'b.v_out',
      ]);
      expect(data.isolated).toBe(1);
    });

    it('holds nothing of a schema that is unrelated, and names the schema in the document', () => {
      const schema = graph.nodes.find((node) => node.schema === 'c');
      const data = schemaData(graph, 'Lake', 5, { id: schema?.schemaId ?? -1, name: 'c' });

      expect(edgeList(data)).toEqual(['c.v_elsewhere reads c.other']);
      expect(dependenciesMarkdown(data).split('\n')[0]).toBe('# Dependencies in Lake · schema c');
      expect(dependenciesMarkdown(data)).not.toContain('a.v_in');
    });
  });
});
