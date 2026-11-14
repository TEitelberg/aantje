import { foldIdentifier } from '../catalog/ddl';
import { isObject } from '../guards';
import { syntaxErrorsOf } from './syntax';
import type { Diagnostic } from './syntax';
import { isWord, keywordOf, unquote } from './tokens';
import type { SqlToken } from './tokens';
import { spanRange, statementSpans } from './script';
import { isSerialized } from './statement-kind';
import type { ParsedQuery } from './unknown-names';

/** What the check while typing learns from parsing a text. */
export interface ParsedText {
  readonly errors: readonly Diagnostic[];
  /** The queries of a text without syntax errors, when they were asked for. */
  readonly queries: readonly ParsedQuery[];
  /** Lower case words of the statements that are no queries. */
  readonly mentioned: ReadonlySet<string>;
  /** A statement changes where names resolve: USE, ATTACH, DETACH, SET search_path or schema. */
  readonly qualifiedOnly: boolean;
}

/** DuckDB as the parse needs it; nothing given is run. */
export interface Parser {
  /** The `json_serialize_sql` document of a text. */
  serialize(text: string): Promise<string>;
  /** Every token of a text, with UTF-16 offsets. */
  tokens(text: string): Promise<readonly SqlToken[]>;
}

const NOTHING: ReadonlySet<string> = new Set();

/**
 * Parses the text once. DuckDB serializes nothing of a text that holds a statement other than a query, so the queries
 * of such a text are parsed again one by one; the other statements give the words they name.
 */
export async function parseText(parser: Parser, text: string, withQueries: boolean): Promise<ParsedText> {
  const serialized = await parser.serialize(text);
  const errors = syntaxErrorsOf(serialized, text);
  const none: ParsedText = { errors, queries: [], mentioned: NOTHING, qualifiedOnly: false };
  if (errors.length > 0 || !withQueries) return none;
  const document = documentOf(serialized);
  const statements = statementsOf(document);
  if (statements) {
    return { ...none, queries: statements.map((statement) => ({ statement, text, offset: 0 })) };
  }
  return document?.['error_type'] === 'not implemented' ? parseEach(parser, text) : none;
}

async function parseEach(parser: Parser, text: string): Promise<ParsedText> {
  const queries: ParsedQuery[] = [];
  const mentioned = new Set<string>();
  let qualifiedOnly = false;
  for (const statement of statementsIn(await parser.tokens(text))) {
    const sql = text.slice(statement.start, statement.end);
    const query = isSerialized(statement.keyword);
    const [tree, ...more] = (query ? statementsOf(documentOf(await parser.serialize(sql))) : undefined) ?? [];
    if (tree !== undefined && more.length === 0) {
      queries.push({ statement: tree, text: sql, offset: statement.start });
    } else {
      for (const word of statement.words) mentioned.add(word);
      qualifiedOnly ||= changesResolution(statement);
    }
  }
  return { errors: [], queries, mentioned, qualifiedOnly };
}

function documentOf(serialized: string): Record<string, unknown> | undefined {
  try {
    const document: unknown = JSON.parse(serialized);
    return isObject(document) ? document : undefined;
  } catch {
    return undefined;
  }
}

function statementsOf(document: Record<string, unknown> | undefined): unknown[] | undefined {
  return document?.['error'] === false && Array.isArray(document['statements'])
    ? document['statements']
    : undefined;
}

interface Statement {
  readonly start: number;
  readonly end: number;
  /** The first word in upper case: `(SELECT 1)` is a SELECT. */
  readonly keyword: string;
  /** Its words without quotes, in lower case. */
  readonly words: readonly string[];
}

// The statements between the terminators, without the comments around them.
function statementsIn(tokens: readonly SqlToken[]): Statement[] {
  return statementSpans(tokens).map(({ tokens: span }) => {
    const words = span.filter(isWord);
    return {
      ...spanRange(span),
      keyword: keywordOf(words[0]) ?? '',
      words: words.map((token) => foldIdentifier(unquote(token.word))),
    };
  });
}

function changesResolution({ keyword, words }: Statement): boolean {
  if (keyword === 'USE' || keyword === 'ATTACH' || keyword === 'DETACH') return true;
  const setting = words.slice(1, 3);
  return (
    (keyword === 'SET' || keyword === 'RESET') &&
    (setting.includes('search_path') || setting.includes('schema'))
  );
}
