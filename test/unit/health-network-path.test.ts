import { describe, expect, it } from 'vitest';
import type { CatalogReader } from '../../src/catalog/model';
import { connectionFacts, startConnectionGroup } from '../../src/health/connection-run';
import { createRunContext } from '../../src/health/run-context';

const B = String.fromCharCode(92);

/** Runs the part of the connection group that looks at the data path, with a spy where the host's file system is asked. */
async function asked(dataPath: string): Promise<{ paths: string[]; ids: string[] }> {
  const paths: string[] = [];
  const ids: string[] = [];
  const context = createRunContext(
    {
      reader: {} as CatalogReader,
      access: { profile: { id: 'x', name: 'x', kind: 'duckdb', path: 'x' }, s3: {} },
      exists: (path) => {
        paths.push(path);
        return Promise.resolve(false);
      },
    },
    { scope: { kind: 'lake' }, depth: 'quick', snapshot: 1 },
    { onEvent: (event) => void (event.type === 'finding' && ids.push(event.finding.id)) },
  );
  const catalog = { latest: 1, dataPath, names: new Map(), schemas: new Map(), error: undefined };
  await startConnectionGroup(context, catalog, connectionFacts(context, catalog));
  return { paths, ids };
}

describe('the check of the data path of the connection', () => {
  it('looks at a local directory with the file system of the host, as before', async () => {
    const { paths, ids } = await asked('/data/aantje-no-such-lake/');

    expect(paths).toEqual(['/data/aantje-no-such-lake/']);
    expect(ids).toContain('connection.local-path-missing');
  });

  it.each([
    `${B}${B}10.255.255.1${B}share${B}lake${B}`,
    '//10.255.255.1/share/lake/',
    `${B}${B}?${B}UNC${B}10.255.255.1${B}share`,
  ])(
    'does not stat a network path, which would contact the host named by the catalog: %s',
    async (dataPath) => {
      const { paths, ids } = await asked(dataPath);

      expect(paths).toEqual([]);
      expect(ids).not.toContain('connection.local-path-missing');
    },
  );
});
