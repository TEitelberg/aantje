// Use, Save Selection as Template and Duplicate: the text of a template filled in for a new SQL document, a template
// made of a selection of the SQL editor, and the copy of a template. The placeholders, the declarations and their SQL
// text are those of the SQL editor (`src/sql/parameters.ts`). Pure.
import { visibleLine } from '../markdown';
import {
  findPlaceholders,
  parseParameterHeader,
  replacePlaceholders,
  runParameters,
  scriptParameters,
} from '../sql/parameters';
import type { Placeholder, ScriptParameter } from '../sql/parameters';
import type { SqlToken } from '../sql/tokens';
import { createdDay, fieldOf, headerLength, isParameterLine, normalizedText, TEMPLATE_FORMAT } from './model';
import type { Template, TemplateFields } from './model';

/**
 * The parameters that Use asks for: those of the `{{name}}` placeholders, declared by the header or a text without a
 * default. A `$name` stays in the text, and the run asks for it.
 */
export function useParameters(text: string, tokens: readonly SqlToken[]): ScriptParameter[] {
  const texts = findPlaceholders(text, tokens).filter(({ kind }) => kind === 'text');
  return scriptParameters(parseParameterHeader(text).declarations, texts);
}

/** The name a parameter line declares, or undefined when it declares none that `parseParameterHeader` accepts. */
const declaredBy = (line: string): string | undefined => parseParameterHeader(line).declarations[0]?.name;

// A `{{name}}` as `findPlaceholders` reads one, here in the text of a comment.
const COMMENTED = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * The `{{name}}` placeholders in the comments after the header (`text` without a byte order mark and with LF line
 * ends): a statement that a template keeps commented out, such as the real step under a dry run, is to name what the
 * statements before it name once it is uncommented. `findPlaceholders` reads none in a comment.
 */
function commentedPlaceholders(text: string, tokens: readonly SqlToken[]): Placeholder[] {
  const lines = text.split('\n');
  const length = headerLength(lines);
  const body = length === 0 ? 0 : lines.slice(0, length).join('\n').length + 1;
  return tokens
    .filter(({ type, start }) => type === 'COMMENT' && start >= body)
    .flatMap(({ start, word }) =>
      [...word.matchAll(COMMENTED)].map((match) => ({
        name: match[1] ?? '',
        kind: 'text' as const,
        start: start + match.index,
        end: start + match.index + match[0].length,
      })),
    );
}

/**
 * The text of the new SQL document of Use: the `{{name}}` placeholders replaced by the SQL text of the answers, also
 * in the comments after the header, the name and description of the template as the first comment lines, the other
 * comment lines of the header kept, and of the parameter lines only those of the `$name` placeholders, which stay for
 * the run to ask. A problem when an answer does not fit its type, or would end a comment that it goes into.
 */
export function filledTemplate(
  template: Pick<Template, 'text' | 'name' | 'description'>,
  tokens: readonly SqlToken[],
  answers: Readonly<Record<string, string>>,
): { text: string } | { problem: string } {
  const placeholders = findPlaceholders(template.text, tokens);
  const texts = placeholders.filter(({ kind }) => kind === 'text');
  const checked = runParameters(useParameters(template.text, tokens), answers);
  if ('problem' in checked) return checked;
  const sqlOf = ({ name }: Placeholder): string | undefined => checked.parameters.text.get(name);
  const commented = commentedPlaceholders(template.text, tokens).filter(
    (placeholder) => sqlOf(placeholder) !== undefined,
  );
  const ending = commented.find((placeholder) => /[\r\n]|\*\//.test(sqlOf(placeholder) ?? ''));
  if (ending) {
    return {
      problem: `The value of ${ending.name} holds a line break or "*/", which would end the comment of the template that names it.`,
    };
  }
  const filled = replacePlaceholders(template.text, [...texts, ...commented], sqlOf).text;
  const values = new Set(placeholders.filter(({ kind }) => kind === 'value').map(({ name }) => name));
  const lines = normalizedText(filled).split('\n');
  const length = headerLength(lines);
  const kept = lines.slice(0, length).filter((line) => {
    if (fieldOf(line)) return false;
    if (!isParameterLine(line)) return true;
    const name = declaredBy(line);
    return name !== undefined && values.has(name);
  });
  const description = template.description === '' ? [] : [`-- ${visibleLine(template.description)}`];
  return {
    text: [`-- ${visibleLine(template.name)}`, ...description, ...kept, ...lines.slice(length)].join('\n'),
  };
}

/** The header line of the field `created` for a time: its day in UTC. */
const createdLine = (time: number): string => `-- created: ${createdDay(time)}`;

/** The header lines of a template's fields. */
function fieldLines(fields: TemplateFields): string[] {
  return [
    `-- aantje-template: ${TEMPLATE_FORMAT}`,
    `-- name: ${visibleLine(fields.name)}`,
    ...(fields.description === '' ? [] : [`-- description: ${visibleLine(fields.description)}`]),
    ...(fields.tags.length === 0 ? [] : [`-- tags: ${fields.tags.map(visibleLine).join(', ')}`]),
    ...(fields.created === undefined ? [] : [createdLine(fields.created)]),
  ];
}

/**
 * Save Selection as Template: the fields (with `created`, the day of the save), then a parameter line for every
 * placeholder of the selection that the selection does not declare itself (the line of the document's header where it
 * has one, else a plain `text` line), then the selection without the lines of template fields that it may carry.
 * `tokens` are those of the selection.
 */
export function selectionTemplate(
  fields: TemplateFields,
  selection: string,
  documentText: string,
  tokens: readonly SqlToken[],
): string {
  const used = [...new Set(findPlaceholders(selection, tokens).map(({ name }) => name))];
  const own = new Set(parseParameterHeader(selection).declarations.map(({ name }) => name));
  const documentLines = normalizedText(documentText).split('\n');
  const declared = new Map<string, string>();
  for (const line of documentLines.slice(0, headerLength(documentLines))) {
    const name = isParameterLine(line) ? declaredBy(line) : undefined;
    if (name !== undefined && !declared.has(name)) declared.set(name, line.trim());
  }
  const parameterLines = used
    .filter((name) => !own.has(name))
    .map((name) => declared.get(name) ?? `-- param: ${name}`);
  const lines = normalizedText(selection).split('\n');
  const length = headerLength(lines);
  const body = [...lines.slice(0, length).filter((line) => !fieldOf(line)), ...lines.slice(length)];
  return [...fieldLines(fields), ...parameterLines, ...body].join('\n').replace(/\n*$/, '\n');
}

/**
 * Duplicate: the text of a template with the day of the copy (`created`, a time) as its field `created`, in place of the
 * day of the original, or after the other fields when the original has none. The copy is a template of its own.
 */
export function duplicatedTemplate(text: string, created: number): string {
  const lines = normalizedText(text).split('\n');
  const header = lines.slice(0, headerLength(lines));
  const at = header.findIndex((line) => fieldOf(line)?.field === 'created');
  return (
    at === -1
      ? lines.toSpliced(
          header.findLastIndex((line) => fieldOf(line) !== undefined) + 1,
          0,
          createdLine(created),
        )
      : lines.toSpliced(at, 1, createdLine(created))
  ).join('\n');
}
