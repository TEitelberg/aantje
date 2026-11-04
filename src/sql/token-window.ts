import type { SqlToken } from './tokens';

/**
 * The tokens of the texts that the editor asks about, read again only from the statement that changed. DuckDB's lexer
 * starts anew after every terminator, so the tokens of an unchanged text up to a terminator stay valid, and the
 * statement at an offset ends at the first terminator after it.
 */
export interface TokenWindow {
  /** Every token of the text. */
  all(text: string): Promise<SqlToken[]>;
  /** The tokens from the start of the text, at least through the terminator that ends the statement at the offset. */
  upTo(text: string, offset: number): Promise<SqlToken[]>;
}

interface Known {
  readonly text: string;
  /** Tokens from the start of the text, without a gap; `complete` when they reach its end. */
  readonly tokens: readonly SqlToken[];
  readonly complete: boolean;
}

// The texts kept: a few documents, or a document and the texts of the calls that came with the same keystroke.
const KEPT = 4;

// What is read past the offset at first; doubled until the statement ends.
const FIRST_READ = 4096;

/** `read` tokenizes a text from its start, with UTF-16 offsets into that text. */
export function tokenWindow(read: (text: string) => Promise<SqlToken[]>): TokenWindow {
  const known: Known[] = [];
  const remember = (entry: Known): void => {
    const same = known.findIndex(({ text }) => text === entry.text);
    if (same >= 0) known.splice(same, 1);
    known.unshift(entry);
    known.length = Math.min(known.length, KEPT);
  };
  const readFrom = async (text: string, start: number, end: number): Promise<SqlToken[]> =>
    shifted(await read(text.slice(start, end)), start);

  return {
    async all(text) {
      const base = reusable(known, text);
      const hit = base.complete ? base.tokens : undefined;
      if (hit) return [...hit];
      const tokens = [...base.tokens, ...(await readFrom(text, startAfter(base.tokens), text.length))];
      remember({ text, tokens, complete: true });
      return tokens;
    },
    async upTo(text, offset) {
      const base = reusable(known, text);
      if (base.complete || endsAfter(base.tokens, offset)) return [...base.tokens];
      const start = startAfter(base.tokens);
      for (let end = cutAt(text, offset + FIRST_READ); ; end = cutAt(text, start + 2 * (end - start))) {
        const found = await readFrom(text, start, end);
        const stop = end === text.length ? found.length : endOfStatement(found, offset, end);
        if (stop !== undefined) {
          const tokens = [...base.tokens, ...found.slice(0, stop)];
          remember({ text, tokens, complete: end === text.length });
          return tokens;
        }
      }
    },
  };
}

// The tokens of a known text that the new one shares: those up to the last terminator before the first change.
function reusable(known: readonly Known[], text: string): Known {
  let best: Known = { text, tokens: [], complete: false };
  for (const entry of known) {
    if (entry.text === text) return entry;
    const kept = entry.tokens.slice(0, lastTerminatorBefore(entry.tokens, sharedLength(entry.text, text)));
    if (kept.length > best.tokens.length) best = { text, tokens: kept, complete: false };
  }
  return best;
}

function sharedLength(a: string, b: string): number {
  const most = Math.min(a.length, b.length);
  let index = 0;
  while (index < most && a.charCodeAt(index) === b.charCodeAt(index)) index += 1;
  return index;
}

// How many tokens to keep: through the last terminator that ends at or before `end`.
function lastTerminatorBefore(tokens: readonly SqlToken[], end: number): number {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token?.type === 'TERMINATOR' && token.end <= end) return index + 1;
  }
  return 0;
}

const startAfter = (tokens: readonly SqlToken[]): number => tokens.at(-1)?.end ?? 0;

const endsAfter = (tokens: readonly SqlToken[], offset: number): boolean =>
  tokens.some((token) => token.type === 'TERMINATOR' && token.start >= offset);

// The number of tokens through the terminator after the offset; undefined when the read text ends first, because
// the tokens at a cut may differ from those of the whole text.
function endOfStatement(tokens: readonly SqlToken[], offset: number, end: number): number | undefined {
  const index = tokens.findIndex((token) => token.type === 'TERMINATOR' && token.start >= offset);
  const terminator = tokens[index];
  return terminator && terminator.end < end ? index + 1 : undefined;
}

// Never between the two halves of a surrogate pair.
function cutAt(text: string, end: number): number {
  if (end >= text.length) return text.length;
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end + 1 : end;
}

function shifted(tokens: readonly SqlToken[], by: number): SqlToken[] {
  return by === 0
    ? [...tokens]
    : tokens.map((token) => ({ ...token, start: token.start + by, end: token.end + by }));
}
