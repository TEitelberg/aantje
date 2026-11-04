import { describe, expect, it } from 'vitest';
import { count, files, formatUtc, groupedPlural, plural, shortUtc, tableLabel } from '../../src/shell/model';
import { formatDuration, waitText } from '../../src/shell/numbers';

describe('numbers in words', () => {
  it('writes the number with thousands separators for a count', () => {
    expect([count(0), count(999), count(1000), count(1234567)]).toEqual(['0', '999', '1,000', '1,234,567']);
  });

  it('takes the singular only for one, and the plural for zero and for the rest', () => {
    expect([plural(1, 'file'), plural(0, 'file'), plural(2, 'file')]).toEqual([
      '1 file',
      '0 files',
      '2 files',
    ]);
  });

  it('takes the plural that the caller names, for words that add no s', () => {
    expect([plural(1, 'check could', 'checks could'), plural(3, 'check could', 'checks could')]).toEqual([
      '1 check could',
      '3 checks could',
    ]);
  });

  it('writes the number of a plural as it is, and the grouped one with thousands separators', () => {
    expect(plural(1050, 'table')).toBe('1050 tables');
    expect(groupedPlural(1050, 'table')).toBe('1,050 tables');
    expect(groupedPlural(1, 'table')).toBe('1 table');
    expect(groupedPlural(1, 'more file is', 'more files are')).toBe('1 more file is');
    expect(groupedPlural(2, 'more file is', 'more files are')).toBe('2 more files are');
  });

  it('counts files with the separators', () => {
    expect([files(1), files(0), files(12000)]).toEqual(['1 file', '0 files', '12,000 files']);
  });
});

describe('the name of a table in a report', () => {
  it('is the schema and the name with a dot, unquoted, or the name alone when the catalog has no schema row', () => {
    expect(tableLabel({ schema: 'shop', name: 'events' })).toBe('shop.events');
    expect(tableLabel({ schema: null, name: 'events' })).toBe('events');
    expect(tableLabel({ schema: '', name: 'events' })).toBe('.events');
  });
});

describe('the time of a snapshot', () => {
  it('is cut at the second and without the zone for a table whose header names it', () => {
    expect(formatUtc('2026-03-04T05:06:07.891Z')).toBe('2026-03-04 05:06:07 UTC');
    expect(shortUtc('2026-03-04T05:06:07.891Z')).toBe('2026-03-04 05:06:07');
  });
});

describe('waits and durations', () => {
  it('names a wait in its largest whole unit with hours up to two days, and a duration in ms below a second', () => {
    const minute = 60_000;
    expect(
      [0.5, 12, 90, 47 * 60, 49 * 60, 10 * 24 * 60].map((minutes) => waitText(minutes * minute)),
    ).toEqual(['less than a minute', '12 minutes', '1 hour', '47 hours', '2 days', '10 days']);
    expect([12.4, 999.6, 1234.5].map(formatDuration)).toEqual(['12 ms', '1.0 s', '1.2 s']);
  });
});
