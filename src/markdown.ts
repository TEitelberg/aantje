import { inlineCode, markdownText } from './tree/format';

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
