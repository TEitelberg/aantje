import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCRIPTS } from '../../src/script-templates';
import type { ScriptKind, ScriptVerb } from '../../src/script-templates';

interface MenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}

const root = fileURLToPath(new URL('../..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  contributes: { menus: Record<string, MenuEntry[]>; commands: { command: string; title: string }[] };
};
const { menus, commands } = manifest.contributes;

/**
 * The context values that the tree gives its nodes: the menus can only ask for these. The Azure variant of a connection
 * state and the schema main have the menus of a connection and a schema (`manifest.test.ts` checks it), so they are
 * left out here.
 */
const CONTEXT_VALUES = [
  ...readFileSync(join(root, 'src/tree/nodes.ts'), 'utf8').matchAll(/contextValue: '([^']+)'/g),
]
  .map((match) => match[1] ?? '')
  .filter((value) => !value.endsWith('.azure') && value !== 'schema.main')
  .toSorted();

const VERB_OF: Record<string, ScriptVerb> = {
  'aantje.scriptSelect': 'select',
  'aantje.scriptInsert': 'insert',
  'aantje.scriptCreate': 'create',
  'aantje.scriptAlter': 'alter',
  'aantje.scriptDrop': 'drop',
};
const VERBS = ['select', 'insert', 'create', 'alter', 'drop'] as const satisfies readonly ScriptVerb[];
const kinds = Object.keys(SCRIPTS) as ScriptKind[];
const kindsWith = (verb: ScriptVerb): string[] => kinds.filter((kind) => SCRIPTS[kind][verb]).toSorted();

/** The context values that a `viewItem =~ /…/` condition shows the entry for. */
function shownFor(when: string | undefined): string[] {
  const source = /viewItem =~ \/(.*)\/$/.exec(when ?? '')?.[1];
  if (source === undefined) {
    throw new Error(`The condition "${when}" has no viewItem pattern: the entry would show on every node`);
  }
  return CONTEXT_VALUES.filter((value) => new RegExp(source).test(value));
}

const entries = menus['aantje.script'] ?? [];
const opener = (menus['view/item/context'] ?? []).find(({ submenu }) => submenu === 'aantje.script');

describe('the Script as menus and the matrix of the scripts', () => {
  it('have one entry and one command for each of the five verbs, and for no other', () => {
    expect(entries.map(({ command }) => VERB_OF[command ?? '']).toSorted()).toEqual([...VERBS].toSorted());
    expect(commands.filter(({ command }) => command in VERB_OF)).toHaveLength(VERBS.length);
  });

  it('show each verb on exactly the nodes whose kind has a generator for it, and open the submenu on exactly the nodes that have at least one script', () => {
    for (const verb of VERBS) {
      const entry = entries.find(({ command }) => VERB_OF[command ?? ''] === verb);
      expect(shownFor(entry?.when).toSorted(), verb).toEqual(kindsWith(verb));
    }
    const when = opener?.when?.replace('view == aantje.catalogs && ', '');
    expect(shownFor(when).toSorted()).toEqual(
      kinds.filter((kind) => Object.keys(SCRIPTS[kind]).length > 0).toSorted(),
    );
  });

  it('only ever name context values that the tree sets, every kind of the matrix is one of them, and every kind has at least one verb', () => {
    expect(CONTEXT_VALUES.length).toBeGreaterThan(20);
    for (const kind of kinds) {
      expect(CONTEXT_VALUES, `the tree has no node with the context value ${kind}`).toContain(kind);
    }
    expect(kinds.filter((kind) => Object.keys(SCRIPTS[kind]).length === 0)).toEqual([]);
  });
});

describe('the verbs of the Script as submenu on each node, as the design says', () => {
  const shownOn = (when: string | undefined, contextValue: string): boolean =>
    new RegExp(/viewItem =~ \/(.*)\/$/.exec(when ?? '')?.[1] ?? '(?!)').test(contextValue);
  const verbs = (contextValue: string): string[] =>
    entries
      .filter(({ when }) => shownOn(when, contextValue))
      .map(({ command }) => VERB_OF[command ?? ''] ?? '')
      .toSorted();

  const DESIGN: readonly [contextValue: string, verbs: readonly ScriptVerb[]][] = [
    ['connection.connected', ['select', 'create', 'drop']],
    ['schema', ['select', 'create', 'drop']],
    ['folder.tables', ['select', 'create', 'drop']],
    ['folder.views', ['select', 'create', 'drop']],
    ['folder.macros', ['select', 'create', 'drop']],
    // DROP is shown on main, disabled by the enablement of the command.
    ['schema.main', ['select', 'create', 'drop']],
    ['table', ['select', 'insert', 'create', 'alter', 'drop']],
    ['view', ['select', 'create', 'alter', 'drop']],
    ['macro', ['select', 'create', 'alter', 'drop']],
    ['folder.columns', ['select', 'create', 'alter', 'drop']],
    ['column', ['select', 'create', 'alter', 'drop']],
    ['column.member', ['select', 'alter']],
    ['folder.partitioning', ['select', 'create', 'alter', 'drop']],
    ['folder.sortOrder', ['select', 'create', 'alter', 'drop']],
    ['folder.tags', ['select', 'alter', 'drop']],
    ['folder.statistics', ['select']],
    ['folder.history', ['select']],
    ['folder.snapshots', ['select']],
    ['snapshot', ['select']],
    ['detail.table', ['select']],
    ['viewColumn', ['select']],
    ['folder.viewColumns', ['select']],
    ['connection.disconnected', []],
    ['connection.error', []],
    ['detail', []],
    ['message', []],
  ];

  it('offer exactly the verbs of the design for every kind of node, and the submenu only where there is one', () => {
    for (const [contextValue, expected] of DESIGN) {
      expect(verbs(contextValue), contextValue).toEqual([...expected].toSorted());
      expect(shownOn(opener?.when, contextValue), `the submenu on ${contextValue}`).toBe(expected.length > 0);
    }
  });
});
