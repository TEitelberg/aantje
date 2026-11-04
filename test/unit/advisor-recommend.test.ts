import { describe, expect, it } from 'vitest';
import { advisorCards, skippedMeasures } from '../../src/advisor/model';
import { recommendationsOf } from '../../src/advisor/recommend';
import { sampleAdvisor, table } from './advisor-support';

/** Data with nothing to do, so that a test adds only the candidates it is about. */
const nothing = () =>
  sampleAdvisor({
    expiry: { state: 'measured', value: { snapshots: 5, expiring: 0, oldest: null, newest: null } },
    cleanup: { state: 'measured', value: { files: 0, bytes: 0, sized: 0 } },
    orphans: { state: 'measured', value: { files: 0, bytes: 0, sized: 0 } },
    merge: [],
    rewrite: [],
    flush: [],
  });

const merge = (id: number, files: number, estimatedAfter: number) => ({
  table: table(id, `t${id}`),
  files,
  smallFiles: files,
  smallBytes: 1000,
  estimatedAfter,
});

const rewrite = (id: number, sizeBytes: number, deleted = 60, records = 100, atThreshold = 0) => ({
  table: table(id, `t${id}`),
  files: 1,
  atThreshold,
  records,
  deleted,
  sizeBytes,
});

const ids = (data: ReturnType<typeof nothing>) => recommendationsOf(data).map(({ id }) => id);

describe('the order of recommendations that are equal in impact, risk and effort', () => {
  it('puts the larger gain first, and the table with the lower id first when the gain is the same', () => {
    expect(
      ids({ ...nothing(), merge: [merge(10, 10, 4), merge(2, 10, 4), merge(3, 30, 4), merge(4, 20, 4)] }),
    ).toEqual(['merge:3', 'merge:4', 'merge:2', 'merge:10']);
    expect(ids({ ...nothing(), rewrite: [rewrite(1, 1000), rewrite(2, 3000), rewrite(3, 2000)] })).toEqual([
      'rewrite:2',
      'rewrite:3',
      'rewrite:1',
    ]);
  });

  it('prefers a rewrite to a merge and a merge to a flush', () => {
    expect(
      ids({
        ...nothing(),
        flush: [{ table: table(1, 'a'), rows: 20_000 }],
        merge: [merge(2, 10, 1)],
        rewrite: [rewrite(3, 1000, 96, 100, 1)],
      }),
    ).toEqual(['rewrite:3', 'merge:2', 'flush:1']);
  });
});

describe('the figures of the recommendations', () => {
  it('count the files that are scheduled but too young, never below zero', () => {
    const young = (scheduled: number) =>
      recommendationsOf({
        ...nothing(),
        scheduled: { count: scheduled, oldestScheduledAt: null, split: null },
        cleanup: { state: 'measured', value: { files: 3, bytes: 300, sized: 3 } },
      }).find(({ id }) => id === 'cleanup');

    expect(young(8)?.figures).toContainEqual(['Scheduled but too young', '5']);
    expect(young(8)?.explanation.join(' ')).toContain('5 more files are scheduled but too young');
    expect(young(1)?.figures).toContainEqual(['Scheduled but too young', '0']);
    expect(young(1)?.explanation.join(' ')).not.toContain('too young');
    expect(young(3)?.explanation.join(' ')).not.toContain('too young');
  });

  it('estimate the deleted bytes of a rewrite from the shares of the rows, rounded', () => {
    const found = recommendationsOf({ ...nothing(), rewrite: [rewrite(1, 1001, 1, 3, 1)] })[0];

    expect(found?.figures).toContainEqual(['Estimated deleted share of the size', 'about 334 B']);
    expect(found?.figures).toContainEqual(['Size of these files', '1001 B']);
    expect(found?.weight).toBe(334);
  });

  it('estimate the files a merge saves as the files minus the estimate after it', () => {
    const found = recommendationsOf({ ...nothing(), merge: [merge(1, 250, 100)] })[0];

    expect(found).toMatchObject({ weight: 150, impact: 'medium' });
    expect(found?.figures).toContainEqual(['Estimated fewer files', 'about 150']);
    expect(recommendationsOf({ ...nothing(), merge: [merge(1, 250, 151)] })[0]?.impact).toBe('low');
    expect(recommendationsOf({ ...nothing(), merge: [merge(1, 1100, 100)] })[0]?.impact).toBe('high');
  });

  it('rate a rewrite by the bytes it frees, and one that no file reaches the threshold of as low', () => {
    const MIB = 1024 * 1024;
    expect(recommendationsOf({ ...nothing(), rewrite: [rewrite(1, 200 * MIB, 96, 100, 1)] })[0]?.impact).toBe(
      'medium',
    );
    expect(recommendationsOf({ ...nothing(), rewrite: [rewrite(1, 200 * MIB, 40, 100, 0)] })[0]?.impact).toBe(
      'low',
    );
  });
});

describe('the key figures of the space', () => {
  it('add the bytes and the files of the cleanup and of the orphans', () => {
    const [, , , space] = advisorCards({
      ...nothing(),
      cleanup: { state: 'measured', value: { files: 3, bytes: 1500, sized: 3 } },
      orphans: { state: 'measured', value: { files: 2, bytes: 2500, sized: 2 } },
    });

    expect(space).toMatchObject({ label: 'Reclaimable space', value: '3.9 KB', detail: '5 files' });
  });

  it('name the measurement that was skipped, with the reason', () => {
    expect(
      skippedMeasures({
        expiry: { state: 'measured', value: { snapshots: 1, expiring: 0, oldest: null, newest: null } },
        cleanup: { state: 'skipped', reason: 'one' },
        orphans: { state: 'measured', value: { files: 0, bytes: 0, sized: 0 } },
      }),
    ).toEqual([{ kind: 'cleanup', label: 'Clean Up Old Files', reason: 'one' }]);
    expect(
      skippedMeasures({
        expiry: { state: 'skipped', reason: 'a' },
        cleanup: { state: 'measured', value: { files: 0, bytes: 0, sized: 0 } },
        orphans: { state: 'skipped', reason: 'b' },
      }),
    ).toEqual([
      { kind: 'expire', label: 'Expire Snapshots', reason: 'a' },
      { kind: 'orphans', label: 'Delete Orphaned Files', reason: 'b' },
    ]);
  });
});
