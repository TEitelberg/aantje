const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|([+-]\d{2})(?::?(\d{2}))?)$/;

/**
 * ISO 8601 UTC with millisecond precision. SQLite keeps DuckDB's text with the writer's session offset (`2026-10-29
 * 21:22:46.430739+00`, `...+05:30`). A time without a zone is rejected, not guessed.
 */
export function toIsoUtc(value: string): string {
  const match = TIMESTAMP.exec(value.trim());
  if (!match) {
    throw new Error(`Unrecognised timestamp "${value}".`);
  }
  const [, date, time, fraction = '', hours = '+00', minutes = '00'] = match;
  const offset = `${hours}:${minutes}`;
  return new Date(`${date}T${time}.${fraction.padEnd(3, '0').slice(0, 3)}${offset}`).toISOString();
}
