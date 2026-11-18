// The SQL templates (#95). A template is a SQL text whose header, the comment lines at its start, names it and declares
// its parameters, so that a template is also a SQL file that can live in Git:
//
//   -- aantje-template: 1
//   -- name: Partitioned table from Parquet files
//   -- description: Creates a table from Parquet files ...
//   -- tags: load, partitioning
//   -- created: 2026-11-16
//   -- param: schema | identifier | main | Target schema
//   CREATE TABLE {{schema}}.{{table}} AS ...
//
// The `-- param:` lines and the placeholders are those of the SQL editor (`src/sql/parameters.ts`); this module reads
// the other fields and checks a text before aantje keeps it. Pure, and free of the VS Code API.
import { quoteLiteral } from '../catalog/ddl';
import { visibleLine } from '../markdown';
import { maskSecretStatements, namesSecret } from '../sql/history-mask';
import {
  dateParts,
  findPlaceholders,
  parseParameterHeader,
  scriptParameters,
  usageProblem,
} from '../sql/parameters';
import type { SqlToken } from '../sql/tokens';
import type { TemplateSource } from './search';

/** The format that this aantje reads and writes: the value of the line `-- aantje-template:`. */
export const TEMPLATE_FORMAT = '1';

/** The longest template text that aantje keeps, in UTF-8 bytes; the Query History keeps statements up to the same size. */
export const MAX_TEMPLATE_BYTES = 64 * 1024;

/**
 * The fields of a template header besides its parameters, as the list shows them: the texts on one line, nothing
 * invisible.
 */
export interface TemplateFields {
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  /**
   * The day of the field `created`, in milliseconds since 1970: read from a header, the start of that day in UTC;
   * written into one, the day of the time in UTC. Undefined without the field.
   */
  readonly created?: number;
}

/** A template of any source, read and checked. */
export interface Template extends TemplateFields {
  /** Stable for the template's life: `builtin-...` for one of aantje, `folder-...` for a file of a folder. */
  readonly id: string;
  readonly source: TemplateSource;
  /** The whole text, header and SQL, with LF line ends and without a byte order mark. */
  readonly text: string;
  /** The file of a template of a folder (`aantje.templates.folders`). */
  readonly file?: string;
  /**
   * When the template was created, in milliseconds since 1970. An own or imported one: when it was kept first. A
   * built-in or folder one: the start of the day of its field `created` in UTC, undefined without the field.
   */
  readonly created?: number;
}

/** What `checkTemplate` found: whether the text is meant as a template at all, its fields, and why aantje refuses it. */
export interface TemplateCheck {
  /** The header has the line `-- aantje-template: ...`; a `.sql` file without it is no template. */
  readonly marked: boolean;
  readonly fields: TemplateFields;
  /** Empty when the template can be kept. */
  readonly problems: readonly string[];
}

type FieldName = 'aantje-template' | 'name' | 'description' | 'tags' | 'created';

const FIELD_LINE = /^--\s*(aantje-template|name|description|tags|created)\s*:(.*)$/i;
const PARAM_LINE = /^--\s*param\s*:/i;

// The shapes of keys and tokens that no template needs: an AWS access key id, a private key, a JSON Web Token, the
// account key or signature of Azure storage.
const KEY_SHAPES: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/,
  /\b(?:AccountKey|SharedAccessSignature|sig)=[^\s;&'"]{8,}/i,
];

// What a statement may hand over where the Query History masks a secret: a placeholder, or an empty literal.
const NO_SECRET = /^(?:\{\{\s*[A-Za-z_]\w*\s*\}\}|\$[A-Za-z_]\w*|'')?$/;

/** The text as aantje keeps it: LF line ends, no byte order mark. */
export const normalizedText = (text: string): string => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

/**
 * The number of lines of the header: the comment lines and blank lines at the start, as `parseParameterHeader` reads
 * them. The SQL starts at the first other line.
 */
export function headerLength(lines: readonly string[]): number {
  const end = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('--');
  });
  return end === -1 ? lines.length : end;
}

/** The field of a header line (`-- name: ...`), or undefined for any other line. */
export function fieldOf(line: string): { readonly field: FieldName; readonly value: string } | undefined {
  const match = FIELD_LINE.exec(line.trim());
  return match
    ? { field: (match[1] ?? '').toLowerCase() as FieldName, value: (match[2] ?? '').trim() }
    : undefined;
}

/** Whether a line declares a parameter (`-- param: ...`, read by `parseParameterHeader`). */
export const isParameterLine = (line: string): boolean => PARAM_LINE.test(line.trim());

/** The tags of a `tags` field or of what the user typed: separated by commas, each once, none empty. */
export function tagsOf(text: string): string[] {
  const tags: string[] = [];
  for (const part of text.split(',')) {
    const tag = visibleLine(part).trim();
    if (tag !== '' && !tags.some((known) => known.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  return tags;
}

/** The size of a text in UTF-8 bytes. */
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/** The value of the field `created` for a time (milliseconds since 1970): its day in UTC, `YYYY-MM-DD`. */
export const createdDay = (time: number): string => new Date(time).toISOString().slice(0, 10);

/** The header lines of a text. */
function headerOf(text: string): string[] {
  const lines = normalizedText(text).split('\n');
  return lines.slice(0, headerLength(lines));
}

/** The fields of a template that passed `checkTemplate`, as the list shows them. */
export const fieldsOf = (text: string): TemplateFields => readFields(headerOf(text)).fields;

/**
 * Reads and checks a template: its fields, its parameter lines, how its placeholders use them (`tokens` are DuckDB's
 * tokens of the text), its size, and that it holds no secret. A template with a problem is refused on save and import.
 */
export function checkTemplate(text: string, tokens: readonly SqlToken[]): TemplateCheck {
  const header = headerOf(text);
  const read = readFields(header);
  const problems = [...read.problems];
  if (utf8Bytes(text) > MAX_TEMPLATE_BYTES) {
    problems.push(`The template is longer than ${MAX_TEMPLATE_BYTES / 1024} KB.`);
  }
  const parameters = parseParameterHeader(text);
  problems.push(
    ...parameters.problems.map((problem) => `A parameter line cannot be read: ${withoutLine(problem)}.`),
  );
  const used = scriptParameters(parameters.declarations, findPlaceholders(text, tokens));
  problems.push(...used.flatMap((parameter) => usageProblem(parameter) ?? []));
  problems.push(...secretProblems(text, header, parameters.declarations));
  return { marked: read.marked, fields: read.fields, problems };
}

function readFields(header: readonly string[]): {
  marked: boolean;
  fields: TemplateFields;
  problems: string[];
} {
  const values = new Map<FieldName, string>();
  const problems: string[] = [];
  for (const line of header) {
    const found = fieldOf(line);
    if (!found) continue;
    if (values.has(found.field)) problems.push(`The field ${found.field} is given twice; give it once.`);
    else values.set(found.field, found.value);
  }
  const format = values.get('aantje-template');
  const name = visibleLine(values.get('name') ?? '').trim();
  if (format === undefined) {
    problems.push(`It is no template: its header has no line "-- aantje-template: ${TEMPLATE_FORMAT}".`);
  } else if (format !== TEMPLATE_FORMAT) {
    problems.push(
      `The template has the format "${visibleLine(format)}"; this aantje reads format ${TEMPLATE_FORMAT}.`,
    );
  }
  if (name === '') problems.push('The template has no name: add a line "-- name: ..." to its header.');
  const created = values.get('created');
  const day = created === undefined ? undefined : dateParts(created);
  if (created !== undefined && !day) {
    problems.push(
      'The field created is no day: write the day the template was created as YYYY-MM-DD, such as 2026-11-16.',
    );
  }
  return {
    marked: format !== undefined,
    fields: {
      name,
      description: visibleLine(values.get('description') ?? '').trim(),
      tags: tagsOf(values.get('tags') ?? ''),
      ...(day ? { created: Date.UTC(day.year, day.month - 1, day.day) } : {}),
    },
    problems,
  };
}

/**
 * Why a template looks like it holds a secret: a default of a parameter named like one (as the Query History masks the
 * values of such parameters), a password in a header line, the shape of a key or token anywhere, or a statement that
 * hands over a value where the Query History masks a secret (`CREATE SECRET`, a `SET` of a key, a password in a
 * connection string) unless that value is a placeholder.
 */
function secretProblems(
  text: string,
  header: readonly string[],
  declarations: ReturnType<typeof parseParameterHeader>['declarations'],
): string[] {
  const problems = declarations
    .filter(({ name, defaultValue }) => defaultValue !== undefined && namesSecret(name))
    .map(
      ({ name }) =>
        `The parameter ${name} is named like a secret and has a default, but a template keeps no secret: leave its default empty, the dialog asks for it.`,
    );
  if (header.some((line) => maskSecretStatements(quoteLiteral(line)).hidden.length > 0)) {
    problems.push('A header line holds a password: a template keeps no secret.');
  }
  if (KEY_SHAPES.some((shape) => shape.test(text))) {
    problems.push('The template holds what looks like a key or a token: a template keeps no secret.');
  }
  const handed = maskSecretStatements(text).hidden.filter((value) => !NO_SECRET.test(value.trim()));
  if (handed.length > 0) {
    problems.push(
      'A statement hands over a secret (CREATE SECRET, a SET of a key or token, a password in a connection string): write a placeholder such as {{key_id}} or $secret in its place.',
    );
  }
  return problems;
}

// A problem of `parseParameterHeader` ends with the line it is about, `(-- param: ...)`; a message and the log get the
// problem without it, since the line may hold the secret that made the template refused.
function withoutLine(problem: string): string {
  const at = problem.indexOf(' (--');
  return at === -1 ? problem : problem.slice(0, at);
}

/** The first problem of a check and how many more there are, for a message. */
export function problemText(problems: readonly string[]): string {
  const [first = '', ...rest] = problems;
  return rest.length === 0 ? first : `${first} (and ${rest.length} more)`;
}
