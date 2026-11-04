import { beforeAll, describe, expect, it } from 'vitest';
import { snapshotReportKind } from '../../src/snapshot-report/kind';
import { snapshotReportMarkdown } from '../../src/snapshot-report/markdown';
import type { SnapshotReportMarkdownView } from '../../src/snapshot-report/markdown';
import type { SnapshotReportData } from '../../src/snapshot-report/model';
import { formatUtc } from '../../src/shell/model';
import { HISTORY_ID } from '../support/expected-history';
import { historyReport, snapshot, tableChange } from './snapshot-report-support';

const SNAPSHOT_ROWS = 200;

const { events, customers } = HISTORY_ID;

let history: SnapshotReportData;
beforeAll(async () => {
  history = await historyReport();
});

/** The time column of a snapshot, as the document words it. */
const timeOf = (id: number): string => {
  const time = history.snapshots.find((candidate) => candidate.id === id)?.time ?? '';
  return formatUtc(time).replace(' UTC', '');
};

const ALL_KINDS = ['insert', 'update', 'delete', 'ddl', 'maintenance'] as const;
const lines = (markdown: string): string[] => markdown.split('\n');
const rowsOf = (markdown: string): string[] => lines(markdown).filter((line) => /^\| @\d+ /.test(line));

describe('the snapshot report as a Markdown document', () => {
  it('shows the chosen table with all kinds of change and all snapshots that changed it', () => {
    const markdown = lines(
      snapshotReportMarkdown(history, {
        lanes: [`t${events}`],
        kinds: [...ALL_KINDS],
        range: { from: 0, to: 56 },
      }),
    );
    expect(markdown.slice(0, 22)).toEqual([
      '# Snapshot report of History',
      '',
      '| Property | Value |',
      '| --- | --- |',
      '| Snapshots read | 57 (latest in the catalog @56) |',
      '| Tables | `shop.events` |',
      '| Kinds of change | all |',
      '| Range | @0 to @56 |',
      '| Snapshots listed | 8 of 57 |',
      '',
      '## Snapshots',
      '',
      '| Snapshot | Time (UTC) | Author | Message | Changes |',
      '| --- | --- | --- | --- | --- |',
      `| @23 | ${timeOf(23)} |  |  | \`shop.events\` Inserted into table; \`shop.customers\` Inserted into table |`,
      `| @10 | ${timeOf(10)} |  |  | \`shop.events\` Inserted into table |`,
      `| @9 | ${timeOf(9)} |  |  | \`shop.events\` Altered table |`,
      `| @8 | ${timeOf(8)} |  |  | \`shop.events\` Inserted into table |`,
      `| @7 | ${timeOf(7)} |  |  | \`shop.events\` Inserted into table |`,
      `| @6 | ${timeOf(6)} |  |  | \`shop.events\` Inserted into table |`,
      `| @5 | ${timeOf(5)} |  |  | \`shop.events\` Altered table |`,
      `| @4 | ${timeOf(4)} |  |  | \`shop.events\` Created table |`,
    ]);
    expect(markdown.slice(22)).toEqual(['']);
  });

  it('lists every snapshot of the catalog, newest first, with the author and the message of the nightly import', () => {
    const everything = snapshotReportMarkdown(history);
    const rows = rowsOf(everything);
    expect(lines(everything)).toContain('| Tables | all |');
    expect(lines(everything)).toContain('| Snapshots listed | 57 of 57 |');
    expect(rows).toHaveLength(57);
    expect(rows[0]).toMatch(/^\| @56 \| \d{4}-\d\d-\d\d \d\d:\d\d:\d\d \|/);
    expect(rows.find((row) => row.startsWith('| @25 '))).toBe(
      `| @25 | ${timeOf(25)} | \`tillmann\` | \`Nightly import\` | \`shop.customers\` Inserted into table |`,
    );
    expect(rows.find((row) => row.startsWith('| @23 '))).toContain(
      '`shop.events` Inserted into table; `shop.customers` Inserted into table',
    );
  });

  it('names the filters of the view as text and lists only the snapshots that they leave', () => {
    const view: SnapshotReportMarkdownView = {
      lanes: [`t${customers}`],
      kinds: ['insert'],
      range: { from: 20, to: 30 },
    };
    const markdown = snapshotReportMarkdown(history, view);
    expect(lines(markdown).slice(4, 9)).toEqual([
      '| Snapshots read | 57 (latest in the catalog @56) |',
      '| Tables | `shop.customers` |',
      '| Kinds of change | Insert |',
      '| Range | @20 to @30 |',
      '| Snapshots listed | 2 of 57 |',
    ]);
    expect(rowsOf(markdown).map((row) => row.split(' | ')[0])).toEqual(['| @25', '| @23']);
    expect(rowsOf(markdown).every((row) => row.includes('`shop.customers` Inserted into table'))).toBe(true);
  });

  it('lists the kinds in the order of the page and says all when none is left out', () => {
    const markdown = snapshotReportMarkdown(history, {
      lanes: [],
      kinds: ['maintenance', 'delete', 'ddl'],
      range: { from: 0, to: 56 },
    });
    expect(lines(markdown)).toContain('| Kinds of change | Delete, Schema change, Maintenance |');
    expect(lines(markdown)).toContain('| Tables | all |');
    const all = snapshotReportMarkdown(history, {
      lanes: [],
      kinds: [...ALL_KINDS],
      range: { from: 0, to: 56 },
    });
    expect(lines(all)).toContain('| Kinds of change | all |');
  });

  it('fits a view to the data it holds: unknown tables are dropped, the range is held inside the snapshots that were read', () => {
    const markdown = snapshotReportMarkdown(history, {
      lanes: ['t999', `t${events}`, '__proto__'],
      kinds: [...ALL_KINDS],
      range: { from: -5, to: 9999 },
    });
    expect(lines(markdown)).toContain('| Tables | `shop.events` |');
    expect(lines(markdown)).toContain('| Range | @0 to @56 |');
    expect(rowsOf(markdown)).toHaveLength(8);
  });

  it('says why nothing is listed', () => {
    const none = snapshotReportMarkdown(history, { lanes: [], kinds: [], range: { from: 0, to: 56 } });
    expect(lines(none)).toContain('| Kinds of change | none |');
    expect(lines(none)).toContain(
      'No snapshot in this range changed the chosen tables with the chosen kinds of change.',
    );
    expect(lines(none)).not.toContain('| Snapshot | Time (UTC) | Author | Message | Changes |');
    const empty = snapshotReportMarkdown({ ...history, snapshots: [], more: false });
    expect(lines(empty)).toContain('| Range | none |');
    expect(lines(empty)).toContain('This catalog has no snapshots.');
  });

  it('cuts a long list at the limit, keeps the newest snapshots and counts the others', () => {
    const many: SnapshotReportData = {
      ...history,
      latest: 250,
      snapshots: Array.from({ length: 250 }, (_, index) => snapshot(index + 1, [tableChange(3, 'inserted')])),
    };
    const markdown = snapshotReportMarkdown(many);
    const rows = rowsOf(markdown);
    expect(SNAPSHOT_ROWS).toBe(200);
    expect(rows).toHaveLength(200);
    expect(rows[0]?.startsWith('| @250 ')).toBe(true);
    expect(rows[199]?.startsWith('| @51 ')).toBe(true);
    expect(lines(markdown)).toContain('| Snapshots listed | 250 of 250 |');
    expect(lines(markdown)).toContain('… 50 more omitted (limit: 200).');
  });

  it('says that older snapshots were not read', () => {
    const markdown = snapshotReportMarkdown({ ...history, more: true });
    expect(lines(markdown)).toContain('The 57 newest snapshots are shown. Older ones are not read.');
  });

  it('says how many lanes the chart leaves out, as the page does', () => {
    const wide: SnapshotReportData = {
      ...history,
      snapshots: Array.from({ length: 33 }, (_, index) =>
        snapshot(index + 1, [tableChange(index + 100, 'inserted')]),
      ),
    };
    expect(lines(snapshotReportMarkdown(wide))).toContain(
      '3 lanes not shown: the 30 busiest tables are drawn. Choose tables in the filter to see the others.',
    );
  });

  it('shows names, authors and messages of the catalog as code: no Markdown, no extra cell, no line break', () => {
    const hostile = 'x | y\n# h `t` <img src=x onerror=alert(1)>';
    const data: SnapshotReportData = {
      ...history,
      connection: hostile,
      snapshots: [
        snapshot(1, [tableChange(3, 'inserted', hostile, hostile)], {
          author: hostile,
          commitMessage: hostile,
        }),
      ],
    };
    const markdown = lines(snapshotReportMarkdown(data));
    const code = '``x \\| y # h `t` <img src=x onerror=alert(1)>``';
    expect(markdown[0]).toBe(
      '# Snapshot report of x \\| y \\# h \\`t\\` \\<img src\\=x onerror\\=alert\\(1\\)\\>',
    );
    expect(rowsOf(snapshotReportMarkdown(data))).toEqual([
      expect.stringContaining(
        `| ${code} | ${code} | ${code.slice(0, -2)}.${code.slice(2)} Inserted into table |`,
      ),
    ]);
    expect(markdown.filter((line) => line.startsWith('#'))).toEqual([markdown[0], '## Snapshots']);
  });
});

describe('the snapshot report kind', () => {
  it('builds the document from the data the extension holds', () => {
    const view: SnapshotReportMarkdownView = { lanes: [], kinds: ['ddl'], range: { from: 0, to: 56 } };
    expect(snapshotReportKind.toMarkdown(history, view)).toBe(snapshotReportMarkdown(history, view));
    expect(snapshotReportKind.toMarkdown(history, undefined)).toBe(snapshotReportMarkdown(history));
    expect(snapshotReportKind.message(history)).toEqual({ type: 'snapshotReport', data: history });
    expect(snapshotReportKind.viewType).toBe('aantje.snapshotReport');
  });

  it('accepts a view of the right shape and an action of the detail pane, and nothing else', () => {
    expect(snapshotReportKind.isView?.({ lanes: ['t3'], kinds: ['insert'], range: { from: 1, to: 2 } })).toBe(
      true,
    );
    expect(snapshotReportKind.isView?.({ lanes: ['t3'], kinds: ['insert'] })).toBe(false);
    expect(snapshotReportKind.isView?.({ lanes: [3], kinds: ['insert'], range: { from: 1, to: 2 } })).toBe(
      false,
    );
    expect(snapshotReportKind.isView?.({ lanes: [], kinds: ['truncate'], range: { from: 1, to: 2 } })).toBe(
      false,
    );
    expect(snapshotReportKind.isView?.({ lanes: [], kinds: [], range: { from: -1, to: 2 } })).toBe(false);
    expect(snapshotReportKind.isAction?.({ type: 'action', action: 'showLatest' })).toBe(true);
    expect(snapshotReportKind.isAction?.({ type: 'refresh' })).toBe(false);
    expect(snapshotReportKind.isAction?.({ type: 'action', action: 'markdown' })).toBe(false);
  });
});
