const integer = new Intl.NumberFormat('en-US');

/** `1,234`. */
export const count = (value: number): string => integer.format(value);

/** `1 file`, `3 files`. */
export const plural = (value: number, one: string, many = `${one}s`): string =>
  `${value} ${value === 1 ? one : many}`;

/** `1 file`, `1,000 files`. */
export const groupedPlural = (value: number, one: string, many = `${one}s`): string =>
  `${count(value)} ${value === 1 ? one : many}`;

export const files = (value: number): string => groupedPlural(value, 'file');

/**
 * How long something has waited, in the largest whole unit: `12 minutes`, `30 hours`, `3 days`; hours up to two days,
 * so that a wait just over one day does not read as one day. Under a minute it says so.
 */
export function waitText(ms: number): string {
  const minutes = Math.floor(Math.max(ms, 0) / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return groupedPlural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return groupedPlural(hours, 'hour');
  return groupedPlural(Math.floor(hours / 24), 'day');
}

/** How long something took: `12 ms` below a second, `3.4 s` above. The grid, the results and the health report. */
export const formatDuration = (ms: number): string =>
  Math.round(ms) < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
