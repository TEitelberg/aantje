import { LIST_ROWS } from '../../src/shell/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { growthKind } from '../../src/growth/kind';
import { growthMarkdown } from '../../src/growth/markdown';
import {
  APPROXIMATE_NOTE,
  EXPIRED_NOTE,
  INLINED_FAILED_NOTE,
  INLINED_NOTE,
  NO_DATA_NOTE,
  growthOlderNote,
} from '../../src/growth/model';
import type { GrowthData } from '../../src/growth/model';
import { readGrowth } from '../../src/growth/read';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID } from '../support/expected-history';
import { historyFixture } from '../support/sources/history';
import { historyGrowth } from './growth-support';
import { snapshot, tableChange } from './snapshot-report-support';

const catalogs = editedCatalogs();
afterAll(() => catalogs.dispose());

let data: GrowthData;
beforeAll(async () => {
  data = await historyGrowth(catalogs, { authors: [[40, 44, 'ann', 'Backfill']] });
});

/** Three snapshots and two tables, so that the whole document can be compared as text. */
const small: GrowthData = {
  connection: 'Small',
  scope: { kind: 'lake' },
  focus: null,
  latest: 2,
  snapshots: [
    snapshot(2, [tableChange(2, 'deleted', 'shop', 'b')], { author: 'ann', commitMessage: 'Clean | up' }),
    snapshot(1, [tableChange(1, 'inserted', 'shop', 'a')]),
    snapshot(0, [tableChange(1, 'created', 'shop', 'a'), tableChange(2, 'created', 'shop', 'b')]),
  ],
  more: false,
  tables: [
    { id: 1, schema: 'shop', name: 'a' },
    { id: 2, schema: 'shop', name: 'b' },
  ],
  changes: [
    { tableId: 1, snapshot: 1, rows: 10, sizeBytes: 2048, files: 1, partialFiles: 0 },
    { tableId: 2, snapshot: 0, rows: 5, sizeBytes: 1024, files: 1, partialFiles: 0 },
    { tableId: 2, snapshot: 2, rows: -5, sizeBytes: -1024, files: -1, partialFiles: 0 },
  ],
  inlinedMore: false,
  inlinedFailed: false,
};

describe('the Growth report as a Markdown document', () => {
  it('writes the summary and the snapshots with value and change, newest first, for the whole lake', () => {
    expect(growthMarkdown(small)).toBe(
      [
        '# Growth of Small',
        '',
        '| Property | Value |',
        '| --- | --- |',
        '| Table | all tables |',
        '| Value | Live rows |',
        '| Snapshots read | 3 (latest in the catalog @2) |',
        '',
        '## Summary',
        '',
        '| Figure | Value |',
        '| --- | --- |',
        '| First | 5 at @0 (2026-11-01 00:00:00) |',
        '| Last | 10 at @2 (2026-11-01 00:00:02) |',
        '| Highest | 15 at @1 (2026-11-01 00:00:01) |',
        '| Largest increase | +10 at @1 (2026-11-01 00:00:01) |',
        '| Largest decrease | -5 at @2 (2026-11-01 00:00:02) |',
        '',
        '## Snapshots',
        '',
        '| Snapshot | Time (UTC) | Live rows | Change | Changed the table | Author | Message |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        '| @2 | 2026-11-01 00:00:02 | 10 | -5 | yes | `ann` | `Clean \\| up` |',
        '| @1 | 2026-11-01 00:00:01 | 15 | +10 | yes |  |  |',
        '| @0 | 2026-11-01 00:00:00 | 5 | +5 | yes |  |  |',
        '',
      ].join('\n'),
    );
  });

  it('writes the table and the value that were chosen, with sizes in units', () => {
    const text = growthMarkdown(small, { table: 1, metric: 'bytes' });

    expect(text).toContain('| Table | `shop.a` |');
    expect(text).toContain('| Value | Data size |');
    expect(text).toContain('| Highest | 2 KB at @1 (2026-11-01 00:00:01) |');
    expect(text).toContain('| Largest decrease | none |');
    expect(text).toContain('| @1 | 2026-11-01 00:00:01 | 2 KB | +2 KB | yes |  |  |');
    expect(text).toContain('| @2 | 2026-11-01 00:00:02 | 2 KB | 0 | no | `ann` | `Clean \\| up` |');
  });

  it('writes the exact numbers of the history fixture for one table and each value', () => {
    const rows = growthMarkdown(data, { table: HISTORY_ID.customers, metric: 'rows' });
    expect(rows).toContain('| Table | `shop.customers` |');
    expect(rows).toContain('| First | 0 at @0 (2026-10-20 10:00:00) |');
    expect(rows).toContain('| Highest | 5 at @25 (2026-10-22 10:25:00) |');
    expect(rows).toContain('| Largest increase | +4 at @16 (2026-10-21 10:16:00) |');
    expect(rows).toContain('| Largest decrease | -1 at @17 (2026-10-21 10:17:00) |');
    expect(rows).toContain('| @17 | 2026-10-21 10:17:00 | ~3 | -1 | yes |  |  |');
    expect(rows).toContain('| @25 | 2026-10-22 10:25:00 | 5 | +1 | yes | `tillmann` | `Nightly import` |');
    expect(rows).toContain(APPROXIMATE_NOTE);

    const files = growthMarkdown(data, { table: HISTORY_ID.events, metric: 'files' });
    expect(files).toContain('| @10 | 2026-10-21 10:10:00 | 8 | +3 | yes |  |  |');
    expect(files).not.toContain(APPROXIMATE_NOTE);
  });

  it('names a dropped table and goes with all tables for a table that the data does not have', () => {
    expect(growthMarkdown(data, { table: HISTORY_ID.oldStuff, metric: 'rows' })).toContain(
      '| Table | `shop.old_stuff (dropped)` |',
    );
    expect(growthMarkdown(data, { table: 999, metric: 'rows' })).toContain('| Table | all tables |');
    expect(growthMarkdown(data, { metric: 'nothing' as never })).toContain('| Value | Live rows |');
  });

  it('says that older snapshots were not read, that snapshots expired, that inlined rows were left out, and that nothing changed', async () => {
    const newest = await readGrowth(
      await catalogs.open(historyFixture.sqlite),
      'History',
      null,
      undefined,
      3,
    );
    expect(growthMarkdown(newest)).toContain(growthOlderNote(newest));

    const expired = await readGrowth(await catalogs.open(historyFixture.expired), 'Expired', null);
    expect(growthMarkdown(expired)).toContain(EXPIRED_NOTE);
    expect(growthMarkdown(expired)).toContain('| @55 | ');

    expect(growthMarkdown({ ...small, inlinedMore: true })).toContain(INLINED_NOTE);
    expect(growthMarkdown({ ...small, inlinedFailed: true })).toContain(INLINED_FAILED_NOTE);
    expect(growthMarkdown(small)).not.toContain(INLINED_FAILED_NOTE);
    expect(
      growthMarkdown({
        ...small,
        snapshots: small.snapshots.map((one) => ({ ...one, changes: [] })),
        changes: [],
      }),
    ).toContain(NO_DATA_NOTE);
    expect(growthMarkdown(small)).not.toContain(EXPIRED_NOTE);
  });

  it('says that the history starts late when the oldest snapshot read is not the first one, and nothing about expiry without a snapshot', () => {
    const late = {
      ...small,
      snapshots: small.snapshots.slice(0, 2).map((one) => ({ ...one, id: one.id + 4 })),
    };

    expect(growthMarkdown(late)).toContain(EXPIRED_NOTE);
    const empty = growthMarkdown({ ...small, snapshots: [], changes: [] });
    expect(empty).not.toContain(EXPIRED_NOTE);
    expect(empty).not.toContain(NO_DATA_NOTE);
  });

  it('cuts a long list of snapshots with the number that was left out', () => {
    const many: GrowthData = {
      ...small,
      snapshots: Array.from({ length: LIST_ROWS + 5 }, (_, index) => snapshot(LIST_ROWS + 5 - index, [])),
      changes: [],
    };
    const text = growthMarkdown(many);

    expect(text.split('\n').filter((line) => line.startsWith('| @'))).toHaveLength(LIST_ROWS);
    expect(text).toContain(`… 5 more omitted (limit: ${LIST_ROWS}).`);
    expect(text).toContain(`| @${LIST_ROWS + 5} |`);
    expect(text).not.toContain('| @5 |');
  });

  it('shows catalog text as code, so that nothing renders and no cell breaks', () => {
    const hostile: GrowthData = {
      ...small,
      connection: 'Lake\n# [x](http://evil)',
      snapshots: [
        snapshot(2, [], { author: '`**bold**` <b>', commitMessage: '| a | b |\n# heading\n![i](u)' }),
        ...small.snapshots.slice(1),
      ],
      tables: [{ id: 1, schema: 'sh|op', name: 'a`b' }, small.tables[1] as never],
    };
    const text = growthMarkdown(hostile, { table: 1, metric: 'rows' });

    expect(text.split('\n')[0]).toBe('# Growth of Lake \\# \\[x\\]\\(http\\:\\/\\/evil\\)');
    expect(text.split('\n').filter((line) => /^#{1,6} /.test(line))).toEqual([
      expect.stringMatching(/^# Growth of /),
      '## Summary',
      '## Snapshots',
    ]);
    expect(text).toContain('| Table | ``sh\\|op.a`b`` |');
    expect(text).not.toContain('\n# heading');
    expect(text).toContain('| `` `**bold**` <b> `` | `\\| a \\| b \\| # heading ![i](u)` |');
  });

  it('says that a catalog has no snapshots', () => {
    const text = growthMarkdown({ ...small, snapshots: [], changes: [] });
    expect(text.match(/This catalog has no snapshots\./g)).toHaveLength(2);
  });

  it('is what the report kind opens for Open as Markdown, with the view of the page', () => {
    expect(growthKind.toMarkdown(small, { table: 2, metric: 'files' })).toBe(
      growthMarkdown(small, { table: 2, metric: 'files' }),
    );
    expect(growthKind.toMarkdown(small, undefined)).toBe(growthMarkdown(small));
  });
});
