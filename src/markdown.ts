// Markdown of catalog text that renders as written, and the building blocks of the Markdown documents of the reports.

// Escapes catalog text so no Markdown renders. CommonMark allows a backslash before any ASCII punctuation,
// which covers list markers, setext underlines, entities and bare URLs.
export function markdownText(text: string): string {
  return text
    .replace(INVISIBLE_EXCEPT_BREAKS, '')
    .replace(/[!-/:-@[-`{-~]/g, '\\$&')
    .replace(/\r?\n/g, '  \n');
}

// Control and invisible format characters (bidi overrides, zero-width joiners) and Unicode line/paragraph
// separators. They can reorder the surrounding text, so names and comments show without them.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
// Keeps tab and line breaks: markdownText turns comment line breaks into hard breaks.
const INVISIBLE_EXCEPT_BREAKS = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Catalog text without control and format characters (bidi overrides, zero-width joiners) and line separators, each
 * replaced by `by`: on one line, and nothing can reorder the text around it. For labels, pickers and comment lines.
 */
export const withoutInvisible = (text: string, by = ''): string => text.replace(INVISIBLE, by);

/** Catalog text as a label shows it, like the name in a code span: white space collapsed to one space, nothing invisible. */
export const visibleLine = (text: string): string => withoutInvisible(text.replace(/\s+/g, ' '));

// Code span for catalog text. Whitespace collapses to one space: a blank line would end the paragraph
// and render the rest of the name as Markdown.
export function inlineCode(raw: string): string {
  const text = visibleLine(raw);
  const fence = backticks(text, 1);
  const padding = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${text}${padding}${fence}`;
}

// Like `inlineCode` without the invisible characters, but the lines stay: a bidi override in the SQL of a view would
// reorder the text around it.
export function codeBlock(raw: string, language: string): string {
  const text = raw.replace(INVISIBLE_EXCEPT_BREAKS, '');
  const fence = backticks(text, 3);
  return `${fence}${language}\n${text}\n${fence}`;
}

// A backtick run longer than any inside the text, so the text cannot end its own code.
function backticks(text: string, minimum: number): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (run) => run[0].length));
  return '`'.repeat(Math.max(minimum, longest + 1));
}

// Catalog text in a table cell as code, so nothing renders. `inlineCode` makes it one line; a pipe would still
// end the cell, and GFM reads an escaped pipe inside code as the pipe itself.
export function code(value: string): string {
  return value.trim() === '' ? '' : inlineCode(value).replaceAll('|', '\\|');
}

export function markdownTable(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [row(header), row(header.map(() => '---')), ...rows.map(row)];
}

/** The first line of a report: `# Properties of Lake`, or `# Storage of Lake · schema shop`; the names show literally, on one line. */
export function reportTitle(title: string, connectionName: string, schema?: string): string {
  const oneLine = (text: string): string => markdownText(text.replace(/\s+/g, ' ').trim());
  return `# ${title} ${oneLine(connectionName)}${schema === undefined ? '' : ` · schema ${oneLine(schema)}`}`;
}

/** At most `limit` rows, then a line counting the rest. */
export function capRows<T>(rows: readonly T[], limit: number): { shown: T[]; omitted: string[] } {
  const rest = rows.length - limit;
  return rest > 0
    ? { shown: rows.slice(0, limit), omitted: ['', `… ${rest} more omitted (limit: ${limit}).`] }
    : { shown: [...rows], omitted: [] };
}

/** The chosen kinds of a filter in words: `all`, their labels, or `none`. */
export function kindsText<Kind extends string>(
  chosen: readonly Kind[],
  all: readonly Kind[],
  label: Readonly<Record<Kind, string>>,
): string {
  return chosen.length === all.length ? 'all' : chosen.map((kind) => label[kind]).join(', ') || 'none';
}
