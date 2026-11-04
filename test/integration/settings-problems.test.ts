import assert from 'node:assert/strict';
import type { CatalogTree } from '../../src/tree/model';
import { Desktop } from './desktop';
import { activate, copyFixture, setConnections, uniqueId } from './support';

describe('invalid entries in the setting "aantje.connections"', () => {
  let tree: CatalogTree;
  let desktop: Desktop;

  beforeEach(async () => {
    ({ tree } = await activate());
    desktop = Desktop.install();
  });

  afterEach(() => {
    desktop.assertDone();
  });

  const lake = (name: string) => ({
    id: uniqueId('lake'),
    name,
    kind: 'sqlite',
    path: copyFixture('ducklake.sqlite'),
  });
  const labels = (): string[] => tree.roots().map((node) => node.label);
  const BROKEN_KIND = { name: 'Broken lake', kind: 'oracle' };

  it('shows the valid connections, warns once about the invalid ones however often the setting changes afterwards, and not at all about a fine setting', async () => {
    const first = lake('First lake');
    const second = lake('Second lake');

    await setConnections([first]);
    assert.deepEqual(labels(), ['First lake']);
    assert.equal(desktop.warnings.length, 0);

    await setConnections([first, BROKEN_KIND]);
    assert.equal(desktop.warnings.length, 1);
    assert.ok(desktop.warnings[0]?.includes('aantje.connections'));
    assert.deepEqual(labels(), ['First lake']);

    await setConnections([first, BROKEN_KIND, second]);
    await setConnections([second, BROKEN_KIND, first]);

    assert.deepEqual(labels(), ['Second lake', 'First lake']);
    assert.equal(desktop.warnings.length, 1);
  });

  it('warns again when the problems change or a fixed problem returns, and shows no connection for a setting that is not an array', async () => {
    const valid = lake('Valid lake');

    await setConnections([valid, BROKEN_KIND]);
    await setConnections([valid, BROKEN_KIND, 'not an object']);
    assert.equal(desktop.warnings.length, 2, 'two problems are a new warning');

    await setConnections([valid]);
    assert.equal(desktop.warnings.length, 2, 'nothing to warn about');
    await setConnections([valid, BROKEN_KIND]);
    assert.equal(desktop.warnings.length, 3, 'the problem that returned is warned about again');
    assert.deepEqual(labels(), ['Valid lake']);

    await setConnections('not an array');
    assert.deepEqual(tree.roots(), []);
    assert.equal(desktop.warnings.length, 4);
  });
});
