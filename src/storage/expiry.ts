import type { ResolvedStorage } from './config';

// When a shared access signature runs out. The date is part of the token (`se=2026-12-31T00:00:00Z`), so the health check
// can say "expired" before any request fails. Only the date is read and returned; the token itself is never repeated.

const EXPIRY = /(?:^|[?&;\s])se=([^&;\s]+)/;

/** The expiry (milliseconds since 1970) in a SAS token or in a connection string that holds one; undefined without one. */
export function sasExpiry(text: string): number | undefined {
  const raw = EXPIRY.exec(text)?.[1];
  if (raw === undefined) {
    return undefined;
  }
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // Keep the raw text; a date does not need decoding.
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

/** The expiry of the SAS a storage signs in with (a token, or a connection string with one); undefined for any other sign-in. */
export function storageExpiry(storage: ResolvedStorage | undefined): number | undefined {
  if (storage?.config.kind !== 'azure') {
    return undefined;
  }
  switch (storage.config.signIn) {
    case 'sas':
      return sasExpiry(storage.values.sasToken ?? '');
    case 'connectionString':
      return sasExpiry(storage.values.connectionString ?? '');
    default:
      return undefined;
  }
}
