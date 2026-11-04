import type { S3Settings } from './types';

export interface DataSettings {
  readonly s3: S3Settings;
  readonly extensionDirectory?: string;
}

/** Data settings from a lookup by key; an empty or non-text value counts as unset. */
export function parseDataSettings(get: (key: string) => unknown): DataSettings {
  const text = (key: string): string | undefined => {
    const value = get(key);
    return (typeof value === 'string' ? value.trim() : '') || undefined;
  };
  const urlStyle = text('s3.urlStyle');
  return {
    s3: {
      endpoint: text('s3.endpoint'),
      region: text('s3.region'),
      urlStyle: urlStyle === 'path' || urlStyle === 'vhost' ? urlStyle : undefined,
    },
    extensionDirectory: text('duckdb.extensionDirectory'),
  };
}

const DEFAULT_TIMEOUT_SECONDS = 30;
// One day; more overflows the limit timers. Keep in step with the "maximum" in package.json.
const MAX_TIMEOUT_SECONDS = 86_400;

/**
 * Time limit in ms for `aantje.queryTimeoutSeconds`. The manifest's "minimum" and "maximum" are only editor hints: a
 * missing or invalid value gets the default (it would break every query), a huge one the maximum.
 */
export function timeoutMsOf(seconds: unknown): number {
  const valid = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0;
  return Math.min(valid ? seconds : DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS) * 1000;
}

/** Most rows kept per result set unless the caller sets another limit. */
export const DEFAULT_MAX_ROWS = 10_000;
const MAX_MAX_ROWS = 1_000_000;

/** The setting `aantje.sql.maxRows`: a whole number from 1 to 1 000 000, else the default. */
export function maxRowsOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.min(Math.floor(value), MAX_MAX_ROWS)
    : DEFAULT_MAX_ROWS;
}
