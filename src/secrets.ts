// One secret-masking implementation, shared by the logger (`src/log.ts`) and the engine error path
// (`src/data/errors.ts`). A secret appears in text in several shapes: raw, URL-encoded (a password a URL builder wrote
// into `scheme://user:password@host`), JSON-escaped (a message that was serialised) and with doubled single quotes (a
// SQL literal that an engine echoes). All forms are masked, the longest first so that a secret that prefixes another, or
// a mask that would otherwise be rescanned, cannot leave a remainder behind.

export const SECRET_MASK = '***';

// A shorter value would garble the text ("" matches between all characters, two characters match too much); no real
// secret is that short, so a one- or two-character value is ignored rather than masked.
export const MIN_SECRET_LENGTH = 3;

/** The forms a secret can take in text: raw, URL-encoded, JSON-escaped and SQL-doubled-quote. */
function secretForms(value: string): string[] {
  return [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1), value.replaceAll("'", "''")];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One regular expression that matches every form of every secret of at least `MIN_SECRET_LENGTH` characters, longest
 * form first. Undefined when no value qualifies, so the caller can leave the text untouched.
 */
export function maskPattern(secrets: Iterable<string>): RegExp | undefined {
  const forms = new Set<string>();
  for (const value of secrets) {
    if (value.length >= MIN_SECRET_LENGTH) {
      for (const form of secretForms(value)) {
        forms.add(form);
      }
    }
  }
  if (forms.size === 0) {
    return undefined;
  }
  const longestFirst = [...forms].sort((a, b) => b.length - a.length);
  return new RegExp(longestFirst.map(escapeRegExp).join('|'), 'g');
}

/** Replaces every form of every secret with `***`; text without a qualifying secret is returned unchanged. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  const pattern = maskPattern(secrets);
  return pattern ? text.replace(pattern, SECRET_MASK) : text;
}
