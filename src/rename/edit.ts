// The change of a view's or macro's SQL for a rename, at DuckDB's tokens: a name is replaced only where the parse tree
// places a reference to the renamed object, and only when the token there spells the old name. Strings, comments and
// objects of the same name elsewhere stay as they are.
import { foldIdentifier, quoteIdentifier } from '../catalog/ddl';
import { utf16Offsets } from '../sql/script';
import type { Token } from '../sql/script';
import { isDot, isWord, unquote } from '../sql/tokens';

/** A name to replace: the dotted name at `location` (a UTF-8 byte offset), its part `part` (-1 for the last one). */
export interface NameEdit {
  readonly location: number;
  readonly part: number;
  readonly from: string;
  readonly to: string;
}

/** The words of the dotted name that starts at the byte offset `location`, dots and comments left out. */
export function dottedName(tokens: readonly Token[], location: number): Token[] {
  const first = tokens.findIndex(({ start }) => start === location);
  const words: Token[] = [];
  if (first < 0) return words;
  let wantWord = true;
  for (const token of tokens.slice(first)) {
    if (token.type === 'COMMENT') continue;
    if (wantWord && isWord(token)) {
      words.push(token);
      wantWord = false;
    } else if (!wantWord && isDot(token)) {
      wantWord = true;
    } else {
      break;
    }
  }
  return words;
}

/** Whether a name can stand in SQL without quotes: a plain word that DuckDB's tokenizer reads as no keyword. */
export async function isPlainName(
  name: string,
  tokenize: (text: string) => Promise<readonly Token[]>,
): Promise<boolean> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  const tokens = await tokenize(name);
  return tokens.length === 1 && tokens[0]?.type === 'IDENTIFIER';
}

/**
 * The text with the names of `edits` replaced; undefined when a place does not hold the old name, which means that the
 * tree and the tokens disagree and the text is better left alone. A quoted name stays quoted.
 */
export async function editedText(
  text: string,
  edits: readonly NameEdit[],
  tokenize: (text: string) => Promise<readonly Token[]>,
): Promise<string | undefined> {
  const tokens = await tokenize(text);
  const offset = utf16Offsets(text);
  const plain = new Map<string, boolean>();
  const replacements = new Map<number, { readonly end: number; readonly text: string }>();
  for (const edit of edits) {
    const words = dottedName(tokens, edit.location);
    const token = edit.part < 0 ? words.at(-1) : words[edit.part];
    if (!token || foldIdentifier(unquote(token.word)) !== foldIdentifier(edit.from)) return undefined;
    if (!plain.has(edit.to)) plain.set(edit.to, await isPlainName(edit.to, tokenize));
    const quoted = token.word.startsWith('"') || plain.get(edit.to) !== true;
    const start = offset(token.start);
    replacements.set(start, {
      end: start + token.word.length,
      text: quoted ? quoteIdentifier(edit.to) : edit.to,
    });
  }
  let result = text;
  for (const [start, { end, text: name }] of [...replacements].sort(([a], [b]) => b - a)) {
    result = `${result.slice(0, start)}${name}${result.slice(end)}`;
  }
  return result;
}
