import { DEFAULT_SCHEMA } from './catalog';
import { foldIdentifier, sameIdentifier } from '../catalog/ddl';
import {
  NOT_A_CALL,
  SKIPPED_IN_NAME,
  SUBQUERY_START,
  WITH_ENDS,
  isClauseFrame,
  isStop,
} from './context-words';
import { clauseWord, newFrame, SCOPE_CLAUSES } from './context-clauses';
import type { Around, Cte, Entry, Frame, Pending } from './context-clauses';
import { queryColumns, textColumns } from './context-columns';
import type { TextColumns } from './context-columns';
import { duckdbFrame, duckdbToken, followsStar, leave, windowClause } from './context-frames';
import { positionOf } from './position';
import type { FrameKind, Position, State } from './position';
import type { Range } from './script';
import { isClosed, isDot, isWord, keywordOf, unquote } from './tokens';
import type { SqlToken } from './tokens';

/** A table or view that a FROM clause (or UPDATE) names. */
export interface ScopeRelation {
  readonly alias: string | undefined;
  /** Undefined for a subquery, a table function or a CTE. */
  readonly relation: { readonly schema: string; readonly table: string } | undefined;
  /** The CTE that the relation reads, as the query names it. */
  readonly cte?: string;
  /** The columns of a CTE, a subquery or a VALUES list as its text gives them. */
  readonly columns?: TextColumns | undefined;
  /** The column aliases of `x(a, b)`: they rename the first columns. */
  readonly renamed?: readonly string[] | undefined;
}

export interface CursorContext {
  readonly position: Position;
  /** The first word of the statement in upper case, WITH and EXPLAIN do not count. */
  readonly statement: string | undefined;
  /**
   * The last clause keyword of the innermost query in lower case, e.g. `select`, `from`, `where`; empty before the
   * first. Inside `OVER (...)` the part of the window: `over`, `partition`, `order`, `frame-start`, ...
   */
  readonly clause: string;
  /** The names before the dot(s) that precede the word, without quotes: `lake.sales.or` gives `lake`, `sales`. */
  readonly qualifier: readonly string[];
  /** The text of the word before the cursor without quotes. */
  readonly partial: string;
  /** The word is a quoted identifier: the ranges include its quote. */
  readonly quoted: boolean;
  /** What a completion replaces: the word up to the cursor (a quoted identifier up to its closing quote). */
  readonly insert: Range;
  /** The whole word under the cursor. */
  readonly replace: Range;
  /** The relations that the query at the cursor can read, the innermost query first. */
  readonly scope: readonly ScopeRelation[];
  /** The table that INSERT, UPDATE, DELETE, ALTER and the like change. */
  readonly target: { readonly schema: string; readonly table: string } | undefined;
  /** The common table expressions that are declared at the cursor, in lower case. */
  readonly ctes: readonly string[];
  /** The cursor is inside the string of a snapshot time (`TIMESTAMP => '|'`): the ranges cover its content. */
  readonly inString: { readonly closed: boolean } | undefined;
  /** The cursor is inside parentheses of the statement (a subquery, a call, a list). */
  readonly inParentheses: boolean;
  /** The parameters of the lambdas whose body the cursor is in, the innermost first. */
  readonly locals: readonly string[];
  /** Inside the options of `COPY ... TO 'file' (`: the format (from FORMAT or the file name) and the options given. */
  readonly copy: { readonly format: string; readonly given: readonly string[] } | undefined;
}

export interface CallContext {
  /** The called name as written, without quotes. */
  readonly name: string;
  /** The names before it: `lake` of `lake.table_changes(`. */
  readonly qualifier: readonly string[];
  /** Counted from 0; the commas at the level of the call decide. */
  readonly activeParameter: number;
  /** The name of the argument that is being typed in `name := ...` or `name => ...`. */
  readonly argumentName: string | undefined;
  /** The arguments given by name so far, as written. */
  readonly named: readonly string[];
  /** Nothing but the word under the cursor is typed of the current argument. */
  readonly argumentStart: boolean;
}

interface Link {
  readonly frame: Frame;
  readonly segment: number;
  readonly state: State;
}

interface Snapshot {
  readonly chain: readonly Link[];
  readonly prev: readonly SqlToken[];
  readonly cteCount: number;
}

interface Scan extends Snapshot {
  readonly ctes: readonly string[];
}

// What resolves a name: the CTEs declared so far and the name that the lake is attached as; the tokens of the statement.
interface Names {
  readonly ctes: Cte[];
  readonly lake: string | undefined;
  readonly tokens: readonly SqlToken[];
}

// The names of `a.b.` in front of `tokens[end]`: `tokens[end - 1]` is the last dot.
function qualifierBefore(tokens: readonly SqlToken[], end: number): string[] {
  const parts: string[] = [];
  for (let index = end - 1; index >= 1; index -= 2) {
    const dot = tokens[index];
    const name = tokens[index - 1];
    if (!dot || !name || !isDot(dot) || !isWord(name)) break;
    parts.unshift(unquote(name.word));
  }
  return parts;
}

// The word that the cursor touches, or `inert` when it is in a string, a comment or a number.
function touchedWord(tokens: readonly SqlToken[], offset: number): SqlToken | 'inert' | undefined {
  const touched = tokens.find((token) => token.start < offset && offset <= token.end);
  if (!touched) return undefined;
  const { type } = touched;
  if (type === 'STRING_LITERAL' || type === 'COMMENT') {
    return !isClosed(touched) || offset < touched.end ? 'inert' : undefined;
  }
  if (type === 'NUMBER_LITERAL' && !isDot(touched)) return 'inert';
  const closedQuote = touched.word.startsWith('"') && isClosed(touched) && offset === touched.end;
  return isWord(touched) && !closedQuote ? touched : undefined;
}

/** Where the cursor is. `lake` is the name the lake is attached as; `lake.schema.table` drops it. Reports only what is certain. */
export function contextAt(tokens: readonly SqlToken[], offset: number, lake?: string): CursorContext {
  const literal = snapshotLiteral(tokens, offset, lake);
  if (literal) return literal;
  const touched = touchedWord(tokens, offset);
  if (touched === 'inert') return inert(offset);
  const word = touched;
  const anchor = word?.start ?? offset;
  const from = 1 + tokens.findLastIndex((token) => token.type === 'TERMINATOR' && token.end <= anchor);
  const stop = tokens.findIndex(
    (token, index) => index >= from && token.type === 'TERMINATOR' && token.start >= offset,
  );
  const statement = tokens
    .slice(from, stop < 0 ? tokens.length : stop)
    .filter((token) => token.type !== 'COMMENT' && token !== word);

  const before = statement.filter((token) => token.end <= anchor);
  const qualifier = qualifierBefore(before, before.length);
  const scan = readStatement(statement, before.length, lake);
  const { chain } = scan;
  const innermost = chain.find(({ state }) => isClauseFrame(state));
  const quoted = word?.word.startsWith('"') ?? false;
  // An unterminated quote reaches to the end of the text: only the part up to the cursor belongs to the word.
  const closedQuote = word !== undefined && quoted && isClosed(word);
  const wordEnd = word && (!quoted || closedQuote) ? word.end : offset;
  return {
    position: positionOf(chain, scan.prev),
    statement: innermost?.state.statement,
    ...partsAt(scan),
    qualifier,
    partial: word ? unquote(word.word.slice(0, offset - word.start)) : '',
    quoted,
    insert: { offset: anchor, length: (closedQuote ? wordEnd : offset) - anchor },
    replace: { offset: anchor, length: wordEnd - anchor },
    scope: scopeOf(chain),
    target: chain.map(({ frame }) => frame.target).find((target) => target !== undefined),
    ctes: scan.ctes.slice(0, scan.cteCount),
    inString: undefined,
    inParentheses: chain.length > 1,
  };
}

// The clause (in a window specification its part), the lambda parameters and the options of COPY at the cursor.
function partsAt({ chain, prev }: Snapshot): Pick<CursorContext, 'clause' | 'locals' | 'copy'> {
  const part = chain.find(({ state }) => isClauseFrame(state) || state.kind === 'window')?.state;
  return {
    clause: part?.kind === 'window' ? windowClause(part.clause, prev) : (part?.clause ?? ''),
    locals: chain.flatMap(({ state }) => (state.lambda?.body ? state.lambda.params : [])),
    // Options after the cursor count too: they are given.
    copy: chain.find(({ frame }) => frame.kind === 'copy-options')?.frame.copy,
  };
}

// A string in the slot of a snapshot time or a number in the slot of a snapshot id, the cursor inside:
// `AT (TIMESTAMP => '2026-|')`, `AT (VERSION => 1|)`. A lone quote at the end of the text is a word to the tokenizer.
function snapshotLiteral(
  tokens: readonly SqlToken[],
  offset: number,
  lake: string | undefined,
): CursorContext | undefined {
  const literal = tokens.find(
    (token) =>
      token.start < offset &&
      offset <= token.end &&
      (token.word.startsWith("'") || token.type === 'NUMBER_LITERAL'),
  );
  if (!literal) return undefined;
  const string = literal.word.startsWith("'");
  const closed = string && isClosed(literal);
  if (closed && offset === literal.end) return undefined;
  const slot = contextAt(
    tokens.filter((token) => token !== literal),
    literal.start,
    lake,
  );
  if (slot.position !== (string ? 'snapshot-timestamp' : 'snapshot-version')) return undefined;
  const start = string ? literal.start + 1 : literal.start;
  // An unterminated string reaches to the end of the text: only the part up to the cursor is replaced.
  const end = !string ? literal.end : closed ? literal.end - 1 : offset;
  return {
    ...slot,
    partial: literal.word.slice(start - literal.start, offset - literal.start),
    insert: { offset: start, length: offset - start },
    replace: { offset: start, length: end - start },
    inString: string ? { closed } : undefined,
  };
}

/** The snapshot id of the first `AT (VERSION => n)` of the statement at the offset. */
export function statementSnapshot(tokens: readonly SqlToken[], offset: number): number | undefined {
  const from = 1 + tokens.findLastIndex((token) => token.type === 'TERMINATOR' && token.end <= offset);
  const rest = tokens.slice(from).filter((token) => token.type !== 'COMMENT');
  for (let index = 0; index < rest.length && rest[index]?.type !== 'TERMINATOR'; index += 1) {
    const [at, parenthesis, version, arrow, id] = rest.slice(index, index + 5);
    if (
      keywordOf(at) === 'AT' &&
      parenthesis?.word === '(' &&
      keywordOf(version) === 'VERSION' &&
      arrow?.word === '=>' &&
      id?.type === 'NUMBER_LITERAL' &&
      /^\d+$/.test(id.word)
    ) {
      return Number(id.word);
    }
  }
  return undefined;
}

function inert(offset: number): CursorContext {
  return {
    position: 'inert',
    statement: undefined,
    clause: '',
    qualifier: [],
    partial: '',
    quoted: false,
    insert: { offset, length: 0 },
    replace: { offset, length: 0 },
    scope: [],
    target: undefined,
    ctes: [],
    inString: undefined,
    inParentheses: false,
    locals: [],
    copy: undefined,
  };
}

/** The call that the cursor is in, for the signature help. The cursor may be in a string argument. */
export function callAt(tokens: readonly SqlToken[], offset: number): CallContext | undefined {
  const from = 1 + tokens.findLastIndex((token) => token.type === 'TERMINATOR' && token.end <= offset);
  const before = tokens
    .slice(from)
    .filter((token) => token.type !== 'COMMENT' && token.end <= offset && token.type !== 'TERMINATOR');
  const stack: OpenCall[] = [];
  before.forEach((_, index) => callToken(stack, before, index));
  const call = stack.findLast(({ name }) => name !== undefined);
  if (!call?.name) return undefined;
  const nameIndex = before.indexOf(call.name);
  const qualifier = qualifierBefore(before, nameIndex);
  // Commas of the inner groups do not count: `call.commas` only grew while the call was the top of the stack.
  const first = before[call.argument];
  const second = before[call.argument + 1];
  const named = first && isWord(first) && second && (second.word === ':=' || second.word === '=>');
  const typed = before.length - call.argument;
  const last = before.at(-1);
  return {
    name: unquote(call.name.word),
    qualifier,
    activeParameter: call.commas,
    argumentName: named ? unquote(first.word) : undefined,
    named: call.named,
    argumentStart: typed === 0 || (typed === 1 && last !== undefined && isWord(last) && last.end === offset),
  };
}

interface OpenCall {
  readonly name: SqlToken | undefined;
  commas: number;
  /** Index in `before` of the first token of the current argument. */
  argument: number;
  readonly named: string[];
  /** Between `lambda` and its `:`: the commas separate parameters, not arguments. */
  lambdaHead: boolean;
}

function callToken(stack: OpenCall[], before: readonly SqlToken[], index: number): void {
  const token = before[index];
  const top = stack.at(-1);
  if (!token) return;
  if (keywordOf(token) === 'LAMBDA' && top) top.lambdaHead = true;
  if (token.type !== 'OPERATOR') return;
  if ('([{'.includes(token.word) && token.word.length === 1) {
    const previous = before[index - 1];
    const callable =
      token.word === '(' && previous && isWord(previous) && !NOT_A_CALL.has(keywordOf(previous) ?? '');
    stack.push({
      name: callable ? previous : undefined,
      commas: 0,
      argument: index + 1,
      named: [],
      lambdaHead: false,
    });
  } else if (')]}'.includes(token.word) && token.word.length === 1) {
    stack.pop();
  } else if (top) {
    argumentToken(top, before, index);
  }
}

// A comma between arguments, a named argument (`name => `, `name := `, `name = `), the end of a lambda's head.
function argumentToken(top: OpenCall, before: readonly SqlToken[], index: number): void {
  const word = before[index]?.word;
  if (word === ':') {
    top.lambdaHead = false;
  } else if (word === ',' && !top.lambdaHead) {
    top.commas += 1;
    top.argument = index + 1;
  } else if (word === '=>' || word === ':=' || word === '=') {
    const name = before[index - 1];
    if (name && isWord(name) && index - 1 === top.argument) top.named.push(unquote(name.word));
  }
}

function stateOf(frame: Frame): State {
  const { kind, statement, clause, afterRelation, setTarget } = frame;
  const { createTarget, columnPath, inFrom, name, lambda } = frame;
  return {
    kind,
    statement,
    clause,
    expectRelation: frame.expectRelation,
    afterRelation,
    setTarget,
    createTarget,
    columnPath,
    inFrom,
    name,
    lambda: lambda && { params: [...lambda.params], body: lambda.body },
  };
}

function chainOf(top: Frame): Link[] {
  const chain: Link[] = [];
  for (let frame: Frame | undefined = top; frame; frame = frame.parent) {
    chain.push({ frame, segment: frame.segments.length - 1, state: stateOf(frame) });
  }
  return chain;
}

// The state at the cursor token is recorded on the way, but relations complete by reading on:
// `SELECT | FROM sales.orders` knows its table.
function readStatement(tokens: readonly SqlToken[], cursor: number, lake: string | undefined): Scan {
  const names: Names = { ctes: [], lake, tokens };
  let top = newFrame('statement', undefined);
  let snapshot: Snapshot = { chain: [], prev: [], cteCount: 0 };
  const take = (index: number): void => {
    // A name that is complete when the cursor comes belongs to the clause before it.
    if (top.pending && !top.pending.dotted) finish(top, names);
    snapshot = {
      chain: chainOf(top),
      prev: tokens.slice(Math.max(0, index - 3), index),
      cteCount: names.ctes.length,
    };
  };
  tokens.forEach((token, index) => {
    if (index === cursor) take(index);
    top = step(top, { token, next: tokens[index + 1], previous: tokens[index - 1] }, names);
  });
  if (cursor >= tokens.length) take(tokens.length);
  for (let frame: Frame | undefined = top; frame; frame = frame.parent) finish(frame, names);
  return { ...snapshot, ctes: names.ctes.map(({ name }) => name) };
}

function step(frame: Frame, at: Around, names: Names): Frame {
  const star = followsStar(frame, at);
  const next = read(frame, at, names);
  frame.afterStar = star;
  return next;
}

function read(frame: Frame, at: Around, names: Names): Frame {
  const { token, previous } = at;
  if (frame.pending) {
    const continued = continueName(frame, frame.pending, at);
    if (continued) return continued;
    finish(frame, names);
  }
  if (duckdbToken(frame, at)) return frame;
  const keyword = keywordOf(token);
  if (isWord(token) && consumeWord(frame, token, keyword, names)) return frame;
  if (token.word === '(') return open(frame, at, undefined);
  if (token.word === ')') return close(frame, names, token);
  if (token.word === ',') comma(frame);
  else if (token.word === '=' && frame.clause === 'set') frame.setTarget = false;
  else if (keyword && isClauseFrame(frame)) clauseWord(frame, keyword, keywordOf(previous));
  return frame;
}

// A word that is part of a name, a CTE or an alias is consumed; any other word may be a clause keyword.
function consumeWord(frame: Frame, token: SqlToken, keyword: string | undefined, names: Names): boolean {
  if (frame.expectRelation) {
    if (keyword && SKIPPED_IN_NAME.has(keyword)) return true;
    if (!isStop(keyword)) {
      frame.pending = { parts: [unquote(token.word)], dotted: false };
      return true;
    }
  }
  if (frame.clause === 'with' && !(keyword && WITH_ENDS.has(keyword))) {
    cteWord(frame, token, names.ctes);
    return true;
  }
  return frame.afterRelation && frame.aliasOpen && aliasWord(frame, token, keyword);
}

// The token continues the name that is being read (a dot, the next part, the parenthesis of a function).
function continueName(frame: Frame, pending: Pending, at: Around): Frame | undefined {
  const { token } = at;
  if (isDot(token) && !pending.dotted) {
    pending.dotted = true;
    return frame;
  }
  if (isWord(token) && pending.dotted && !isStop(keywordOf(token))) {
    pending.parts.push(unquote(token.word));
    pending.dotted = false;
    return frame;
  }
  if (token.word === '(' && frame.clause === 'from' && !pending.dotted) {
    const name = pending.parts.at(-1);
    frame.pending = undefined;
    frame.expectRelation = false;
    return open(frame, at, name?.toUpperCase());
  }
  return undefined;
}

// The word after a relation is its alias, or `AS` announces it.
function aliasWord(frame: Frame, token: SqlToken, keyword: string | undefined): boolean {
  if (frame.aliasNext || (!isStop(keyword) && token.type !== 'KEYWORD')) {
    if (frame.last) frame.last.alias = unquote(token.word);
    frame.aliasOpen = false;
    frame.aliasNext = false;
    return true;
  }
  if (keyword === 'AS') {
    frame.aliasNext = true;
    return true;
  }
  return false;
}

function comma(frame: Frame): void {
  if (!isClauseFrame(frame)) return;
  if (frame.clause === 'from') {
    frame.expectRelation = true;
    frame.afterRelation = false;
    frame.aliasOpen = false;
  } else if (frame.clause === 'set') {
    frame.setTarget = true;
  }
}

// `WITH name [(columns)] AS (...)`: the name counts once AS follows it; the body that follows gives its columns.
function cteWord(frame: Frame, token: SqlToken, ctes: Cte[]): void {
  const keyword = keywordOf(token);
  if (keyword === 'AS') {
    if (frame.cte && !ctes.includes(frame.cte)) ctes.push(frame.cte);
  } else if (!keyword || !['RECURSIVE', 'MATERIALIZED', 'NOT'].includes(keyword)) {
    frame.cte = { name: foldIdentifier(unquote(token.word)), renamed: [], columns: undefined };
  }
}

function finish(frame: Frame, names: Names): void {
  const { pending } = frame;
  frame.pending = undefined;
  if (!pending) return;
  frame.expectRelation = false;
  if (pending.dotted) return;
  frame.afterRelation = true;
  frame.aliasOpen = !frame.noAlias;
  if (frame.createTarget || frame.columnPath) return;
  const entry = entryOf(pending.parts, names);
  frame.target ??= entry.relation;
  if (SCOPE_CLAUSES.has(frame.clause)) frame.segments.at(-1)?.push(entry);
  frame.last = entry;
}

// A CTE keeps the columns of its body as they are when it is named: inside its own body they are not known yet.
function entryOf(parts: readonly string[], names: Names): Entry {
  const [first = ''] = parts;
  const cte =
    parts.length === 1 ? names.ctes.findLast(({ name }) => name === foldIdentifier(first)) : undefined;
  if (!cte) return { alias: undefined, relation: resolve(parts, names.lake) };
  const columns = cte.columns ?? textColumns(undefined, [], cte.renamed);
  return { alias: undefined, relation: undefined, cte: first, columns };
}

function resolve(
  parts: readonly string[],
  lake: string | undefined,
): { schema: string; table: string } | undefined {
  const [first = '', second = '', third = ''] = parts;
  if (parts.length === 1) return { schema: DEFAULT_SCHEMA, table: first };
  if (parts.length === 2) return { schema: first, table: second };
  if (parts.length === 3 && lake !== undefined && sameIdentifier(first, lake)) {
    return { schema: second, table: third };
  }
  return undefined;
}

// A `(` starts a frame; `called` is the name of a table function in FROM.
function open(frame: Frame, { token, next, previous }: Around, called: string | undefined): Frame {
  const previousKeyword = keywordOf(previous);
  const nextKeyword = keywordOf(next);
  if (called !== undefined)
    return newFrame('call', frame, { inFrom: true, name: called, relationSlot: true });
  if (frame.afterRelation && previousKeyword === 'AT') return newFrame('snapshot', frame);
  if (nextKeyword && SUBQUERY_START.has(nextKeyword)) return subqueryFrame(frame, token);
  const own = duckdbFrame(frame, previous);
  if (own) return own;
  if (aliasesFollow(frame, previous)) return newFrame('aliases', frame, { opening: token });
  const listKind = columnListKind(frame, previousKeyword);
  if (listKind) return newFrame(listKind, frame);
  if (frame.clause === 'values' || frame.kind === 'values') return newFrame('values', frame);
  if (previous && isWord(previous) && !NOT_A_CALL.has(previousKeyword ?? '')) {
    return newFrame('call', frame, {
      name: previousKeyword ?? unquote(previous.word).toUpperCase(),
      inFrom:
        isClauseFrame(frame) &&
        ((frame.clause === 'from' && !frame.afterRelation) || frame.clause === 'call'),
    });
  }
  return newFrame('group', frame);
}

function subqueryFrame(frame: Frame, opening: SqlToken): Frame {
  const relationSlot = frame.expectRelation;
  frame.expectRelation = false;
  return newFrame('subquery', frame, {
    derived: relationSlot || frame.clause === 'from' || frame.clause === 'with',
    relationSlot,
    // Only a derived table and the body of a CTE give columns.
    opening: relationSlot || frame.clause === 'with' ? opening : undefined,
  });
}

// `WITH c(a, b) AS` and `FROM t x(a, b)`: a parenthesis right after the name of the CTE or the alias of a relation.
function aliasesFollow(frame: Frame, previous: SqlToken | undefined): boolean {
  const name = previous && isWord(previous) ? unquote(previous.word) : undefined;
  if (name === undefined) return false;
  if (frame.clause === 'with') return frame.cte?.name === foldIdentifier(name);
  return frame.clause === 'from' && frame.afterRelation && frame.last?.alias === name;
}

// The frame of a parenthesis after the table of INSERT, CREATE or ALTER ... BY, which holds column names.
function columnListKind(frame: Frame, previousKeyword: string | undefined): FrameKind | undefined {
  if (!isClauseFrame(frame)) return undefined;
  if (frame.afterRelation) {
    if (frame.statement === 'INSERT' && frame.clause === 'into') return 'insert-columns';
    if (frame.statement === 'CREATE') {
      return frame.createKind === 'table'
        ? 'create-columns'
        : frame.createKind === 'index'
          ? 'column-list'
          : 'quiet';
    }
  }
  return frame.statement === 'ALTER' && previousKeyword === 'BY' ? 'column-list' : undefined;
}

function close(frame: Frame, names: Names, closing: SqlToken): Frame {
  const { parent } = frame;
  if (!parent) return frame;
  finish(frame, names);
  leave(frame, parent);
  const { tokens } = names;
  const body = frame.opening && tokens.slice(tokens.indexOf(frame.opening) + 1, tokens.indexOf(closing));
  const columns = body && bodyColumns(frame, parent, body);
  if (frame.relationSlot) {
    const entry: Entry = { alias: undefined, relation: undefined, columns };
    parent.segments.at(-1)?.push(entry);
    parent.last = entry;
    parent.expectRelation = false;
    parent.afterRelation = true;
    parent.aliasOpen = !parent.noAlias;
  }
  return parent;
}

// What a closing parenthesis tells: the column aliases of a CTE or relation, the columns of a CTE body or a subquery.
function bodyColumns(frame: Frame, parent: Frame, body: readonly SqlToken[]): TextColumns | undefined {
  const cte = parent.clause === 'with' ? parent.cte : undefined;
  if (frame.kind === 'aliases') {
    const aliases = body.filter(isWord).map(({ word }) => unquote(word));
    if (cte) cte.renamed = aliases;
    else if (parent.last) parent.last.renamed = aliases;
    return undefined;
  }
  const columns = textColumns(queryColumns(body), frame.segments[0] ?? [], cte?.renamed ?? []);
  if (cte) cte.columns = columns;
  return columns;
}

function scopeOf(chain: readonly Link[]): ScopeRelation[] {
  const scope: ScopeRelation[] = [];
  for (const { frame, segment } of chain) {
    scope.push(...(frame.segments[segment] ?? []));
    if (frame.derived) break;
  }
  return scope;
}
