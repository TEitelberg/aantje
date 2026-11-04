import { LIST_ROWS } from '../../src/shell/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityKind } from '../../src/activity/kind';
import { activityMarkdown } from '../../src/activity/markdown';
import { AUTHOR_EXAMPLE, AUTHOR_HINT, activityOlderNote } from '../../src/activity/model';
import type { ActivityData } from '../../src/activity/model';
import { POINT_KINDS } from '../../src/snapshot-report/model';
import { editedCatalogs } from '../support/edited-catalog';
import { historyActivity } from './activity-support';
import { snapshot, tableChange } from './snapshot-report-support';

const DAY_ROWS = 100;
const MAX_AUTHORS = 50;

const catalogs = editedCatalogs();
afterAll(() => catalogs.dispose());

let data: ActivityData;
beforeAll(async () => {
  data = await historyActivity(catalogs);
});

const everything = { kinds: POINT_KINDS, text: '', range: { from: 0, to: 56 } };

describe('the Activity as a Markdown document', () => {
  it('writes the days, authors, tables and snapshots of three commits, with the hint for the missing authors', () => {
    expect(activityMarkdown(data, { ...everything, range: { from: 24, to: 26 } })).toBe(
      [
        '# Activity of History',
        '',
        '| Property | Value |',
        '| --- | --- |',
        '| Snapshots read | 57 (latest in the catalog @56) |',
        '| Author | all |',
        '| Table | all |',
        '| Kinds of change | all |',
        '| Message | all |',
        '| Range | @24 to @26 |',
        '| Snapshots listed | 3 of 57 |',
        '',
        AUTHOR_HINT,
        '',
        `\`${AUTHOR_EXAMPLE}\``,
        '',
        '## Commits per day',
        '',
        '| Day (UTC) | Commits | Insert (changes) | Update (changes) | Delete (changes) | Schema change (changes) | Maintenance (changes) |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        '| 2026-10-22 | 3 | 1 | 0 | 0 | 2 | 0 |',
        '',
        '## Authors',
        '',
        '| Author | Commits | First | Latest | Latest message |',
        '| --- | --- | --- | --- | --- |',
        '| (no author) | 2 | 2026-10-22 10:24:00 | 2026-10-22 10:26:00 |  |',
        '| `tillmann` | 1 | 2026-10-22 10:25:00 | 2026-10-22 10:25:00 | `Nightly import` |',
        '',
        '## Most changed tables',
        '',
        '| Table | Changes | Insert | Update | Delete | Schema change | Maintenance |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        '| `main.evolved` | 1 | 0 | 0 | 0 | 1 | 0 |',
        '| `shop.audit` | 1 | 0 | 0 | 0 | 1 | 0 |',
        '| `shop.customers` | 1 | 1 | 0 | 0 | 0 | 0 |',
        '',
        '## Snapshots',
        '',
        '| Snapshot | Time (UTC) | Author | Message | Changes |',
        '| --- | --- | --- | --- | --- |',
        '| @26 | 2026-10-22 10:26:00 |  |  | `main.evolving` Created table |',
        '| @25 | 2026-10-22 10:25:00 | `tillmann` | `Nightly import` | `shop.customers` Inserted into table |',
        '| @24 | 2026-10-22 10:24:00 |  |  | `shop.audit` Created table, Inserted into table |',
        '',
      ].join('\n'),
    );
  });

  it('shows what the filters leave and names them', () => {
    const text = activityMarkdown(data, {
      author: 'tillmann',
      table: 't9',
      kinds: ['insert', 'delete'],
      text: 'NIGHTLY',
      range: { from: 0, to: 56 },
    });
    expect(text).toContain('| Author | `tillmann` |');
    expect(text).toContain('| Table | `shop.customers` |');
    expect(text).toContain('| Kinds of change | Insert, Delete |');
    expect(text).toContain('| Message | `NIGHTLY` |');
    expect(text).toContain('| Snapshots listed | 1 of 57 |');
    expect(text).not.toContain(AUTHOR_HINT);
    expect(text).toContain('| @25 | 2026-10-22 10:25:00 | `tillmann` | `Nightly import` |');
  });

  it('fits a view to the data: an author or table that is not there and a range outside the snapshots are dropped or held inside', () => {
    const text = activityMarkdown(data, {
      author: 'nobody',
      table: 't999',
      kinds: [...POINT_KINDS, 'exploded' as never],
      text: '',
      range: { from: -5, to: 9999 },
    });
    expect(text).toContain('| Author | all |');
    expect(text).toContain('| Table | all |');
    expect(text).toContain('| Kinds of change | all |');
    expect(text).toContain('| Range | @0 to @56 |');
    expect(text).toContain('| Snapshots listed | 57 of 57 |');
  });

  it('without a view shows everything that was read', () => {
    expect(activityMarkdown(data)).toBe(activityMarkdown(data, everything));
  });

  it('says so when the filters leave nothing, and when older snapshots were not read', () => {
    const none = activityMarkdown(data, { ...everything, text: 'zzz' });
    expect(none.match(/No snapshot is left by the filters\./g)).toHaveLength(3);
    expect(none).toContain('No table was changed by the snapshots that the filters leave.');
    const older = activityMarkdown({ ...data, more: true });
    expect(older).toContain(activityOlderNote(data));
    expect(activityMarkdown(data)).not.toContain('Older ones are not read');
    expect(activityMarkdown({ ...data, snapshots: [] })).toContain('| Range | none |');
  });

  it('cuts the snapshots and the days and counts the others', () => {
    const many: ActivityData = {
      ...data,
      snapshots: Array.from({ length: 250 }, (_, index) => ({
        ...snapshot(index, [tableChange(3, 'inserted')]),
        time: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
      })),
    };
    const text = activityMarkdown(many);
    const rows = text.split('\n').filter((line) => line.startsWith('| @'));
    expect(rows).toHaveLength(LIST_ROWS);
    expect(text).toContain('… 50 more omitted (limit: 200).');
    expect(text.split('\n').filter((line) => /^\| 2026-\d\d-\d\d \|/.test(line))).toHaveLength(DAY_ROWS);
    expect(text).toContain('… 150 more omitted (limit: 100).');
  });

  it('lists the newest days when it cuts the days, and says in a cell every table a snapshot changed and what else it did', () => {
    const many: ActivityData = {
      ...data,
      snapshots: Array.from({ length: 250 }, (_, index) => ({
        ...snapshot(index, [tableChange(3, 'inserted')]),
        time: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
      })),
    };
    const days = activityMarkdown(many)
      .split('\n')
      .filter((line) => /^\| 2026-\d\d-\d\d \|/.test(line))
      .map((line) => line.slice(2, 12));
    expect(days[0]).toBe('2026-09-07');
    expect(days.at(-1)).toBe('2026-05-31');

    const mixed: ActivityData = {
      ...data,
      snapshots: [
        snapshot(1, [
          tableChange(3, 'inserted', 'shop', 'a'),
          tableChange(4, 'inserted', 'shop', 'b'),
          {
            action: 'created',
            object: 'schema',
            objectId: 2,
            schemaName: null,
            name: 'sales',
            raw: 'created_schema:"sales"',
          },
        ]),
      ],
    };
    const row = activityMarkdown(mixed)
      .split('\n')
      .find((line) => line.startsWith('| @1 |'));
    expect(row).toBe(
      '| @1 | 2026-11-01 00:00:01 |  |  | `shop.a` Inserted into table; `shop.b` Inserted into table; `Created schema sales` |',
    );
  });

  it('says how many tables the document leaves out of the most changed ones', () => {
    const many: ActivityData = {
      ...data,
      snapshots: Array.from({ length: 21 }, (_, index) =>
        snapshot(index, [tableChange(index + 1, 'inserted', 'shop', `t${String(index).padStart(2, '0')}`)]),
      ),
    };
    const text = activityMarkdown(many);
    expect(text).toContain('1 table not shown: the 20 most changed are drawn.');
    expect(text.split('\n').filter((line) => line.startsWith('| `shop.t'))).toHaveLength(20);
  });

  it('lists the 50 authors with the most commits and says that there are more', () => {
    const many: ActivityData = {
      ...data,
      snapshots: Array.from({ length: 60 }, (_, index) =>
        snapshot(index, [tableChange(3, 'inserted')], { author: `author_${String(index).padStart(2, '0')}` }),
      ),
    };
    const text = activityMarkdown(many);
    expect(text.split('\n').filter((line) => line.startsWith('| `author_'))).toHaveLength(MAX_AUTHORS);
    expect(text).toContain('10 authors not shown: the 50 with the most commits are listed.');
  });

  it('writes authors, messages, tables and the connection from the catalog as code or escaped text', () => {
    const hostile = '<img src=x onerror=alert(1)> | `pipe`\n# heading';
    const text = activityMarkdown({
      connection: hostile,
      scope: { kind: 'lake' },
      latest: 1,
      more: false,
      snapshots: [
        snapshot(1, [tableChange(7, 'inserted', hostile, hostile)], {
          author: hostile,
          commitMessage: hostile,
        }),
      ],
    });
    const [title, afterTitle] = text.split('\n');
    expect(title).not.toMatch(/(^|[^\\])[<>`|]/);
    expect(afterTitle).toBe('');
    expect(text).not.toMatch(/^# heading/m);
    // A pipe of the catalog is escaped, so every row of a table has as many cells as its heading.
    const cells = (line: string): number => line.split(/(?<!\\)\|/).length;
    const tables = text.split('\n\n').filter((block) => block.startsWith('| '));
    expect(tables).toHaveLength(5);
    for (const table of tables) {
      expect(new Set(table.trimEnd().split('\n').map(cells)).size, table).toBe(1);
    }
    expect(text).toContain('<img src=x onerror=alert(1)> \\| `pipe` # heading');
    expect(text).not.toContain(AUTHOR_HINT);
  });
});

describe('the Activity as a report of the shell', () => {
  it('names its view type, builds the message of the page, and writes the document through the function above', () => {
    expect(activityKind.viewType).toBe('aantje.activity');
    expect(activityKind.message(data)).toEqual({ type: 'activity', data });
    expect(activityKind.toMarkdown(data, undefined)).toBe(activityMarkdown(data));
    expect(activityKind.css).toContain('.chart');
  });

  it('takes the actions and the view of its protocol and nothing else', () => {
    expect(activityKind.isAction?.({ type: 'action', action: 'showSnapshotReport' })).toBe(true);
    expect(activityKind.isAction?.({ type: 'action', action: 'showLatest' })).toBe(false);
    expect(activityKind.isView?.(everything)).toBe(true);
    expect(activityKind.isView?.({ filter: '' })).toBe(false);
  });
});
