// What the MCP tools check before a statement runs: exactly one statement, judged on DuckDB's tokens as the SQL editor
// cuts a script; for the tools that execute it, a statement that only reads (`statementKind`, which fails closed); and
// whether it may bind a view of the lake. Free of the VS Code API.
import type { SqlTokenizer } from '../dependencies/parser';
import { splitScript, statementSpans, withoutBom } from '../sql/script';
import type { Token } from '../sql/script';
import { statementKind } from '../sql/statement-kind';
import { isWord, unquote } from '../sql/tokens';
import { ToolError } from './catalog';

export interface CheckedStatement {
  /** The statement without comments around it and without its terminator. */
  readonly sql: string;
  readonly tokens: readonly Token[];
}

/**
 * The one statement of the text, and only one that DuckDB's tokens show to read. The sessions of the tools attach the
 * lake read-only, where DuckDB cannot even plan a change, so EXPLAIN of a change would fail all the same.
 */
export async function oneStatement(tokenizer: SqlTokenizer, text: string): Promise<CheckedStatement> {
  const source = withoutBom(text);
  const tokens = await tokenizer.tokenize(source);
  const spans = statementSpans(tokens);
  const [span] = spans;
  if (!span) throw new ToolError('The text holds no statement.');
  if (spans.length > 1) {
    throw new ToolError(`The text holds ${spans.length} statements; send one statement per call.`);
  }
  if (statementKind(span.tokens) !== 'reads') {
    throw new ToolError(
      'Only a statement that reads is taken (SELECT, FROM, WITH ... SELECT, a VALUES list, SUMMARIZE, DESCRIBE, SHOW). To check a change such as CREATE OR REPLACE VIEW, explain its SELECT; open the change itself with open_sql.',
    );
  }
  const [statement] = splitScript(source, tokens);
  return { sql: statement?.sql ?? source.trim(), tokens: span.tokens };
}

// A name in a string literal: `query('SELECT * FROM v')` binds the view all the same.
const WORDS = /[\p{L}\p{N}_$]+/gu;

/**
 * Whether the statement may bind one of the names (views, and macros that may read one): a name, quoted or not, or a
 * word of a string literal that equals one of them, ignoring case. It errs on the side of yes.
 */
export function mayName(tokens: readonly Token[], names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false;
  return tokens.some((token) => {
    if (token.type === 'STRING_LITERAL') {
      return [...token.word.matchAll(WORDS)].some(([word]) => names.has(word.toLowerCase()));
    }
    return isWord(token) && names.has(unquote(token.word).toLowerCase());
  });
}
