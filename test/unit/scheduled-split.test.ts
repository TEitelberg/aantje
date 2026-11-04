import { describe, expect, it } from 'vitest';
import { intervalMs, splitScheduled } from '../../src/catalog/scheduled';
import { splitExpirable } from '../../src/catalog/expirable';
import { expirableLine, expirableNote, scheduledLine, scheduledNote } from '../../src/shell/scheduled-text';

const NOW = new Date('2026-11-02T12:00:00.000Z');

describe('the age of the lake', () => {
  it('reads seconds to weeks and refuses what has no fixed length', () => {
    expect(intervalMs('7 days')).toBe(7 * 86_400_000);
    expect(intervalMs('1 week')).toBe(604_800_000);
    expect(intervalMs('1 day 12 hours')).toBe(129_600_000);
    expect(['1 month', '2 years', '', 'soon', '7 days later']).toSatisfy((values: string[]) =>
      values.every((value) => intervalMs(value) === undefined),
    );
  });
});

describe('the split of the scheduled files', () => {
  const groups = [
    { scheduledAt: '2026-10-29T12:00:00.000Z', files: 3 },
    { scheduledAt: '2026-11-01T18:00:00.000Z', files: 2 },
    { scheduledAt: '2026-11-02T08:00:00.000Z', files: 5 },
  ];

  it('is ready for the files at least as old as the age, and says when the oldest waiting one is ready', () => {
    expect(splitScheduled(groups, undefined, NOW)).toEqual({
      age: { text: '2 days', source: 'default' },
      ready: 3,
      waiting: 7,
      nextReadyAt: '2026-11-03T18:00:00.000Z',
    });
    expect(splitScheduled(groups, '12 hours', NOW)).toMatchObject({
      age: { text: '12 hours', source: 'option' },
      ready: 5,
      waiting: 5,
      nextReadyAt: '2026-11-02T20:00:00.000Z',
    });
    expect(splitScheduled(groups, '1 month', NOW)).toBeUndefined();
  });

  it('writes the numbers and, when no file is old enough, what the script has to use', () => {
    const scheduled = (option: string | undefined) => ({
      count: 10,
      oldestScheduledAt: '2026-10-29T12:00:00.000Z',
      split: splitScheduled(groups, option, NOW) ?? null,
    });
    expect(scheduledLine(scheduled(undefined))).toMatch(
      /^10 files scheduled: 3 files ready to delete now, 7 files waiting until 2026-11-03/,
    );
    expect(scheduledNote(scheduled(undefined))).toBe('');

    const none = scheduled('30 days');
    expect(scheduledLine(none)).toMatch(/^10 files scheduled: all waiting until 2026-11-28/);
    expect(scheduledNote(none)).toContain('cleanup_all => true');
    expect(scheduledLine({ ...none, split: null })).toBe('10 files scheduled');
  });
});

describe('the snapshots that Expire Snapshots takes', () => {
  const times = ['2026-09-01T00:00:00.000Z', '2026-10-20T00:00:00.000Z', '2026-11-02T00:00:00.000Z', null];

  it('counts the ones at least the age old, takes 30 days when the lake sets none, and says so', () => {
    const byDefault = splitExpirable(times, undefined, NOW);
    expect(byDefault).toMatchObject({ age: { text: '30 days', source: 'default' }, ready: 1, waiting: 3 });
    expect(splitExpirable(times, '5 days', NOW)).toMatchObject({ age: { source: 'option' }, ready: 2 });
    expect(splitExpirable(times, '1 month', NOW)).toBeUndefined();
    expect(expirableLine(byDefault ?? null)).toContain('1 snapshot expirable now, 3 younger than 30 days');
    expect(expirableNote(byDefault ?? null)).toContain('expires nothing');
    expect(expirableNote(splitExpirable(times, '5 days', NOW) ?? null)).toBe('');
    expect(expirableLine(null)).toBe('');
  });
});
