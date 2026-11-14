import type { ColumnInfo } from '../catalog/model';
import { splitScript } from '../sql/script';
import type { Token } from '../sql/script';

// The scripts of aantje copy catalog text into statements: the SQL of views and macros, types, defaults and sort
// expressions. Catalog text is data of whoever writes the catalog, so a statement that copies it is checked before it
// stays live. `fromCatalog` comments out a statement whose text holds `;`, `--` or `/*`. DuckDB's tokenizer checks the
// rest (`checkedScript`): each copied text has to end outside every string, quoted name and comment, and the finished
// script has to split into exactly the statements that it shows, the way the SQL editor splits a document before it
// runs anything. The tokenizer only reads; nothing runs.

/** Comments a statement out line by line; a quoted name may hold a line break that would otherwise run as SQL. */
export function commented(statement: string): string {
  return `-- ${statement.replace(/\r\n|\r|\n/g, (lineBreak) => `${lineBreak}-- `)}`;
}

const READ_ALL = '-- The query below comes from the catalog: read all of it before running.';
const COMMENTED_OUT_NOTE =
  '-- It contains ";", "--" or "/*", which can start another statement or hide a part of one, so it is commented out: remove the "-- " in front of it once you have read it.';

/**
 * A statement that copies catalog text. A fragment with `;`, `--` or `/*` could start or hide a statement,
 * so the statement becomes a comment under fixed notes. `warn` adds the first note to a live statement.
 */
export function fromCatalog(
  statement: string,
  fragments: readonly string[],
  warn = false,
): { notes: string[]; statement: string } {
  return fragments.some((text) => /;|--|\/\*/.test(text))
    ? { notes: [READ_ALL, COMMENTED_OUT_NOTE], statement: commented(statement) }
    : { notes: warn ? [READ_ALL] : [], statement };
}

/** Decides, as `fromCatalog` does, whether a statement that copies catalog text stays live or becomes a comment. */
export type CatalogCheck = typeof fromCatalog;

/** The types of the column and of the fields below it: the catalog text of a type statement. */
export const typeFragments = (column: ColumnInfo): string[] => [
  column.type,
  ...column.children.flatMap(typeFragments),
];

/** Types and defaults of the columns and their children: the unquoted catalog text of a column statement. */
export function columnFragments(columns: readonly ColumnInfo[]): string[] {
  return columns.flatMap((column) => [
    column.type,
    ...(column.defaultValue === null ? [] : [column.defaultValue]),
    ...columnFragments(column.children),
  ]);
}

/** An entry of a script is empty, a comment (each of its lines starts with `--`), or exactly one statement ending in `;`. */
export const isStatement = (entry: string): boolean => entry !== '' && !entry.startsWith('--');

const NEEDS_NOTE =
  '-- It needs a statement above that stays a comment, so it is commented out too: remove the "-- " in front of it once that one has run.';

/** A statement that needs one that stays a comment, commented out under a note. */
export const needing = (statement: string): string[] => [NEEDS_NOTE, commented(statement)];

/** The lines with each statement commented out under the note: they all need a statement that stays a comment. */
export const allNeeding = (lines: readonly string[]): string[] =>
  lines.flatMap((line) => (isStatement(line) ? needing(line) : [line]));

/** DuckDB's `sql_tokenize` of a text. */
export type Tokenize = (text: string) => Promise<readonly Token[]>;

// What opens a string, a quoted name or a dollar-quoted string: text without them cannot leave one open, and `;`, `--`
// and `/*` already comment a statement out (`fromCatalog`). NUL ends the text for DuckDB's parser but not for its
// tokenizer, so text with a NUL is never taken as closed.
const OPENERS = /['"`$]/;
const hasNul = (text: string): boolean => text.includes('\0');

const OPEN_NOTE =
  '-- DuckDB does not read it as the one statement it shows: text from the catalog leaves a string, a quoted name or a comment open, which can carry on into the lines below. So it is commented out: remove the "-- " in front of it once you have read it.';

// Each fragment on its own, followed by a terminator on a line of its own. The tokenizer finds exactly those terminators,
// and no comment, only when every fragment ends outside every string, quoted name and comment and holds no terminator.
async function allClosed(fragments: readonly string[], tokenize: Tokenize): Promise<boolean> {
  const ends: number[] = [];
  let bytes = 0;
  for (const fragment of fragments) {
    ends.push(bytes + Buffer.byteLength(fragment) + 1);
    bytes += Buffer.byteLength(fragment) + 3;
  }
  const tokens = await tokenize(fragments.map((fragment) => `${fragment}\n;\n`).join(''));
  const terminators = tokens.filter(({ type }) => type === 'TERMINATOR');
  return (
    !tokens.some(({ type }) => type === 'COMMENT') &&
    terminators.length === ends.length &&
    terminators.every(({ start }, index) => start === ends[index])
  );
}

/** The fragments that the tokenizer shows to be closed; a group that fails is halved until the open ones are found. */
async function closedFragments(fragments: readonly string[], tokenize: Tokenize): Promise<Set<string>> {
  const closed = new Set<string>();
  const check = async (group: readonly string[]): Promise<void> => {
    if (group.length === 0) return;
    if (await allClosed(group, tokenize)) {
      for (const fragment of group) closed.add(fragment);
    } else if (group.length > 1) {
      const half = Math.ceil(group.length / 2);
      await check(group.slice(0, half));
      await check(group.slice(half));
    }
  };
  await check([...new Set(fragments)].filter((fragment) => OPENERS.test(fragment) && !hasNul(fragment)));
  return closed;
}

/** `fromCatalog`; a statement whose copied text is not shown to be closed, or that is held back, is commented out too. */
function checking(closed: ReadonlySet<string>, held: ReadonlySet<string>): CatalogCheck {
  return (statement, fragments, warn) => {
    const made = fromCatalog(statement, fragments, warn);
    const open = fragments.some((text) => hasNul(text) || (OPENERS.test(text) && !closed.has(text)));
    return isStatement(made.statement) && (open || held.has(statement))
      ? { notes: [READ_ALL, OPEN_NOTE], statement: commented(statement) }
      : made;
  };
}

/** The first statement among the entries that the script does not split into as written; undefined when none. */
async function strayStatement(entries: readonly string[], tokenize: Tokenize): Promise<string | undefined> {
  const text = entries.join('\n');
  const written: { readonly entry: string; readonly offset: number }[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (isStatement(entry)) written.push({ entry, offset });
    offset += entry.length + 1;
  }
  const split = splitScript(text, await tokenize(text));
  const stray = written.find(({ entry, offset: at }, index) => {
    const statement = split[index];
    return statement?.offset !== at || statement.sql !== entry.replace(/;$/, '').trimEnd();
  });
  if (stray) return stray.entry;
  // Every statement ends where it shows, and the lines after the last one are comments.
  if (split.length > written.length) {
    throw new Error('A script was written with more statements than it shows.');
  }
  return undefined;
}

/**
 * A script whose statements DuckDB's tokenizer checked. `write` returns the entries of the script (`isStatement`); it
 * runs once to collect the catalog text that its statements copy, and again with what the tokenizer found. A statement
 * whose copied text is not shown to be closed becomes a comment, and `write` comments out what needs it. When the script
 * does not split into the statements that it shows, the statement where it goes wrong is held back and written again.
 */
export async function checkedScript(
  write: (check: CatalogCheck) => readonly string[],
  tokenize: Tokenize,
): Promise<string> {
  const copied = new Map<string, readonly string[]>();
  write((statement, fragments, warn) => {
    copied.set(statement, fragments);
    return fromCatalog(statement, fragments, warn);
  });
  const closed = await closedFragments([...copied.values()].flat(), tokenize);
  const held = new Set<string>();
  for (;;) {
    const entries = write(checking(closed, held));
    const stray = await strayStatement(entries, tokenize);
    if (stray === undefined) return entries.join('\n');
    // Text built from quoted names and literals splits as written: only a statement with catalog text can go wrong.
    const owner = [...copied.keys()].find((statement) => !held.has(statement) && statement.includes(stray));
    if (owner === undefined) {
      throw new Error('A script was written with a statement that does not run as it shows.');
    }
    held.add(owner);
  }
}
