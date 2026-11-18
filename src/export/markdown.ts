// Markdown tables of rows: Copy as Markdown and the Markdown export of the grid in the page, and the Markdown file of Run to
// File and Export, which DuckDB writes with the same rules in SQL (`copy.ts`). Every value and column name is data:
// what would end a cell or render as Markdown or HTML gets a backslash, so the table shows the text as written.

/** How a NULL shows in a Markdown table: an empty cell, or the word NULL (setting `aantje.export.markdownNull`). */
export type MarkdownNull = 'empty' | 'null';

/** Rows above which Run to File and Export ask before they write a Markdown table: a longer one is hard to read. */
export const MARKDOWN_ASK_ROWS = 10_000;

/** The characters that end a cell (`|`), escape (`\`) or start Markdown or HTML: code, emphasis, links, tags, entities. */
const SPECIAL = /[\\|`*_~[\]<>&]/g;
/** A line break would end the row; the cell shows it as `<br>`, which GitHub renders as a break in a table. */
const LINE_BREAK = /\r\n|\r|\n/g;

/** The same two rules for DuckDB's `regexp_replace` (RE2): the pattern and the replacement of each. */
export const SQL_SPECIAL: readonly [string, string] = ['([\\\\|`*_~\\[\\]<>&])', '\\\\\\1'];
export const SQL_LINE_BREAK: readonly [string, string] = ['\\r\\n|\\r|\\n', '<br>'];

/** A value or a column name as the text of a cell. */
export function markdownCell(text: string): string {
  return text.replace(SPECIAL, '\\$&').replace(LINE_BREAK, '<br>');
}

/** The text of a NULL cell. */
export function nullCell(nulls: MarkdownNull): string {
  return nulls === 'null' ? 'NULL' : '';
}

/** One row of a table from the text of its cells. */
export function markdownRow(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

/** The header of a table, with the line below it, each ending in a line break. */
export function markdownHead(names: readonly string[]): string {
  return `${markdownRow(names.map(markdownCell))}\n${markdownRow(names.map(() => '---'))}\n`;
}
