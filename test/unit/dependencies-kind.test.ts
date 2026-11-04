import { afterAll, describe, expect, it } from 'vitest';
import { dependenciesKind } from '../../src/dependencies/kind';
import { isDependenciesMessage } from '../../src/dependencies/protocol';
import { objectData, readGraph } from '../../src/dependencies/read';
import { ReportPanels } from '../../src/shell/panels';
import type { PanelPort } from '../../src/shell/panels';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID } from '../support/expected-history';
import { historyFixture } from '../support/sources/history';
import { sharedParser } from './dependencies-support';

const catalogs = editedCatalogs();
const parser = sharedParser();
afterAll(async () => {
  await catalogs.dispose();
  await parser.dispose();
});

const graph = await readGraph(await catalogs.open(historyFixture.sqlite), parser, 56);
const events = objectData(graph, 'History', 56, { kind: 'table', id: HISTORY_ID.events });
if (!events) {
  throw new Error('The table is there.');
}

/** A panel whose page the test plays. */
function panel() {
  const posted: unknown[] = [];
  let listener: (message: unknown) => void = () => undefined;
  const port: PanelPort = {
    setTitle: () => undefined,
    reveal: () => undefined,
    post: (message) => void posted.push(message),
    dispose: () => undefined,
    onMessage: (next) => void (listener = next),
    onDispose: () => undefined,
  };
  return { port, posted, send: (message: unknown) => listener(message) };
}

describe('the Dependencies report in the report shell', () => {
  it('sends the page a message that the page accepts, and opens the document of the data with the view of the page', () => {
    const fake = panel();
    const actions: unknown[] = [];
    const documents: string[] = [];
    const panels = new ReportPanels(() => fake.port, dependenciesKind, {
      onAction: (action) => void actions.push(action),
      openMarkdown: (text) => void documents.push(text),
    });
    panels.show('key', 'Dependencies of shop.events', events);
    fake.send({ type: 'ready' });
    expect(fake.posted).toHaveLength(1);
    expect(isDependenciesMessage(fake.posted[0])).toBe(true);

    fake.send({ type: 'markdown', view: { direction: 'usedBy', depth: 1, text: '' } });
    expect(documents).toHaveLength(1);
    expect(documents[0]).toContain('| Direction | Used by |');
    expect(documents[0]).toContain('| Depth | 1 |');

    fake.send({ type: 'markdown', view: { direction: 'usedBy', depth: 9, text: '' } });
    fake.send({ type: 'markdown', markdown: '# injected' });
    expect(documents).toHaveLength(1);
  });

  it('passes on an action with an object and ignores a command, a missing object and a made-up action', () => {
    const fake = panel();
    const actions: unknown[] = [];
    const panels = new ReportPanels(() => fake.port, dependenciesKind, {
      onAction: (action) => void actions.push(action),
      openMarkdown: () => undefined,
    });
    panels.show('key', 'Dependencies', events);
    fake.send({ type: 'action', action: 'scriptDrop', node: 1 });
    fake.send({ type: 'action', action: 'aantje.scriptDrop', node: 1 });
    fake.send({ type: 'action', action: 'scriptDrop' });
    fake.send({ type: 'action', action: 'format', node: 1 });
    expect(actions).toEqual([{ type: 'action', action: 'scriptDrop', node: 1 }]);
  });
});
