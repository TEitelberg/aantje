import { describe, expect, it } from 'vitest';
import { isAborted } from '../../src/data/aborted';
import { maxRowsOf, parseDataSettings, timeoutMsOf } from '../../src/data/settings';
import { AantjeError } from '../../src/errors';

const lookup =
  (values: Record<string, unknown>) =>
  (key: string): unknown =>
    values[key];

const UNSET = {
  s3: { endpoint: undefined, region: undefined, urlStyle: undefined },
  extensionDirectory: undefined,
};

describe('the data settings', () => {
  it('are read trimmed; an empty text, an unknown URL style and a value that is no text count as not set', () => {
    expect(
      parseDataSettings(
        lookup({
          's3.endpoint': ' minio.local:9000 ',
          's3.region': 'eu-central-1',
          's3.urlStyle': 'vhost',
          'duckdb.extensionDirectory': ' D:\\duckdb-extensions ',
        }),
      ),
    ).toEqual({
      s3: { endpoint: 'minio.local:9000', region: 'eu-central-1', urlStyle: 'vhost' },
      extensionDirectory: 'D:\\duckdb-extensions',
    });
    expect(
      parseDataSettings(
        lookup({
          's3.endpoint': '',
          's3.region': '   ',
          's3.urlStyle': 'bucket',
          'duckdb.extensionDirectory': '',
        }),
      ),
    ).toEqual(UNSET);
    for (const value of [5, true, null, undefined, ['a'], { path: 'x' }]) {
      const same = {
        's3.endpoint': value,
        's3.region': value,
        's3.urlStyle': value,
        'duckdb.extensionDirectory': value,
      };
      expect(parseDataSettings(lookup(same)), JSON.stringify(value)).toEqual(UNSET);
    }
  });
});

describe('the time limit', () => {
  it('is the configured seconds in milliseconds, 30 s for anything that would break every query, and at most one day because a larger number overflows the timers', () => {
    expect(timeoutMsOf(45)).toBe(45_000);
    expect(timeoutMsOf(1)).toBe(1_000);
    for (const value of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, '10', null]) {
      expect(timeoutMsOf(value), JSON.stringify(value)).toBe(30_000);
    }
    expect(timeoutMsOf(86_400)).toBe(86_400_000);
    expect(timeoutMsOf(5_000_000)).toBe(86_400_000);
    expect(() => AbortSignal.timeout(timeoutMsOf(5_000_000_000))).not.toThrow();
  });
});

describe('what counts as the user stopping an action', () => {
  it('is an ABORTED error and nothing else', () => {
    expect(isAborted(new AantjeError('ABORTED', 'Cancelled.'))).toBe(true);
    expect(isAborted(new AantjeError('TIMEOUT', 'Too slow.'))).toBe(false);
    expect(isAborted(new AantjeError('QUERY_FAILED', 'Failed.'))).toBe(false);
    expect(isAborted(new Error('ABORTED'))).toBe(false);
    expect(isAborted('ABORTED')).toBe(false);
  });
});

describe('the row limit', () => {
  it('reads aantje.sql.maxRows as a whole number between 1 and 1,000,000, 10,000 for anything else', () => {
    const table: [unknown, number][] = [
      [undefined, 10_000],
      ['5', 10_000],
      [Number.NaN, 10_000],
      [0, 10_000],
      [-5, 10_000],
      [1, 1],
      [2.9, 2],
      [10_000, 10_000],
      [5_000_000, 1_000_000],
    ];
    for (const [value, expected] of table) {
      expect(maxRowsOf(value), JSON.stringify(value)).toBe(expected);
    }
  });
});
