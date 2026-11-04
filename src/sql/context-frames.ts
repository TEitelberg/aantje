// The frames and tokens of DuckDB's own constructs: lambdas, the lists of `* EXCLUDE`, `REPLACE` and `RENAME`,
// window specifications, PIVOT and UNPIVOT, and the options of `COPY ... TO`.
import { newFrame } from './context-clauses';
import type { Around, Frame } from './context-clauses';
import { startsItem } from './position';
import type { FrameKind } from './position';
import { isWord, keywordOf, unquote } from './tokens';
import type { SqlToken } from './tokens';

const STAR_LISTS: Readonly<Record<string, FrameKind>> = {
  EXCLUDE: 'columns',
  REPLACE: 'replace',
  RENAME: 'rename',
};

const WINDOW_PARTS: Readonly<Record<string, string>> = {
  PARTITION: 'partition',
  ORDER: 'order',
  ROWS: 'rows',
  RANGE: 'rows',
  GROUPS: 'rows',
};

/** Whether the frame is right after the `*` of all columns or one of its modifiers once the token is read. */
export function followsStar(frame: Frame, { token, previous }: Around): boolean {
  if (token.word === '*' && token.type === 'OPERATOR') return startsItem(previous);
  return frame.afterStar && STAR_LISTS[keywordOf(token) ?? ''] !== undefined;
}

/** Reads a token of DuckDB's own constructs; true when nothing else may read it (the head of a lambda). */
export function duckdbToken(frame: Frame, at: Around): boolean {
  if (lambdaToken(frame, at)) return true;
  copyToken(frame, at);
  const keyword = keywordOf(at.token);
  if (frame.kind === 'window' && keyword) windowWord(frame, keyword, at.next);
  return false;
}

// `lambda x, y: body`: the body ends at a comma of the frame outside brackets, or with the frame. The arrow `x -> body`
// is not read: DuckDB 2.0 refuses it by default, and `->` is also the JSON operator.
function lambdaToken(frame: Frame, { token }: Around): boolean {
  const { lambda } = frame;
  if (keywordOf(token) === 'LAMBDA') {
    frame.lambda = { params: [], body: false };
    return true;
  }
  if (lambda && !lambda.body) {
    if (token.word === ':') lambda.body = true;
    else if (isWord(token)) lambda.params.push(unquote(token.word));
    return true;
  }
  if (token.word === '[' || token.word === '{') frame.brackets += 1;
  else if (token.word === ']' || token.word === '}') frame.brackets = Math.max(0, frame.brackets - 1);
  else if (token.word === ',' && frame.brackets === 0) frame.lambda = undefined;
  return false;
}

// The text of a string literal or a word, without quotes; a string may lack its closing quote.
const textOf = (token: SqlToken): string =>
  token.type === 'STRING_LITERAL' ? token.word.replace(/^'/, '').replace(/'$/, '') : unquote(token.word);

/** COPY takes the format from the file's extension when no FORMAT is given, CSV otherwise. */
export function formatOf(path: string): string {
  const name = path.toLowerCase();
  if (/\.parquet(\.\w+)?$/.test(name)) return 'parquet';
  return /\.(json|ndjson|jsonl)(\.\w+)?$/.test(name) ? 'json' : 'csv';
}

// The file of `COPY ... TO 'file'`, and in the options after it the names given and the value of FORMAT.
function copyToken(frame: Frame, { token, previous }: Around): void {
  if (frame.clause === 'copy-to' && token.type === 'STRING_LITERAL') {
    frame.copy = { format: formatOf(textOf(token)), given: [] };
    return;
  }
  const { copy } = frame;
  if (frame.kind !== 'copy-options' || !copy) return;
  if (keywordOf(previous) === 'FORMAT') {
    copy.format = textOf(token).toLowerCase();
  } else if (isWord(token) && (previous?.word === '(' || previous?.word === ',')) {
    copy.given.push(unquote(token.word).toLowerCase());
  }
}

function windowWord(frame: Frame, keyword: string, next: SqlToken | undefined): void {
  const part = WINDOW_PARTS[keyword];
  // `range(` is a function.
  if (part && next?.word !== '(') frame.clause = part;
  else if (keyword === 'BETWEEN' && frame.clause === 'rows') frame.clause = 'between';
  else if (keyword === 'AND' && frame.clause === 'between') frame.clause = 'and';
  else if (keyword === 'EXCLUDE' && (frame.clause === 'rows' || frame.clause === 'and'))
    frame.clause = 'exclude';
}

/** The keywords that may come next in a window specification, named by its part and the word before the cursor. */
export function windowClause(clause: string, prev: readonly SqlToken[]): string {
  const word = keywordOf(prev.at(-1));
  if (clause === 'exclude') return word === 'EXCLUDE' ? 'exclude' : word === 'CURRENT' ? 'frame-current' : '';
  if (clause !== 'rows' && clause !== 'between' && clause !== 'and') return clause;
  switch (word) {
    case 'ROWS':
    case 'RANGE':
    case 'GROUPS':
      return 'frame';
    case 'BETWEEN':
      return 'frame-start';
    case 'AND':
      return 'frame-end';
    case 'CURRENT':
      return 'frame-current';
    case 'PRECEDING':
    case 'FOLLOWING':
    case 'ROW':
      return clause === 'between' ? 'frame-and' : 'frame-exclude';
    default:
      // An offset (`3`, `INTERVAL 1 DAY`) or UNBOUNDED.
      return 'frame-direction';
  }
}

/** The frame that a `(` opens in one of DuckDB's own constructs; undefined for any other parenthesis. */
export function duckdbFrame(frame: Frame, previous: SqlToken | undefined): Frame | undefined {
  const keyword = keywordOf(previous) ?? '';
  // PARTITION_BY (...), FORCE_QUOTE (...): columns of the table that is copied.
  if (frame.kind === 'copy-options') return newFrame('column-list', frame);
  if (keyword === 'OVER' || (frame.clause === 'window' && keyword === 'AS')) {
    return newFrame('window', frame, { clause: 'over' });
  }
  const star = STAR_LISTS[keyword];
  if (star && frame.afterStar) return newFrame(star, frame);
  if (keyword === 'IN') return inFrame(frame);
  if ((keyword === 'PIVOT' || keyword === 'UNPIVOT') && frame.clause === 'from' && frame.afterRelation) {
    return pivotFrame(frame, keyword);
  }
  if (frame.clause === 'copy-to') {
    return newFrame('copy-options', frame, { copy: frame.copy ?? { format: 'csv', given: [] } });
  }
  return frame.clause === 'copy-from' ? newFrame('quiet', frame) : undefined;
}

// `IN (` of PIVOT holds values, of `UNPIVOT (... FOR name IN (` the columns that are turned into rows.
function inFrame(frame: Frame): Frame | undefined {
  if (frame.kind === 'pivot') return newFrame(frame.name === 'UNPIVOT' ? 'columns' : 'values', frame);
  return frame.statement === 'PIVOT' && frame.clause === 'on' ? newFrame('values', frame) : undefined;
}

// `FROM t PIVOT (...)`: inside, the columns of t; after it, the relation has other columns, which are not known.
function pivotFrame(frame: Frame, keyword: string): Frame {
  const source = frame.last;
  return newFrame('pivot', frame, {
    name: keyword,
    derived: true,
    segments: [source ? [{ ...source }] : []],
  });
}

/** What a frame of DuckDB's own constructs changes in its parent when it closes. */
export function leave(frame: Frame, parent: Frame): void {
  if (frame.kind === 'pivot' && parent.last) {
    Object.assign(parent.last, { relation: undefined, columns: undefined, renamed: undefined });
  }
  if (
    frame.kind === 'replace' ||
    frame.kind === 'rename' ||
    (frame.kind === 'columns' && parent.kind !== 'pivot')
  ) {
    parent.afterStar = true;
  }
}
