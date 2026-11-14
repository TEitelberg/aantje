import { quoteLiteral } from '../catalog/ddl';

// The statements that ask the object store of a lake through DuckDB: a listing of a directory, a probe, a file by its
// path. The health check and the advisor share them.

/** A path as a DuckDB pattern; pattern characters become classes (`[*]`), so brackets and asterisks match themselves. */
export function escapeGlob(path: string): string {
  return path.replaceAll('\\', '/').replace(/[*?[]/g, (character) => `[${character}]`);
}

// The `read_blob` pattern for everything below a directory; DuckDB lists by the prefix up to the first wildcard.
function listingPattern(directory: string): string {
  const escaped = escapeGlob(directory);
  return `${escaped.endsWith('/') ? escaped : `${escaped}/`}**`;
}

// Lists keys below a directory with size and time, in key order, at most `limit + 1`. DuckDB lists the whole prefix
// anyway (one request per 1000 keys); selecting the size keeps it from requesting each file.
export function listingStatement(directory: string, limit: number): string {
  return `SELECT filename, size, epoch_ms(last_modified) FROM read_blob(${quoteLiteral(listingPattern(directory))}) ORDER BY filename LIMIT ${limit + 1}`;
}

// The probe asks the store for this name; it matches nothing.
export const PROBE_NAME = 'aantje-health-probe-';

/** Asks the store for one answer with minimal listing: nothing matches the pattern. */
export function probeStatement(directory: string): string {
  const escaped = escapeGlob(directory);
  return `SELECT count(*) FROM glob(${quoteLiteral(`${escaped.endsWith('/') ? escaped : `${escaped}/`}${PROBE_NAME}*`)})`;
}
