import { describe, expect, it } from 'vitest';
import { advisorCards, estimatedFilesAfterMerge, skippedMeasures } from '../../src/advisor/model';
import type { AdvisorData } from '../../src/advisor/model';
import { recommendationsOf } from '../../src/advisor/recommend';
import { sampleAdvisor, table } from './advisor-support';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const skipped = { state: 'skipped', reason: 'x' } as const;
const nothing = { state: 'measured', value: { files: 0, bytes: 0, sized: 0 } } as const;

describe('the estimate of the files after a merge', () => {
  it('turns the small files into files of the target size and leaves the others', () => {
    // files, small files, bytes of the small files, target, files after the merge
    const cases: [number, number, number, number, number][] = [
      [6, 6, 3_600, 512_000_000, 1],
      [10, 6, 3_600, 512_000_000, 5],
      // 1,900 files of about 10 KB fit into a single file of the target size.
      [2000, 1900, 19_000_000, 512_000_000, 2000 - 1900 + 1],
      [2000, 1900, 63 * 512_000_000, 512_000_000, 2000 - 1900 + 63],
      [100, 100, 100 * 8 * MIB, 100 * MIB, 8],
      // The small files that fill a target exactly make one file, one byte more make two.
      [10, 10, 1_000, 1_000, 1],
      [10, 10, 1_001, 1_000, 2],
      // A target smaller than a small file cannot make more files than there are.
      [6, 6, 6 * 16 * MIB, 100_000, 6],
      [1, 1, 500, 512_000_000, 1],
      [5, 5, 0, 512_000_000, 1],
    ];
    for (const [files, small, smallBytes, target, expected] of cases) {
      expect(
        estimatedFilesAfterMerge(files, small, smallBytes, target),
        `${files}/${small}/${smallBytes}`,
      ).toBe(expected);
    }
  });
});

describe('the key figures', () => {
  const values = (data: AdvisorData) => advisorCards(data).map(({ value, severity }) => [value, severity]);

  it('state what each dry run found and what the candidates are', () => {
    expect(values(sampleAdvisor())).toEqual([
      ['100', 'ok'],
      ['40', 'ok'],
      ['2', 'ok'],
      ['3 GB', 'ok'],
      ['45', 'ok'],
      ['2', 'ok'],
      ['2', 'ok'],
      ['1', 'ok'],
      ['30 days', 'ok'],
    ]);
  });

  it('warn for a dry run that was skipped and promise only a lower bound for the space it cannot measure', () => {
    const data = sampleAdvisor({
      expiry: { state: 'skipped', reason: 'The statement exceeded its time limit of 30 s.' },
      orphans: { state: 'skipped', reason: 'HTTP 403' },
    });
    const [expiry, , orphans, reclaim] = advisorCards(data);
    expect(expiry).toMatchObject({
      severity: 'warning',
      detail: 'The statement exceeded its time limit of 30 s.',
    });
    expect(orphans).toMatchObject({ severity: 'warning', detail: 'HTTP 403' });
    expect(reclaim?.value).toContain('3 GB');
    expect(reclaim?.value).not.toBe('3 GB');

    const neither = sampleAdvisor({ cleanup: skipped, orphans: skipped });
    expect(advisorCards(neither)[3]).toMatchObject({ severity: 'warning' });
    expect(advisorCards(neither)[3]?.value).not.toContain('GB');

    // A size that covers only some of the files is a lower bound.
    const partial = sampleAdvisor({
      cleanup: { state: 'measured', value: { files: 5000, bytes: 10 * MIB, sized: 1000 } },
    });
    expect(advisorCards(partial)[1]?.value).toBe('5,000');
    expect(advisorCards(partial)[1]?.detail).toContain('10 MB');
    expect(advisorCards(partial)[1]?.detail).not.toBe('10 MB');

    const option = sampleAdvisor({
      policy: { ...sampleAdvisor().policy, expire: { text: '7 days', source: 'option' } },
    });
    expect(advisorCards(option).at(-1)?.value).toBe('7 days');
  });
});

describe('the recommendations', () => {
  const ranked = (data: AdvisorData) =>
    recommendationsOf(data).map(({ id, impact, effort, risk }) => [id, impact, effort, risk]);

  it('are ranked by impact, then risk, then effort, then kind and gain', () => {
    expect(ranked(sampleAdvisor())).toEqual([
      ['rewrite:3', 'high', 'low', 'low'],
      ['merge:1', 'high', 'low', 'low'],
      ['flush:5', 'high', 'low', 'low'],
      ['cleanup', 'high', 'low', 'medium'],
      ['expire', 'medium', 'low', 'high'],
      ['merge:2', 'low', 'low', 'low'],
      ['rewrite:4', 'low', 'medium', 'low'],
      ['orphans', 'low', 'medium', 'high'],
    ]);
  });

  it('carry the figures of the dry runs, and name a table the way the caller wants it', () => {
    const find = (id: string) =>
      recommendationsOf(sampleAdvisor()).find((recommendation) => recommendation.id === id);
    const values = (id: string) => find(id)?.figures.map(([, value]) => value);
    expect(values('cleanup')).toEqual(['40', '3 GB', '5']);
    expect(values('merge:1')).toEqual(['2,000', '1,900', 'about 163', 'about 1,837']);
    expect(find('expire')?.figures).toContainEqual(['Oldest', '2026-08-01 00:00:00 UTC']);
    expect(values('rewrite:4')).toContain('0');
    expect(find('cleanup')?.title).toContain('40');
    expect(find('expire')?.title).toContain('100');

    const titles = recommendationsOf(sampleAdvisor(), (named) => `[${named.name}]`).map(({ title }) => title);
    expect(titles.filter((title) => title.includes('['))).toHaveLength(5);
    expect(titles.join('\n')).not.toContain('shop.');
  });

  it('offer nothing for a dry run that found nothing or was skipped, and name what was skipped', () => {
    const none = sampleAdvisor({
      expiry: { state: 'measured', value: { snapshots: 5, expiring: 0, oldest: null, newest: null } },
      cleanup: nothing,
      orphans: { state: 'skipped', reason: 'HTTP 403' },
      merge: [],
      rewrite: [],
      flush: [],
    });
    expect(recommendationsOf(none)).toEqual([]);
    expect(skippedMeasures(none).map(({ kind, reason }) => [kind, reason])).toEqual([
      ['orphans', 'HTTP 403'],
    ]);
  });

  it('rates the impact by tiers: files and bytes of a cleanup, plain rewrites, expiring snapshots and inlined rows', () => {
    const onlyCleanup = (files: number, bytes: number) =>
      recommendationsOf(
        sampleAdvisor({
          cleanup: { state: 'measured', value: { files, bytes, sized: files } },
          expiry: { state: 'measured', value: { snapshots: 1, expiring: 0, oldest: null, newest: null } },
          orphans: nothing,
          merge: [],
          rewrite: [],
          flush: [],
        }),
      )[0]?.impact;
    const cleanups: [number, number, string][] = [
      [1, 100 * MIB - 1, 'low'],
      [1, 100 * MIB, 'medium'],
      [99, 1, 'low'],
      [100, 1, 'medium'],
      [999, 1, 'medium'],
      [1000, 1, 'high'],
      [1, GIB - 1, 'medium'],
      [1, GIB, 'high'],
    ];
    for (const [files, bytes, impact] of cleanups) {
      expect(onlyCleanup(files, bytes), `${files} files ${bytes} bytes`).toBe(impact);
    }

    // Files that a plain rewrite would not touch are low however large they are.
    const onlyRewrite = (atThreshold: number): AdvisorData =>
      sampleAdvisor({
        expiry: skipped,
        cleanup: skipped,
        orphans: skipped,
        merge: [],
        flush: [],
        rewrite: [
          { table: table(3, 'big'), files: 2, atThreshold, records: 100, deleted: 98, sizeBytes: 100 * GIB },
        ],
      });
    expect(recommendationsOf(onlyRewrite(2))[0]?.impact).toBe('high');
    expect(recommendationsOf(onlyRewrite(0))[0]?.impact).toBe('low');

    const expiries: [number, string][] = [
      [99, 'low'],
      [100, 'medium'],
      [999, 'medium'],
      [1000, 'high'],
    ];
    for (const [expiring, impact] of expiries) {
      const data = sampleAdvisor({
        expiry: { state: 'measured', value: { snapshots: 2000, expiring, oldest: null, newest: null } },
        cleanup: nothing,
        orphans: nothing,
        merge: [],
        rewrite: [],
        flush: [],
      });
      expect(recommendationsOf(data)[0]?.impact, `${expiring} snapshots`).toBe(impact);
    }

    const flushes: [number, string][] = [
      [99_999, 'low'],
      [100_000, 'medium'],
      [1_000_000, 'high'],
    ];
    for (const [rows, impact] of flushes) {
      const data = sampleAdvisor({
        expiry: skipped,
        cleanup: skipped,
        orphans: skipped,
        merge: [],
        rewrite: [],
        flush: [{ table: table(9, 'big'), rows }],
      });
      expect(recommendationsOf(data)[0]?.impact, `${rows} rows`).toBe(impact);
    }
  });
});
