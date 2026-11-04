import { describe, expect, it } from 'vitest';
import { advisorMarkdown } from '../../src/advisor/markdown';
import { sampleAdvisor, table } from './advisor-support';

const hostile = '`x` | y\n# injected [link](http://evil) <b>';

describe('the document of the Advisor', () => {
  it('states what was measured, the policy and the recommendations, most worthwhile first', () => {
    const lines = advisorMarkdown(sampleAdvisor()).split('\n');
    expect(lines[0]).toBe('# Maintenance advisor of Lake');
    expect(lines).toContain('| Snapshot | @130 (the newest; the dry runs act on it) |');
    expect(lines).toContain('| Snapshots to expire | 100 of 120, older than 30 days |');
    expect(lines).toContain('| Files to clean up | 40 files, 3 GB |');
    expect(lines).toContain('| Orphaned files | 2 files, 5.4 KB |');
    expect(lines).toContain(
      '| Scheduled for deletion | 45 files scheduled: 40 files ready to delete now, 5 files waiting until 2026-11-04 08:00:00 UTC; oldest since 2026-10-20 08:00:00 UTC |',
    );
    expect(lines).toContain('| Merge candidates | 2 tables |');
    expect(lines).toContain(
      '- Rewrite Data Files: files with at least 95 % of their rows deleted (the default of DuckLake).',
    );
    const table = lines.filter((line) => /^\| \d+ \|/.test(line));
    expect(table).toEqual([
      '| 1 | Rewrite 3 data files of `shop.orders` in which 95 % of the rows are deleted | high ▲▲▲ | low ▲△△ | low ▲△△ |',
      '| 2 | Merge 1,900 small files of `shop.events` | high ▲▲▲ | low ▲△△ | low ▲△△ |',
      '| 3 | Flush 2,000,000 inlined rows of `shop.clicks` to Parquet | high ▲▲▲ | low ▲△△ | low ▲△△ |',
      '| 4 | Clean up 40 files that no snapshot needs (3 GB) | high ▲▲▲ | low ▲△△ | ⚠ medium ▲▲△ |',
      '| 5 | Expire 100 snapshots older than 30 days | medium ▲▲△ | low ▲△△ | ⚠ high ▲▲▲ |',
      '| 6 | Merge 6 small files of `shop.notes` | low ▲△△ | low ▲△△ | low ▲△△ |',
      '| 7 | Data files of `shop.carts` have lost at least half of their rows | low ▲△△ | medium ▲▲△ | low ▲△△ |',
      '| 8 | Delete 2 files that the catalog does not know (5.4 KB) | low ▲△△ | medium ▲▲△ | ⚠ high ▲▲▲ |',
    ]);
  });

  it('describes each recommendation with its numbers and the script that belongs to it', () => {
    const text = advisorMarkdown(sampleAdvisor());
    expect(text).toContain(
      [
        '### 4. Clean up 40 files that no snapshot needs (3 GB)',
        '',
        'Impact: high ▲▲▲ · Effort: low ▲△△ · Risk: ⚠ medium ▲▲△',
      ].join('\n'),
    );
    expect(text).toContain(
      [
        '| Figure | Value |',
        '| --- | --- |',
        '| Files | 40 |',
        '| Size | 3 GB |',
        '| Scheduled but too young | 5 |',
      ].join('\n'),
    );
    expect(text).toContain('Script: the **Clean Up Old Files** entry of the Maintenance menu.');
    expect(text).toContain(
      'Script: the **Merge Adjacent Files** entry of the Maintenance menu of `shop.events`.',
    );
  });

  it('says what was not measured and why, and shows no advice for it', () => {
    const text = advisorMarkdown(
      sampleAdvisor({
        orphans: { state: 'skipped', reason: 'HTTP 403 | denied' },
        merge: [],
        rewrite: [],
        flush: [],
      }),
    );
    expect(text).toContain('| Orphaned files | not measured (`HTTP 403 \\| denied`) |');
    expect(text).toContain(
      '- Delete Orphaned Files: `HTTP 403 \\| denied`. Run its script in a SQL session to see the dry run.',
    );
    expect(text).not.toContain('Delete 2 files');
  });

  it('says that nothing is worth doing when nothing is', () => {
    const text = advisorMarkdown(
      sampleAdvisor({
        expiry: { state: 'measured', value: { snapshots: 3, expiring: 0, oldest: null, newest: null } },
        cleanup: { state: 'measured', value: { files: 0, bytes: 0, sized: 0 } },
        orphans: { state: 'measured', value: { files: 0, bytes: 0, sized: 0 } },
        merge: [],
        rewrite: [],
        flush: [],
      }),
    );
    expect(text).toContain('## Recommendations\n\nNothing measured is worth doing now.');
  });

  it('shows names and texts from the catalog literally, so that nothing renders and no table breaks', () => {
    const text = advisorMarkdown(
      sampleAdvisor({
        connection: hostile,
        merge: [
          {
            table: table(1, hostile, hostile),
            files: 10,
            smallFiles: 9,
            smallBytes: 5400,
            estimatedAfter: 2,
          },
        ],
        rewrite: [],
        flush: [],
        policy: { ...sampleAdvisor().policy, delete: hostile },
        cleanup: { state: 'skipped', reason: hostile },
      }),
    );
    const lines = text.split('\n');
    expect(lines.some((line) => line.startsWith('# injected'))).toBe(false);
    expect(lines.filter((line) => line.startsWith('# '))).toEqual([
      expect.stringMatching(/^# Maintenance advisor of /),
    ]);
    expect(lines.filter((line) => line.startsWith('<'))).toEqual([]);
    // The row of the merge has the cells of the table, whatever pipes the name holds.
    const [row = ''] = lines.filter((line) => line.startsWith('| 2 |'));
    expect(row.replaceAll('\\|', '').split('|')).toHaveLength(7);
    expect(row).toContain(
      '`` `x` \\| y # injected [link](http://evil) <b>.`x` \\| y # injected [link](http://evil) <b> ``',
    );
  });

  it('cuts the table and the descriptions at 50 recommendations and says how many are left out', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      table: table(100 + index, `t${index}`),
      files: 100,
      smallFiles: 100,
      smallBytes: 60_000,
      estimatedAfter: 1,
    }));
    const text = advisorMarkdown(sampleAdvisor({ merge: many }));
    expect(text.match(/^### \d+\. /gm)).toHaveLength(50);
    expect(text).toContain('… 16 more omitted (limit: 50).');
  });

  it('says that the lists of tables were cut when they were', () => {
    expect(advisorMarkdown(sampleAdvisor({ more: true }))).toContain(
      'The lists of tables were cut at 100 per kind; more tables may qualify.',
    );
  });
});
