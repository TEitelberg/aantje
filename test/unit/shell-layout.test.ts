import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityKind } from '../../src/activity/kind';
import { advisorKind } from '../../src/advisor/kind';
import { dependenciesKind } from '../../src/dependencies/kind';
import { growthKind } from '../../src/growth/kind';
import { GRID_CSS } from '../../src/grid/style';
import { healthKind } from '../../src/health-report/kind';
import { propertiesKind } from '../../src/properties-report/kind';
import { snapshotReportKind } from '../../src/snapshot-report/kind';
import { schemaHistoryKind } from '../../src/schema-history/kind';
import { statisticsKind } from '../../src/stats/kind';
import { storageKind } from '../../src/storage-report/kind';
import { LAYOUT_CSS, SHELL_CSS } from '../../src/shell/style';
import { pageKinds } from '../../src/shell/kinds';
import { editedCatalogs } from '../support/edited-catalog';
import type { FakeNode } from '../support/fake-dom';
import { buildClientBundle, startPage } from '../support/page-harness';
import { historyActivity } from './activity-support';

const REPORT_KINDS = {
  statistics: statisticsKind,
  report: snapshotReportKind,
  properties: propertiesKind,
  schemaHistory: schemaHistoryKind,
  activity: activityKind,
  storage: storageKind,
  health: healthKind,
  advisor: advisorKind,
  dependencies: dependenciesKind,
  growth: growthKind,
};

const REPORT_SHEETS = {
  statistics: statisticsKind.css,
  report: snapshotReportKind.css,
  properties: propertiesKind.css,
  schemaHistory: schemaHistoryKind.css,
  activity: activityKind.css,
  storage: storageKind.css,
  health: healthKind.css,
  advisor: advisorKind.css,
  dependencies: dependenciesKind.css,
  growth: growthKind.css,
};
const SHEETS = { ...REPORT_SHEETS, shell: SHELL_CSS, grid: GRID_CSS };

interface Rule {
  readonly selectors: readonly string[];
  readonly declarations: ReadonlyMap<string, string>;
}

function rulesOf(css: string): Rule[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector = '', body = '']) => ({
    selectors: selector.split(',').map((part) => part.trim().replace(/\s+/g, ' ')),
    declarations: new Map(
      body
        .split(';')
        .map((declaration) => declaration.split(/:(.*)/s))
        .filter(([name]) => name?.trim())
        .map(([name = '', value = '']) => [name.trim(), value.trim()] as const),
    ),
  }));
}

/** The value of a length of the sheet in pixels: a token of the shell (`var(--aantje-...)`) or a number. */
function pixels(css: string, value: string): number {
  const token = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  if (token) {
    return pixels(css, new RegExp(`${token}:\\s*([^;]+);`).exec(css)?.[1]?.trim() ?? '');
  }
  const number = parseFloat(value);
  return Number.isNaN(number) ? 0 : number;
}

/**
 * The margin of a block on one side, as the sheet declares it for an element given as `tag.class.class`: the last rule
 * whose compound selector (no descendants) fits the element and declares that side wins. Not a full cascade, which the
 * rules of the pages do not need.
 */
function margin(css: string, element: string, side: 'top' | 'bottom'): number {
  const [tag = '', ...classes] = element.split('.');
  const fits = (selector: string): boolean => {
    const [selectorTag = '', ...selectorClasses] = selector.split('.');
    return (
      !/[\s>+~:[]/.test(selector) &&
      (selectorTag === '' || selectorTag === tag) &&
      selectorClasses.every((name) => classes.includes(name))
    );
  };
  let found = 0;
  for (const rule of rulesOf(css)) {
    if (!rule.selectors.some(fits)) continue;
    const longhand = rule.declarations.get(`margin-${side}`);
    const shorthand = rule.declarations.get('margin')?.split(/\s+(?![^(]*\))/);
    const value = longhand ?? (shorthand ? shorthand[side === 'top' ? 0 : shorthand[2] ? 2 : 0] : undefined);
    if (value !== undefined) found = pixels(css, value);
  }
  return found;
}
const marginBottom = (css: string, element: string): number => margin(css, element, 'bottom');

describe('the layout shared by all pages', () => {
  it('defines the spacing tokens once, carries them in every stylesheet, and pads the container with the gutter', () => {
    expect(LAYOUT_CSS.match(/--aantje-gutter:/g)).toHaveLength(1);
    for (const token of ['--aantje-gutter', '--aantje-section-gap']) {
      expect(LAYOUT_CSS, token).toContain(`${token}:`);
    }
    for (const [name, css] of Object.entries(SHEETS)) {
      expect(css, `${name} has the tokens of the shell`).toContain(LAYOUT_CSS);
      expect(css.match(/--aantje-gutter:/g), `${name} defines the gutter once`).toHaveLength(1);
      const container = rulesOf(css).filter((rule) => rule.selectors.includes('.app'));
      expect(
        container.map((rule) => rule.declarations.get('padding')),
        name,
      ).toContain('var(--aantje-gutter)');
    }
  });

  it('keeps one section gap below a row of cards and above every heading, in every report', () => {
    // The gap is one rule on `.cards`; the margin above a following block can only add to it (adjacent margins collapse).
    for (const [name, css] of Object.entries(REPORT_SHEETS)) {
      expect(marginBottom(css, 'div.cards'), name).toBeGreaterThanOrEqual(16);
      expect(margin(css, 'h2', 'top'), `${name}: h2`).toBe(16);
    }
  });

  it('lays four cards to a row when the page asks for it, and two on a narrow page', () => {
    const four = rulesOf(SHELL_CSS).find((rule) => rule.selectors.includes('.cards.cards-4'));
    expect(four?.declarations.get('grid-template-columns')).toBe('repeat(4, minmax(0, 1fr))');
    expect(SHELL_CSS).toMatch(
      /@media \(max-width: 760px\) \{ \.cards\.cards-4 \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \} \}/,
    );
  });
});

describe('the headings of a page that puts its blocks in wrappers', () => {
  const catalogs = editedCatalogs();
  let bundle: string;
  let activity: Awaited<ReturnType<typeof historyActivity>>;
  beforeAll(async () => {
    bundle = await buildClientBundle();
    activity = await historyActivity(catalogs);
  });
  afterAll(() => catalogs.dispose());

  /** The nodes from `from` down to `target`, or nothing when `target` is not below `from`. */
  function pathTo(from: FakeNode, target: FakeNode): FakeNode[] {
    if (from === target) return [from];
    for (const child of from.children) {
      const below = pathTo(child, target);
      if (below.length > 0) return [from, ...below];
    }
    return [];
  }

  /** The declarations of the rules whose compound selector (tag and classes) fits the node; the last rule wins. */
  function declared(css: string, node: FakeNode): Map<string, string> {
    const result = new Map<string, string>();
    for (const rule of rulesOf(css)) {
      const fits = rule.selectors.some((selector) => {
        const [tag = '', ...classes] = selector.split('.');
        return (
          !/[\s>+~:[]/.test(selector) &&
          (tag === '' || tag === node.tag) &&
          classes.every((name) => node.hasClass(name))
        );
      });
      if (fits) rule.declarations.forEach((value, property) => result.set(property, value));
    }
    return result;
  }

  /** The margin above the last node of `path` (a heading) after the rules of the sheet, for the selector forms that a heading has. */
  function headingMargin(css: string, path: FakeNode[]): number {
    const heading = path.at(-1);
    const parent = path.at(-2);
    let found = 0;
    for (const rule of rulesOf(css)) {
      const fits = rule.selectors.some(
        (selector) =>
          selector === 'h2' ||
          (selector === 'main > h2:first-child' &&
            parent?.tag === 'main' &&
            parent.children[0] === heading) ||
          (/^\.[\w-]+ h2$/.test(selector) &&
            path.slice(0, -1).some((node) => node.hasClass(selector.slice(1, -3)))),
      );
      const top =
        rule.declarations.get('margin-top') ?? rule.declarations.get('margin')?.split(/\s+(?![^(]*\))/)[0];
      if (fits && top !== undefined) found = pixels(css, top);
    }
    return found;
  }

  // What keeps the margin of a block inside it, so that it cannot collapse through (CSS 2.1, 8.3.1): a border or padding
  // above the content, a box that makes a formatting context of its own (flex, grid, float, scrolling, positioned).
  const CONTAINS = ['padding', 'padding-top', 'border', 'border-top', 'float', 'overflow', 'overflow-y'];
  const keepsMargins = (rules: Map<string, string>): string[] =>
    [...CONTAINS, 'display', 'position'].filter((property) => {
      const value = rules.get(property);
      if (value === undefined) return false;
      if (property === 'display') return /flex|grid|flow-root|inline-block|table/.test(value);
      if (property === 'position') return /absolute|fixed|sticky/.test(value);
      return !/^(none|visible|0|0px)$/.test(value);
    });

  /**
   * Every h2 of the page has one section gap above it, whichever wrapper starts with it: its own margin is the gap, and
   * no wrapper between the heading and `main` keeps that margin inside. The first heading of `main` has none.
   */
  function expectGaps(label: string, page: ReturnType<typeof startPage>): void {
    const css = activityKind.css;
    for (const heading of page.app().byTag('h2')) {
      const path = pathTo(page.app(), heading);
      const wrappers = path.slice(path.findIndex((node) => node.tag === 'main') + 1, -1);
      const name = `${label}: "${heading.textContent}"`;
      if (wrappers.length > 0 || path.at(-2)?.children[0] !== heading) {
        expect(headingMargin(css, path), `${name} has no section gap above it`).toBeGreaterThanOrEqual(16);
      }
      for (const wrapper of wrappers) {
        expect(
          keepsMargins(declared(css, wrapper)),
          `${name}: <${wrapper.tag} class="${wrapper.className}"> keeps the margin of its first heading inside`,
        ).toEqual([]);
      }
    }
  }

  it('keeps the section gap above every heading of the Activity page, in sections that start with one', () => {
    const page = startPage(bundle);
    page.send({ type: 'activity', data: activity });
    // The reported case: sections that start with a heading and follow cards, notes and charts.
    const starting = page
      .app()
      .byTag('section')
      .filter((section) => section.children[0]?.tag === 'h2');
    expect(starting.map((section) => section.className)).toEqual([
      'days',
      'authors',
      'tables-section',
      'list',
    ]);
    expectGaps('all snapshots', page);

    page.app().byClass('pick')[0]?.fire('click');
    expect(page.app().byClass('detail')[0]?.children[0]?.tag).toBe('h2');
    expectGaps('a snapshot selected', page);

    const search = page.app().find((node) => node.tag === 'input' && node.type === 'search')[0];
    if (!search) throw new Error('the page has no search field');
    search.value = 'no such message';
    search.fire('input');
    expect(page.app().byClass('empty').length).toBeGreaterThan(0);
    expectGaps('nothing matches', page);
  });
});

describe('the container of the pages of the shell', () => {
  let bundle: string;
  beforeAll(async () => {
    bundle = await buildClientBundle();
  });

  // The message type of each report kind that the extension has a panel for.
  const TYPES = Object.values(REPORT_KINDS).map(
    (kind) => (kind.message(undefined as never) as { type: string }).type,
  );

  it('keeps everything of a page that cannot read its data in the one container, which is built before any report', () => {
    expect(startPage(bundle).app().className).toBe('app');
    for (const type of TYPES) {
      const page = startPage(bundle);
      page.send({ type, data: 'not the data of this report' });
      expect(page.app().className, type).toBe('app');
      expect(page.app().textContent, type).not.toBe('Reading...');
    }
    // A page for every report kind that has a panel, and for no other.
    expect(pageKinds.map(({ type }) => type).sort()).toEqual([...TYPES].sort());
  });
});
