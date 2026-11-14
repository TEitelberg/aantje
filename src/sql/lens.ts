import { wholeNumberOf } from '../data/settings';
import { spanRange, statementSpanAt, statementSpans } from './script';
import { runsQuery, statementKind, writes } from './statement-kind';
import { closing, isClose, isOpen, isWord, keywordOf } from './tokens';
import type { SqlToken } from './tokens';

/** A statement with lenses: its own Execute | Explain | Analysis | Statistics, those of its CTEs, or both. */
export interface LensStatement {
  readonly start: number;
  readonly end: number;
  /** Whether the statement gets a lens of its own: a query or a write built on one, not a view that stores a query. */
  readonly query: boolean;
  /** Whether the statement is known to only read, so that EXPLAIN ANALYZE cannot change anything. */
  readonly readsOnly: boolean;
  /** The CTEs of the outermost WITH that only read, each runnable on its own. */
  readonly ctes: readonly LensCte[];
}

export interface LensCte {
  /** The name as written, quotes included. */
  readonly name: string;
  /** From the name to the closing parenthesis of its body. */
  readonly start: number;
  readonly end: number;
  /** `WITH` the CTEs written before it and itself (all of them for `WITH RECURSIVE`), then `SELECT * FROM` it. */
  readonly sql: string;
}

/** What a lens or a menu entry does with a statement. */
export type LensAction = 'execute' | 'explain' | 'analyze' | 'profile';

interface CteSpan {
  readonly name: SqlToken;
  readonly first: number;
  readonly last: number;
}

/** The CTEs of the first WITH outside parentheses, or none when the list is not understood. */
function cteSpans(tokens: readonly SqlToken[]): { recursive: boolean; spans: CteSpan[] } {
  let depth = 0;
  let at = tokens.findIndex((token) => {
    if (isOpen(token)) depth++;
    else if (isClose(token)) depth--;
    return depth === 0 && keywordOf(token) === 'WITH';
  });
  if (at < 0) return { recursive: false, spans: [] };
  at++;
  const recursive = keywordOf(tokens[at]) === 'RECURSIVE';
  if (recursive) at++;
  const spans: CteSpan[] = [];
  for (;;) {
    const name = tokens[at];
    if (!name || !isWord(name)) return { recursive, spans: [] };
    const first = at++;
    if (isOpen(tokens[at])) at = closing(tokens, at) + 1;
    // DuckDB: WITH RECURSIVE t(x) USING KEY (x) AS (...)
    if (keywordOf(tokens[at]) === 'USING' && keywordOf(tokens[at + 1]) === 'KEY' && isOpen(tokens[at + 2])) {
      at = closing(tokens, at + 2) + 1;
    }
    if (at <= 0 || keywordOf(tokens[at]) !== 'AS') return { recursive, spans: [] };
    at++;
    if (keywordOf(tokens[at]) === 'NOT') at++;
    if (keywordOf(tokens[at]) === 'MATERIALIZED') at++;
    if (!isOpen(tokens[at])) return { recursive, spans: [] };
    const last = closing(tokens, at);
    if (last < 0) return { recursive, spans: [] };
    spans.push({ name, first, last });
    at = last + 1;
    if (tokens[at]?.type !== 'OPERATOR' || tokens[at]?.word !== ',') return { recursive, spans };
    at++;
  }
}

/** The CTEs of a statement that can run on their own: built from the text as written, only those that only read. */
function ctesOf(text: string, tokens: readonly SqlToken[]): LensCte[] {
  const { recursive, spans } = cteSpans(tokens);
  return spans.flatMap((span, index) => {
    const used = recursive ? spans : spans.slice(0, index + 1);
    if (used.some(({ first, last }) => writes(tokens.slice(first, last + 1)))) return [];
    const parts = used.map(({ name, last }) => text.slice(name.start, tokens[last]?.end));
    const start = span.name.start;
    return [
      {
        name: span.name.word,
        start,
        end: tokens[span.last]?.end ?? start,
        sql: `WITH ${recursive ? 'RECURSIVE ' : ''}${parts.join(',\n')}\nSELECT * FROM ${span.name.word}`,
      },
    ];
  });
}

function lensStatement(text: string, span: readonly [SqlToken, ...SqlToken[]]): LensStatement {
  return {
    ...spanRange(span),
    query: runsQuery(span),
    readsOnly: statementKind(span) === 'reads',
    ctes: ctesOf(text, span),
  };
}

/** The statements of a document with lenses: queries and writes built on one, and any statement with runnable CTEs. */
export function lensStatements(text: string, tokens: readonly SqlToken[]): LensStatement[] {
  return statementSpans(tokens).flatMap(({ tokens: span }) => {
    const statement = lensStatement(text, span);
    return statement.query || statement.ctes.length > 0 ? [statement] : [];
  });
}

/** The statement at the offset, picked as Run Statement picks it (text between statements belongs to the one before). */
export function statementOf(
  text: string,
  tokens: readonly SqlToken[],
  offset: number,
): LensStatement | undefined {
  const span = statementSpanAt(tokens, offset);
  return span && lensStatement(text, span.tokens);
}

// The setting `aantje.sql.cteRowLimit`; keep the maximum in step with package.json.
const DEFAULT_CTE_ROW_LIMIT = 100;
const MAX_CTE_ROW_LIMIT = 1_000_000;

/** Rows of Execute on a CTE: the setting `aantje.sql.cteRowLimit`, read as `aantje.sql.maxRows` is: 1 to 1 000 000. */
export function cteRowLimitOf(value: unknown): number {
  return wholeNumberOf(value, { min: 1, max: MAX_CTE_ROW_LIMIT, fallback: DEFAULT_CTE_ROW_LIMIT });
}

/** The SQL that runs an action on a statement; `limit` applies to Execute of a CTE, undefined runs all rows. */
export function actionSql(action: LensAction, sql: string, limit?: number): string {
  return `${actionPrefix(action)}${limit === undefined ? sql : `${sql}\nLIMIT ${limit}`}`;
}

/** The prefix that an action puts in front of the statement, so that error positions map back to the document. */
export function actionPrefix(action: LensAction): string {
  // JSON, so that the results draw the plan as a tree; a typed EXPLAIN keeps DuckDB's text.
  return action === 'explain'
    ? 'EXPLAIN (FORMAT JSON) '
    : action === 'analyze'
      ? 'EXPLAIN (ANALYZE, FORMAT JSON) '
      : '';
}
