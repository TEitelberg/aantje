// Completion of parameter names: after `$` and inside `{{`, the parameters that the header of the document declares.
import type { Completions } from './completion';
import { parseParameterHeader } from './parameters';
import { isWord } from './tokens';
import type { SqlToken } from './tokens';

/**
 * The declared parameters when the cursor follows `$` or `{{` (right after it, or in the name behind it), none when the
 * header declares none; undefined elsewhere, so that the other completions apply.
 */
export function parameterCompletions(
  text: string,
  tokens: readonly SqlToken[],
  offset: number,
): Completions | undefined {
  const name = nameAt(tokens, offset);
  if (!name) return undefined;
  const { declarations } = parseParameterHeader(text);
  return {
    insert: { offset: name.start, length: offset - name.start },
    replace: { offset: name.start, length: name.end - name.start },
    items: declarations.map((parameter, index) => ({
      label: parameter.name,
      kind: 'parameter',
      insertText: parameter.name,
      snippet: false,
      detail: parameter.type,
      documentation:
        [
          parameter.description,
          parameter.defaultValue === undefined ? undefined : `Default: ${parameter.defaultValue}`,
        ]
          .filter((line) => line !== undefined)
          .join('\n\n') || undefined,
      filterText: undefined,
      sortText: String(index).padStart(4, '0'),
    })),
    pending: undefined,
  };
}

// Where the name of a placeholder goes at the offset: right after `$` or `{{`, or the word that follows one.
function nameAt(tokens: readonly SqlToken[], offset: number): { start: number; end: number } | undefined {
  const at = tokens.findLastIndex((token) => token.start < offset);
  const token = tokens[at];
  if (!token) return undefined;
  if (opens(tokens, at) && token.end <= offset) {
    // Right after `$` only: a blank after it starts something else.
    return token.word === '$' && token.end !== offset ? undefined : { start: offset, end: offset };
  }
  const before = tokens[at - 1];
  if (isWord(token) && offset <= token.end && opens(tokens, at - 1) && before && before.end <= token.start) {
    if (before.word === '$' && before.end !== token.start) return undefined;
    return { start: token.start, end: token.end };
  }
  return undefined;
}

// `$` (an identifier at the end of the text, else an operator), or the second `{` of `{{`.
function opens(tokens: readonly SqlToken[], index: number): boolean {
  const token = tokens[index];
  if (token?.word === '$') return true;
  if (token?.type !== 'OPERATOR') return false;
  const before = tokens[index - 1];
  return token.word === '{' && before?.word === '{' && before.end === token.start;
}
