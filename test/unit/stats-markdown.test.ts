import { describe, expect, it } from 'vitest';
import type { GrowthPoint, TableStatistics } from '../../src/catalog/model';
import { reportTitle } from '../../src/markdown';
import { formatUtc } from '../../src/shell/model';
import { ReportPanels } from '../../src/shell/panels';
import { statisticsKind } from '../../src/stats/kind';
import { statisticsMarkdown } from '../../src/stats/markdown';
import type { StatisticsData } from '../../src/stats/model';
import { FakePanel } from './fake-panel';
import { historyStatistics } from './stats-support';

const all = await historyStatistics();

const data = (statistics: TableStatistics, table = 'shop.events'): StatisticsData => ({
  table,
  connection: 'History',
  statistics,
});

/** The time column of the growth table, as the document words the time of a snapshot of the fixture. */
const timeOf = (statistics: TableStatistics, snapshot: number): string => {
  const point = statistics.growth.find((candidate) => candidate.snapshot === snapshot);
  return point?.time ? formatUtc(point.time) : 'time unknown (snapshot expired)';
};

describe('the statistics report as a Markdown document', () => {
  it('has all four tabs for shop.events with the figures of the history fixture', () => {
    const { events } = all;
    expect(statisticsMarkdown(data(events)).split('\n')).toEqual([
      reportTitle('Statistics of', 'shop.events'),
      '',
      'Snapshot @56 of `History`.',
      '',
      '## Overview',
      '',
      '| Figure | Value | Detail |',
      '| --- | --- | --- |',
      '| Files | 9 |  |',
      '| Size | 6.2 KB | 6.2 KB data, 0 B delete files |',
      '| Rows | 52 |  |',
      '| Delete files | 0 |  |',
      '| Average file size | 705.4 B | largest 1.3 KB |',
      '| Small files | 100 % (warning) | 9 of 9 under 16 MB |',
      '',
      'Counts cover data files and delete files. Rows that DuckLake keeps inline in the catalog are not included.',
      '',
      '### File size distribution',
      '',
      '| Size range | Files | Size |',
      '| --- | --- | --- |',
      '| < 11 B | 0 | 0 B |',
      '| 11 B – 21 B | 0 | 0 B |',
      '| 21 B – 42 B | 0 | 0 B |',
      '| 42 B – 83 B | 0 | 0 B |',
      '| 83 B – 166 B | 0 | 0 B |',
      '| 166 B – 332 B | 0 | 0 B |',
      '| 332 B – 664 B | 8 | 4.9 KB |',
      '| ≥ 664 B | 1 | 1.3 KB |',
      '',
      'Each range is half the size of the one above it, relative to the largest file.',
      '',
      '## Columns',
      '',
      '| Column | Type | Nullable | Null share | Minimum | Maximum |',
      '| --- | --- | --- | --- | --- | --- |',
      '| `id` | `int32` | no | 0 % | `1` | `139` |',
      '| `kind` | `varchar` | yes | 0 % | `click` | `view` |',
      '| `ts` | `timestamp` | yes | 0 % | `2025-03-01 10:00:00` | `2026-04-02 10:00:00` |',
      '| `amount` | `decimal(10,2)` | yes | 0 % | `0.00` | `58.50` |',
      '',
      'Minimum and maximum are the range according to the statistics: deleting rows does not narrow it. The null share counts the rows of the data files, deleted ones included. It is not shown (–) for a field below a column that can be NULL or is a list or a map, because DuckLake counts a missing parent as NULL for its fields.',
      '',
      '## Partitioning',
      '',
      'Partitioned by `kind, month(ts)`.',
      '',
      '| Partition | Files | Size | Rows |',
      '| --- | --- | --- | --- |',
      '| `click / 3` | 1 | 647 B | 2 |',
      '| `click / 4` | 1 | 618 B | 1 |',
      '| `view / 3` | 1 | 613 B | 1 |',
      '| `view / 4` | 1 | 613 B | 1 |',
      '',
      'Size per partition: coefficient of variation 0.02, Gini 0.01 (even; 0 means equal sizes, 1 means one partition holds everything).',
      '',
      '5 data files were written under an earlier partitioning and are not shown here.',
      '',
      '## Growth',
      '',
      '| Snapshot | Time | Files | Size | Compaction |',
      '| --- | --- | --- | --- | --- |',
      `| @23 | ${timeOf(events, 23)} | 9 | 6.2 KB | no |`,
      `| @10 | ${timeOf(events, 10)} | 8 | 5.6 KB | no |`,
      `| @8 | ${timeOf(events, 8)} | 5 | 3.8 KB | no |`,
      `| @7 | ${timeOf(events, 7)} | 4 | 2.5 KB | no |`,
      `| @6 | ${timeOf(events, 6)} | 3 | 1.9 KB | no |`,
      '',
      'The state after each snapshot that added or removed files. A compaction (diamond) replaces files that leave no trace, so the file count before it is what the catalog still shows.',
      '',
    ]);
  });

  it('puts a message in place of every section that a table without data files and partitions has no content for', () => {
    const markdown = statisticsMarkdown(data(all.notes, 'shop.notes'));
    expect(markdown).toContain('| Files | 0 |  |');
    expect(markdown).toContain('| Small files | – |  |');
    expect(markdown).toContain('This table has no data files at snapshot 56.');
    expect(markdown).toContain('This table is not partitioned at snapshot 56.');
    expect(markdown).toContain('No data file was added or removed up to snapshot 56.');
    expect(markdown).not.toContain('| Size range |');
    expect(markdown).not.toContain('| Partition |');
    expect(markdown).not.toContain('| Snapshot | Time |');
  });

  it('lists the rest of the partitions as one row, and says when the figures cover only some of the files', () => {
    const { events } = all;
    const partitioning = events.partitioning;
    expect(partitioning).toBeDefined();
    const markdown = statisticsMarkdown(
      data({
        ...events,
        columnsPartial: true,
        partitioning: partitioning && {
          ...partitioning,
          rest: { partitions: 12, files: 30, sizeBytes: 2048, rows: 1234 },
          partial: true,
        },
      }),
    );
    expect(markdown).toContain('| other (12) | 30 | 2 KB | 1,234 |');
    expect(markdown).toContain('The table has very many files: minimum and maximum cover only some of them.');
    expect(markdown).toContain(
      'The table has more partitions than are read; the figures cover the largest ones.',
    );
  });

  it('lists the newest 100 snapshots of a long growth first and counts the others', () => {
    const growth: GrowthPoint[] = Array.from({ length: 130 }, (_, index) => ({
      snapshot: index + 1,
      time: null,
      files: index + 1,
      sizeBytes: 1024 * (index + 1),
      compaction: index === 129,
    }));
    const lines = statisticsMarkdown(data({ ...all.events, growth })).split('\n');
    const rows = lines.filter((line) => /^\| @\d+ /.test(line));
    expect(rows).toHaveLength(100);
    expect(rows[0]).toBe('| @130 | time unknown (snapshot expired) | 130 | 130 KB | yes |');
    expect(rows[99]).toBe('| @31 | time unknown (snapshot expired) | 31 | 31 KB | no |');
    expect(lines).toContain('… 30 more omitted (limit: 100).');
  });

  it('shows names and values of the catalog as code: no Markdown, no extra cell, no line break', () => {
    const { events } = all;
    const hostile = 'x | y\n# h `t` <img src=x onerror=alert(1)>';
    const [bucket] = events.partitioning?.partitions ?? [];
    const [column] = events.columns;
    expect(bucket && column && events.partitioning).toBeTruthy();
    const markdown = statisticsMarkdown({
      table: hostile,
      connection: hostile,
      statistics: {
        ...events,
        columns: [
          { ...(column as object), path: [hostile], type: hostile, min: hostile, max: hostile } as never,
        ],
        partitioning: events.partitioning && {
          ...events.partitioning,
          partitions: [{ ...(bucket as object), values: [hostile, null] } as never],
        },
      },
    });
    const lines = markdown.split('\n');
    expect(lines.slice(0, 3)).toEqual([
      reportTitle('Statistics of', hostile),
      '',
      'Snapshot @56 of ``x | y # h `t` <img src=x onerror=alert(1)>``.',
    ]);
    // the pipe would end a table cell, so inside the tables it is escaped; no line starts with a heading marker
    expect(lines).toContain(
      '| ``x \\| y # h `t` <img src=x onerror=alert(1)>`` | ``x \\| y # h `t` <img src=x onerror=alert(1)>`` | no | 0 % | ``x \\| y # h `t` <img src=x onerror=alert(1)>`` | ``x \\| y # h `t` <img src=x onerror=alert(1)>`` |',
    );
    expect(lines).toContain('| ``x \\| y # h `t` <img src=x onerror=alert(1)> / NULL`` | 1 | 647 B | 2 |');
    expect(lines.filter((line) => line.startsWith('#'))).toEqual([
      lines[0],
      '## Overview',
      '### File size distribution',
      '## Columns',
      '## Partitioning',
      '## Growth',
    ]);
  });
});

describe('the statistics report kind', () => {
  it('builds the document from the data the extension holds, whatever view the page names', () => {
    expect(statisticsKind.toMarkdown(data(all.events), undefined)).toBe(statisticsMarkdown(data(all.events)));
    expect(statisticsKind.message(data(all.events))).toEqual({ type: 'statistics', data: data(all.events) });
  });

  it('takes no action and no view from the page: the statistics report only asks for its data', () => {
    const panel = new FakePanel('Statistics');
    const documents: string[] = [];
    const actions: unknown[] = [];
    const shown = new ReportPanels(() => panel, statisticsKind, {
      openMarkdown: (markdown) => documents.push(markdown),
      onAction: (action) => actions.push(action),
    });
    shown.show('a', 'Statistics', data(all.events));
    panel.send({ type: 'action', action: 'x' });
    panel.send({ type: 'markdown', view: {} });
    panel.send({ type: 'markdown', view: { tab: 'columns' } });
    expect([actions, documents]).toEqual([[], []]);
    panel.send({ type: 'markdown' });
    expect(documents).toEqual([statisticsMarkdown(data(all.events))]);
    expect(statisticsKind.viewType).toBe('aantje.statistics');
  });
});
