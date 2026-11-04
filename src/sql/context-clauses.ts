// The frame that the cursor context keeps for each statement or subquery, and the clause words that change it.
import type { TextColumns } from './context-columns';
import { RELATION_AFTER_FIRST_WORD } from './context-words';
import type { FrameKind, State } from './position';
import type { SqlToken } from './tokens';

/** A token of the statement with its neighbours. */
export interface Around {
  readonly token: SqlToken;
  readonly next: SqlToken | undefined;
  readonly previous: SqlToken | undefined;
}

export interface Entry {
  alias: string | undefined;
  relation: { schema: string; table: string } | undefined;
  cte?: string;
  columns?: TextColumns | undefined;
  renamed?: string[] | undefined;
}

/** A common table expression: its name in lower case, its column aliases and the columns of its body. */
export interface Cte {
  readonly name: string;
  renamed: string[];
  columns: TextColumns | undefined;
}

// A name in a relation position that is still being read: `schema.table`.
export interface Pending {
  parts: string[];
  dotted: boolean;
}

/** The format and the option names of `COPY ... TO 'file' (...)`. */
export interface CopyOptions {
  format: string;
  readonly given: string[];
}

export interface Frame extends State {
  readonly parent: Frame | undefined;
  /** The relations of each SELECT of the frame (UNION starts the next). */
  readonly segments: Entry[][];
  target: { schema: string; table: string } | undefined;
  /** Outer relations are not visible inside: a derived table or the body of a CTE. */
  readonly derived: boolean;
  /** The frame stands for a relation of its parent once it ends (subquery or table function in FROM). */
  readonly relationSlot: boolean;
  pending: Pending | undefined;
  last: Entry | undefined;
  aliasOpen: boolean;
  aliasNext: boolean;
  noAlias: boolean;
  createKind: string | undefined;
  /** The CTE whose name was read last in the WITH clause. */
  cte: Cte | undefined;
  /** The `(` that opened a subquery or a list of column aliases. */
  opening: SqlToken | undefined;
  /** Open brackets and braces: a comma inside them does not end a lambda. */
  brackets: number;
  /** The last token was the `*` of all columns or one of its modifiers: `EXCLUDE`, `REPLACE`, `RENAME` and their lists. */
  afterStar: boolean;
  copy: CopyOptions | undefined;
}

/** The clauses whose relations the query reads. */
export const SCOPE_CLAUSES: ReadonlySet<string> = new Set(['from', 'update', 'pivot', 'unpivot']);

export function newFrame(kind: FrameKind, parent: Frame | undefined, extra: Partial<Frame> = {}): Frame {
  return {
    kind,
    statement: undefined,
    clause: '',
    expectRelation: false,
    afterRelation: false,
    setTarget: false,
    createTarget: false,
    columnPath: false,
    inFrom: false,
    name: undefined,
    lambda: undefined,
    parent,
    segments: [[]],
    target: undefined,
    derived: false,
    relationSlot: false,
    pending: undefined,
    last: undefined,
    aliasOpen: false,
    aliasNext: false,
    noAlias: false,
    createKind: undefined,
    cte: undefined,
    opening: undefined,
    brackets: 0,
    afterStar: false,
    copy: undefined,
    ...extra,
  };
}

function enter(frame: Frame, clause: string): void {
  frame.clause = clause;
  frame.expectRelation = false;
  frame.afterRelation = false;
  frame.aliasOpen = false;
  frame.aliasNext = false;
  frame.setTarget = false;
  frame.createTarget = false;
  frame.columnPath = false;
}

function expectRelation(frame: Frame, clause: string, options: { alias?: boolean } = {}): void {
  enter(frame, clause);
  frame.expectRelation = true;
  frame.noAlias = !options.alias;
}

// The first word names the statement; the clause is set without leaving the state of the frame.
function startStatement(frame: Frame, keyword: string, clause: string): void {
  frame.statement = keyword;
  frame.clause = clause;
}

interface ClauseWord {
  readonly keyword: string;
  /** No word has started the statement yet. */
  readonly first: boolean;
  readonly previous: string | undefined;
}

type ClauseHandler = (frame: Frame, word: ClauseWord) => void;

const CLAUSE_HANDLERS = new Map<string, ClauseHandler>(
  (
    [
      [
        'SELECT',
        (frame) => {
          enter(frame, 'select');
          frame.statement ??= 'SELECT';
        },
      ],
      [
        'FROM',
        (frame, { first, previous }) => {
          if (frame.statement === 'COPY') {
            enter(frame, 'copy-from');
          } else if (previous !== 'DISTINCT') {
            // A query may start with FROM.
            if (first) frame.statement = 'FROM';
            expectRelation(frame, 'from', { alias: true });
          }
        },
      ],
      [
        'TO',
        (frame) => {
          if (frame.statement === 'COPY') enter(frame, 'copy-to');
        },
      ],
      ['JOIN', (frame) => expectRelation(frame, 'from', { alias: true })],
      [
        'WHERE HAVING QUALIFY RETURNING GROUP ORDER',
        (frame, { keyword }) => enter(frame, keyword.toLowerCase()),
      ],
      ['LIMIT OFFSET', (frame) => enter(frame, 'limit')],
      ['WINDOW', (frame) => enter(frame, 'window')],
      ['ON', (frame) => onClause(frame)],
      [
        'USING',
        (frame) => {
          if (frame.statement === 'DELETE') expectRelation(frame, 'from', { alias: true });
          else if (['from', 'on', 'pivot'].includes(frame.clause)) enter(frame, 'on');
        },
      ],
      [
        'PIVOT PIVOT_WIDER UNPIVOT PIVOT_LONGER',
        (frame, { keyword, first }) => {
          if (!first) return;
          frame.statement = ['PIVOT', 'PIVOT_WIDER'].includes(keyword) ? 'PIVOT' : 'UNPIVOT';
          expectRelation(frame, frame.statement.toLowerCase());
        },
      ],
      [
        'UNION INTERSECT EXCEPT',
        (frame) => {
          enter(frame, 'union');
          frame.segments.push([]);
        },
      ],
      [
        'WITH',
        (frame, { first }) => {
          if (first) enter(frame, 'with');
        },
      ],
      ['VALUES', (frame) => enter(frame, 'values')],
      [
        'INSERT DELETE CREATE ALTER DROP COMMENT USE CALL',
        (frame, { keyword, first }) => {
          if (first) startStatement(frame, keyword, keyword.toLowerCase());
        },
      ],
      [
        'INTO',
        (frame) => {
          if (frame.statement === 'INSERT') expectRelation(frame, 'into');
          else if (frame.statement === 'UNPIVOT') enter(frame, 'unpivot-into');
        },
      ],
      [
        'UPDATE',
        (frame, { keyword, first }) => {
          if (!first) return;
          frame.statement = keyword;
          expectRelation(frame, 'update', { alias: true });
        },
      ],
      [
        'SET',
        (frame, { keyword, first }) => {
          if (frame.statement === 'UPDATE') {
            enter(frame, 'set');
            frame.setTarget = true;
          } else if (first) {
            startStatement(frame, keyword, 'setting');
          }
        },
      ],
      [
        'RESET',
        (frame, { keyword, first }) => {
          if (first) startStatement(frame, keyword, 'setting');
        },
      ],
      ['TABLE VIEW SCHEMA COLUMN INDEX', (frame, { keyword }) => objectWord(frame, keyword)],
    ] as readonly (readonly [string, ClauseHandler])[]
  ).flatMap(([words, handler]) => words.split(' ').map((word) => [word, handler] as const)),
);

function onClause(frame: Frame): void {
  if (['from', 'on', 'pivot', 'unpivot'].includes(frame.clause)) enter(frame, 'on');
  else if (frame.createKind === 'index') expectRelation(frame, 'create-index');
  else if (frame.statement === 'INSERT') enter(frame, 'conflict');
}

export function clauseWord(frame: Frame, keyword: string, previous: string | undefined): void {
  const first = frame.statement === undefined;
  const handler = CLAUSE_HANDLERS.get(keyword);
  if (handler) handler(frame, { keyword, first, previous });
  else if (first) firstWord(frame, keyword);
}

function firstWord(frame: Frame, keyword: string): void {
  if (RELATION_AFTER_FIRST_WORD.has(keyword)) {
    frame.statement = keyword;
    expectRelation(frame, keyword.toLowerCase());
  } else if (keyword !== 'EXPLAIN' && keyword !== 'ANALYZE') {
    frame.statement = keyword;
  }
}

// A table, view, schema, column or index after CREATE, ALTER, DROP or COMMENT ON.
function objectWord(frame: Frame, keyword: string): void {
  const table = keyword === 'TABLE' || keyword === 'VIEW';
  switch (frame.statement) {
    case 'ALTER':
      if (table) expectRelation(frame, 'alter');
      break;
    case 'DROP':
      if (table) expectRelation(frame, 'drop');
      else if (keyword === 'SCHEMA') frame.clause = 'schema';
      break;
    case 'COMMENT':
      if (table || keyword === 'COLUMN') {
        expectRelation(frame, 'comment');
        frame.columnPath = keyword === 'COLUMN';
      } else if (keyword === 'SCHEMA') {
        frame.clause = 'schema';
      }
      break;
    case 'CREATE':
      if (frame.createKind === undefined) createObject(frame, keyword);
      break;
    default:
  }
}

function createObject(frame: Frame, keyword: string): void {
  frame.createKind = keyword.toLowerCase();
  if (keyword === 'TABLE' || keyword === 'VIEW') {
    expectRelation(frame, 'create');
    frame.createTarget = true;
  } else {
    frame.clause = keyword === 'INDEX' ? 'create-index' : 'create-name';
  }
}
