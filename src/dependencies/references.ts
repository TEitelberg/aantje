import { isObject } from '../guards';
import { statementReferences } from '../sql/parse-tree';
import type { References } from '../sql/parse-tree';

type Failure = { readonly reason: 'syntax' | 'unsupported'; readonly detail: string };
type Extraction = References | Failure;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** One line of at most 200 characters, for a DuckDB message that may quote the statement. */
export const messageLine = (message: string): string => {
  const line = message.replace(/\s+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
};

/** The one statement of a `json_serialize_sql` document; an error, or a document of another number, gives the reason. */
export function parsedStatement(serialized: string): { readonly statement: unknown } | Failure {
  let document: unknown;
  try {
    document = JSON.parse(serialized);
  } catch {
    return { reason: 'unsupported', detail: 'DuckDB gave no readable answer' };
  }
  if (!isObject(document)) {
    return { reason: 'unsupported', detail: 'DuckDB gave no readable answer' };
  }
  if (document['error'] === true) {
    return {
      reason: document['error_type'] === 'parser' ? 'syntax' : 'unsupported',
      detail: messageLine(text(document['error_message'])),
    };
  }
  const statements = Array.isArray(document['statements']) ? (document['statements'] as unknown[]) : [];
  if (statements.length !== 1) {
    return { reason: 'unsupported', detail: 'the text is not exactly one SELECT statement' };
  }
  return { statement: statements[0] };
}

/** The tables, views and functions a `json_serialize_sql` document names, CTEs left out; an error gives the reason. */
export function extract(serialized: string): Extraction {
  const parsed = parsedStatement(serialized);
  return 'reason' in parsed ? parsed : statementReferences(parsed.statement);
}
