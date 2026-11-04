import { afterAll, describe, expect, it } from 'vitest';
import { dependenciesMarkdown } from '../../src/dependencies/markdown';
import { lakeData, objectData, readGraph } from '../../src/dependencies/read';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID } from '../support/expected-history';
import { historyFixture } from '../support/sources/history';
import { SHOP, addMacro, addView, sharedParser } from './dependencies-support';

const MARKDOWN_ROWS = 200;
const MARKDOWN_OBJECTS = 100;
const MARKDOWN_NAMES = 50;
const MARKDOWN_ISSUES = 100;

const catalogs = editedCatalogs();
const parser = sharedParser();
afterAll(async () => {
  await catalogs.dispose();
  await parser.dispose();
});

/** Names that try to break a table, a heading or a code span. */
const HOSTILE = 'v|ev`il\n# x';
const CONNECTION = 'My | Lake\n# bad';

const edits = [
  addView(100, SHOP, HOSTILE, 'SELECT * FROM big_events'),
  addView(101, SHOP, 'v_gone', 'SELECT * FROM old_stuff, "we|ird" '),
  addView(102, SHOP, 'v_spark', 'SELECT 1', 'sp|ark `x`'),
  ...addMacro(103, SHOP, 'uses_gross', 'scalar', '(shop.gross(x))'),
];

const graph = await readGraph(await catalogs.open(historyFixture.sqlite, ...edits), parser, 56);
const events = objectData(graph, CONNECTION, 56, { kind: 'table', id: HISTORY_ID.events });
const lake = lakeData(graph, 'Lake', 56);
if (!events) {
  throw new Error('The table is there.');
}

describe('the Markdown document of the report of an object', () => {
  it('shows who uses the table level by level, what a drop breaks and that nothing is broken, with the names as code', () => {
    expect(dependenciesMarkdown(events)).toBe(
      [
        '# Dependencies of shop\\.events',
        '',
        'Read from My \\| Lake \\# bad at snapshot @56.',
        '',
        '| Property | Value |',
        '| --- | --- |',
        '| Object | `shop.events` |',
        '| Kind | table |',
        '| Direction | both |',
        '| Depth | 5 |',
        '',
        '## Used by',
        '',
        '| Depth | Object | Kind | Edge |',
        '| --- | --- | --- | --- |',
        '| 1 | `shop.big_events` | view | reads `shop.events` |',
        '| 2 | ``shop.v\\|ev`il # x`` | view | reads `shop.big_events` |',
        '| 1 | `shop.recent_events` | table macro | reads `shop.events` |',
        '',
        '## Depends on',
        '',
        'This object uses no table, view or macro.',
        '',
        '## If you drop `shop.events`',
        '',
        'Dropping `shop.events` breaks 3 objects: 2 views, 1 table macro.',
        '',
        '- `shop.big_events`',
        '- `shop.recent_events`',
        '- ``shop.v\\|ev`il # x``',
        '',
        '## Broken references',
        '',
        'No object names something that the lake does not have.',
        '',
        '## Not followed',
        '',
        'Every text was read.',
        '',
      ].join('\n'),
    );
  });

  it('shows the direction and the depth of the page, and only the objects it lists', () => {
    const text = dependenciesMarkdown(events, { direction: 'usedBy', depth: 1, text: 'ignored' });
    expect(text).toContain('| Direction | Used by |');
    expect(text).toContain('| Depth | 1 |');
    expect(text).not.toContain('| 2 |');
    expect(text.match(/^## /gm)).toHaveLength(4);
    expect(text).not.toContain('## Depends on');
    // The drop still counts everything behind the depth, the second level included.
    expect(text).toContain('breaks 3 objects');
  });

  it('holds a depth that is out of range inside 1 to 5', () => {
    expect(dependenciesMarkdown(events, { direction: 'usedBy', depth: 99, text: '' })).toContain(
      '| Depth | 5 |',
    );
    expect(dependenciesMarkdown(events, { direction: 'usedBy', depth: -4, text: '' })).toContain(
      '| Depth | 1 |',
    );
  });

  it('names the broken references and the unresolved texts of the objects listed, not of the others', () => {
    const gone = objectData(graph, 'Lake', 56, { kind: 'view', id: 101 });
    const text = gone ? dependenciesMarkdown(gone) : '';
    expect(text).toContain('| `shop.v_gone` | `shop.old_stuff` | table or view |');
    expect(text).toContain('| `shop.v_gone` | `shop.we\\|ird` | table or view |');
    const spark = objectData(graph, 'Lake', 56, { kind: 'view', id: 102 });
    expect(spark && dependenciesMarkdown(spark)).toContain(
      '| `shop.v_spark` | Stored in another SQL dialect, which is not read: | `` sp\\|ark `x` `` |',
    );
    expect(dependenciesMarkdown(events)).not.toContain('v_gone');
  });

  it('names the broken reference of a view that the lists name, in the document of the object it reads', async () => {
    const mixed = await readGraph(
      await catalogs.open(
        historyFixture.sqlite,
        addView(100, SHOP, 'v_both', 'SELECT * FROM events, old_stuff'),
      ),
      parser,
      56,
    );
    const table = objectData(mixed, 'Lake', 56, { kind: 'table', id: HISTORY_ID.events });
    expect(table && dependenciesMarkdown(table)).toContain(
      '| `shop.v_both` | `shop.old_stuff` | table or view |',
    );
  });

  it('writes a cycle, and an object that nothing uses', async () => {
    const cyclic = await readGraph(
      await catalogs.open(
        historyFixture.sqlite,
        addView(100, SHOP, 'ping', 'SELECT * FROM pong'),
        addView(101, SHOP, 'pong', 'SELECT * FROM ping'),
      ),
      parser,
      56,
    );
    const ping = objectData(cyclic, 'Lake', 56, { kind: 'view', id: 100 });
    expect(ping && dependenciesMarkdown(ping)).toContain(
      'The dependencies contain a cycle; each object is listed once.',
    );
    const recent = objectData(cyclic, 'Lake', 56, { kind: 'tableMacro', id: HISTORY_ID.recentEventsMacro });
    const text = recent ? dependenciesMarkdown(recent) : '';
    expect(text).toContain(
      'Nothing in this lake uses `shop.recent_events`; dropping it breaks no view or macro.',
    );
    expect(text).toContain('| 1 | `shop.events` | table | read by `shop.recent_events` |');
  });

  it('cuts the names of a drop at 50, and says how many were left out', async () => {
    const many = Array.from({ length: MARKDOWN_NAMES + 7 }, (_, i) =>
      addView(300 + i, SHOP, `w${String(i).padStart(3, '0')}`, 'SELECT * FROM events'),
    );
    const wide = await readGraph(await catalogs.open(historyFixture.sqlite, ...many), parser, 56);
    const data = objectData(wide, 'Lake', 56, { kind: 'table', id: HISTORY_ID.events });
    const text = data ? dependenciesMarkdown(data) : '';
    expect(text.match(/^- `/gm)).toHaveLength(MARKDOWN_NAMES);
    expect(text).toContain(`… 9 more omitted (limit: ${MARKDOWN_NAMES}).`);
  });
});

describe('the limits of the document', () => {
  it('keeps the numbers that the documentation states', () => {
    expect([MARKDOWN_OBJECTS, MARKDOWN_NAMES, MARKDOWN_ISSUES, MARKDOWN_ROWS]).toEqual([100, 50, 100, 200]);
  });

  it.each([
    [MARKDOWN_ISSUES, false],
    [MARKDOWN_ISSUES + 1, true],
  ])('cuts %i broken references of the lake only when there are more than the limit', async (count, cut) => {
    const views = Array.from({ length: count }, (_, i) =>
      addView(300 + i, SHOP, `w${String(i).padStart(3, '0')}`, `SELECT * FROM missing_${i}`),
    );
    const broken = await readGraph(await catalogs.open(historyFixture.sqlite, ...views), parser, 56);
    const text = dependenciesMarkdown(lakeData(broken, 'Lake', 56));
    expect(text.includes(`… 1 more omitted (limit: ${MARKDOWN_ISSUES}).`)).toBe(cut);
  });
});

describe('the Markdown document of the report of the lake', () => {
  it('lists the objects that most others use first, with the problems of the whole lake', () => {
    const text = dependenciesMarkdown(lake);
    expect(text).toContain('# Dependencies in Lake');
    expect(text).toContain('| Objects with dependencies | 8 |');
    expect(text).toContain(
      [
        '| Object | Kind | Used by | Depends on |',
        '| --- | --- | --- | --- |',
        '| `shop.events` | table | 2 | 0 |',
        '| `shop.big_events` | view | 1 | 1 |',
        '| `shop.gross` | scalar macro | 1 | 0 |',
      ].join('\n'),
    );
    expect(text).toContain('| ``shop.v\\|ev`il # x`` | view | 0 | 1 |');
    expect(text).toContain('| `shop.v_gone` | `shop.old_stuff` | table or view |');
  });

  it('keeps the filter of the page, and says so when nothing matches', () => {
    const text = dependenciesMarkdown(lake, { direction: 'usedBy', depth: 5, text: ' GROSS ' });
    expect(text).toContain('| Filter | `GROSS` |');
    expect(text).toContain('| `shop.uses_gross` | scalar macro | 0 | 1 |');
    expect(text).not.toContain('`shop.events` | table');
    expect(dependenciesMarkdown(lake, { direction: 'usedBy', depth: 5, text: 'nothing like it' })).toContain(
      'No object matches the filter.',
    );
  });

  it('cuts the list and the problems at their limits', async () => {
    const views = Array.from({ length: MARKDOWN_OBJECTS + MARKDOWN_ISSUES + 5 }, (_, i) =>
      addView(300 + i, SHOP, `w${String(i).padStart(3, '0')}`, `SELECT * FROM missing_${i}`),
    );
    const broken = await readGraph(await catalogs.open(historyFixture.sqlite, ...views), parser, 56);
    const text = dependenciesMarkdown(lakeData(broken, 'Lake', 56));
    // 208 objects take part: the document lists 100 and counts the 108 others in one note; 205 broken references, 100.
    expect(text).toContain(`… 108 more omitted (limit: ${MARKDOWN_OBJECTS}).`);
    expect(text).not.toContain('(limit: 200)');
    expect(text).toContain(`… 105 more omitted (limit: ${MARKDOWN_ISSUES}).`);
  });
});
