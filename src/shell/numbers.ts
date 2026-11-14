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

/** `~1,234` when the count is not exact, else `1,234`. */
export const approximateCount = (value: number, approximate = false): string =>
  `${approximate ? '~' : ''}${count(value)}`;

/** `12.5 %`, `100 %`, `0 %`; the share has one decimal at most. */
export function percent(ratio: number): string {
  return `${Number((ratio * 100).toFixed(1))} %`;
}

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

/** A time in seconds with more detail, for the plans and profiles of the SQL editor: `12 µs`, `3.45 ms`, `1.23 s`. */
export function secondsText(seconds: number): string {
  if (seconds < 0.001) return `${Math.round(seconds * 1_000_000)} µs`;
  if (seconds < 1) return `${(seconds * 1000).toFixed(2)} ms`;
  return `${seconds.toFixed(2)} s`;
}

/** Binary units (1 KB = 1024 B), one decimal at most. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    // Compare the rounded value: 1023.96 KB must become 1 MB, not "1024 KB".
    const rounded = Number(value.toFixed(1));
    if (rounded < 1024) {
      return `${rounded} ${unit}`;
    }
    value /= 1024;
  }
  return `${Number(value.toFixed(1))} TB`;
}
