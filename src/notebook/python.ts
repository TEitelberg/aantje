const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

// Control, format (bidirectional overrides could hide code), separator and surrogate characters; other text is valid.
const ESCAPED = /[\\'\n\r\t]|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

/** A Python string literal that evaluates to exactly `value`; `triple` writes `'''...'''`. */
export function pyString(value: string, triple = false): string {
  const quote = triple ? "'''" : "'";
  return quote + value.replace(ESCAPED, escape) + quote;
}

function escape(character: string): string {
  const short = SHORT_ESCAPES[character];
  if (short !== undefined) {
    return short;
  }
  const code = character.codePointAt(0) ?? 0;
  if (code < 0x100) {
    return `\\x${hex(code, 2)}`;
  }
  return code < 0x10000 ? `\\u${hex(code, 4)}` : `\\U${hex(code, 8)}`;
}

function hex(code: number, digits: number): string {
  return code.toString(16).padStart(digits, '0');
}
