import { describe, expect, it } from 'vitest';
import { pyString } from '../../src/notebook/python';

// Each case is the text of the Python source that must come out, so a reader can see what Python will read.
const LITERALS: readonly [description: string, value: string, source: string][] = [
  ['plain text', 'sales', String.raw`'sales'`],
  ['the empty string', '', `''`],
  ['a single quote', "it's", String.raw`'it\'s'`],
  ['double quotes stay as they are', 'say "hi"', `'say "hi"'`],
  ['a Windows path', String.raw`C:\Users\x\lake.sqlite`, String.raw`'C:\\Users\\x\\lake.sqlite'`],
  ['a backslash before a quote', String.raw`a\'b`, String.raw`'a\\\'b'`],
  ['an escape sequence that must stay text', String.raw`\n\x41\u00e9`, String.raw`'\\n\\x41\\u00e9'`],
  ['a line feed, carriage return and tab', 'a\nb\r\nc\td', String.raw`'a\nb\r\nc\td'`],
  ['a NUL, a bell and DEL', '\u0000\u0007\u007f', String.raw`'\x00\x07\x7f'`],
  ['a C1 control character (NEL)', '\u0085', String.raw`'\x85'`],
  ['the line and paragraph separators', '\u2028\u2029', String.raw`'\u2028\u2029'`],
  ['bidirectional overrides, which could hide code', 'a\u202eb\u200fc', String.raw`'a\u202eb\u200fc'`],
  ['a byte order mark and a soft hyphen', '\ufeff\u00ad', String.raw`'\ufeff\xad'`],
  ['a tag character beyond the BMP', '\u{e0001}', String.raw`'\U000e0001'`],
  ['a lone surrogate', '\ud800', String.raw`'\ud800'`],
  ['German, CJK and emoji text is kept readable', 'Käse 日本語 😀', `'Käse 日本語 😀'`],
  ['an SQL injection attempt', `x'; DROP TABLE y; --`, String.raw`'x\'; DROP TABLE y; --'`],
];

/** What is left of a literal body after the escaped backslashes and quotes are taken out. */
const withoutEscapes = (body: string): string => body.replaceAll('\\\\', '').replaceAll("\\'", '');

const TRIPLE: readonly [description: string, value: string, source: string][] = [
  ['three quotes in a row', "a'''b", String.raw`'''a\'\'\'b'''`],
  ['a quote at the end', "x'", String.raw`'''x\''''`],
  ['a quote at the start', "'x", String.raw`'''\'x'''`],
  ['a line break', 'a\nb', String.raw`'''a\nb'''`],
  ['a backslash at the end', 'x\\', String.raw`'''x\\'''`],
];

describe('pyString', () => {
  it('writes every value as the Python source that reads back as that value, single-quoted or as a triple-quoted literal that cannot end early', () => {
    for (const [description, value, source] of LITERALS) {
      expect(pyString(value), description).toBe(source);
    }
    expect(pyString('SELECT 1', true)).toBe(`'''SELECT 1'''`);
    for (const [description, value, source] of TRIPLE) {
      expect(pyString(value, true), description).toBe(source);
    }
  });

  it('never leaves a raw quote, line break or control character inside the delimiters', () => {
    const hostile = [...LITERALS.map(([, value]) => value), "''''''", "\\\\'", 'a\u000bb\u000cc\u001cd'];
    for (const value of hostile) {
      const body = pyString(value).slice(1, -1);
      // eslint-disable-next-line no-control-regex
      expect(body).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
      expect(withoutEscapes(body)).not.toContain("'");
      expect(withoutEscapes(pyString(value, true).slice(3, -3))).not.toContain("'");
    }
  });
});
