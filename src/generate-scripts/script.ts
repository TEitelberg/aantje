import { quoteIdentifier } from '../catalog/ddl';
import type { SnapshotId } from '../catalog/model';
import { checkedScript } from '../ddl-script/check';
import type { Tokenize } from '../ddl-script/check';
import { macroLines, viewLines } from '../ddl-script/definitions';
import { commentName } from '../ddl-script/names';
import { createLines, tableDdl } from '../ddl-script/table-ddl';
import { ALL_FILE, filePaths } from './files';
import { compareObjects, graphKeyOf } from './objects';
import type { LakeObject } from './objects';
import { nodeKey } from '../dependencies/graph';
import { orderDefinitions } from './order';
import type { ScriptInput } from './read';
import type { PlannedFile } from './write';

// Generate Scripts: the schemas, then the tables, then the views and macros in an order that works. Structure only, no
// DROP. A statement that copies catalog text goes through DuckDB's tokenizer (`checkedScript`), so a text that leaves a
// quote or a comment open becomes a comment and cannot carry on into the statements below. Comment lines hold fixed
// text, the snapshot number, or names in their quoted form on one line (`commentName`).

/** The lines of one object: its notes and statements. */
export interface ScriptSection {
  readonly object: LakeObject;
  readonly lines: readonly string[];
}

export interface GeneratedScript {
  /** The whole script, as one document shows it. */
  readonly text: string;
  /** The objects in the order of the script, each with its own lines of it. */
  readonly sections: readonly ScriptSection[];
}

const header = (snapshot: SnapshotId): string[] => [
  `-- Generate Scripts: the structure of the selected tables, views and macros at snapshot ${snapshot}, without data. Nothing has run: read the statements, then run them in a read/write SQL session.`,
  '-- The names have no catalog prefix: run the script where the lake that gets the objects is the default catalog (USE lake;).',
];

const NO_GRAPH =
  '-- Which views and macros use which could not be read, so their order may not work: one may need another that comes after it.';
const UNCLEAR =
  '-- These come last: they use each other in a cycle, their SQL has a part that the analysis of the Dependencies report does not follow, or they use one of those. One may need another that comes after it.';

/** The note above a view or macro that uses objects which the script does not create. */
const outsideNote = (names: readonly (readonly [string, string])[] | undefined): string[] =>
  names === undefined
    ? []
    : [
        `-- Not in this script, but used by the statement below: ${names.map(([schema, name]) => commentName(schema, name)).join(', ')}.`,
      ];

/** The sections joined by empty lines. */
const joined = (sections: readonly ScriptSection[]): string[] =>
  sections.flatMap(({ lines }, index) => (index === 0 ? lines : ['', ...lines]));

/**
 * The script of the selected objects at the snapshot: `CREATE SCHEMA IF NOT EXISTS` for each schema, the tables as
 * Script as CREATE writes them with their partitioning, sort order and comments as live statements, then the views and
 * macros, each after everything it uses. DuckDB's tokenizer checks the statements that copy catalog text; nothing runs.
 */
export async function generateScript(input: ScriptInput, tokenize: Tokenize): Promise<GeneratedScript> {
  const objects = input.objects.toSorted(compareObjects);
  const definitions: LakeObject[] = objects.filter((object) => object.kind !== 'table');
  const order = orderDefinitions(
    definitions,
    graphKeyOf,
    new Set(objects.map((object) => nodeKey(graphKeyOf(object)))),
    input.graph,
  );
  const schemas = [...new Set(objects.map(({ schema }) => schema.name))];
  let sections: ScriptSection[] = [];
  const text = await checkedScript((check) => {
    // Views and macros are created where none is: their SQL is copied as stored, also from another dialect.
    const options = { head: 'create', note: 'copies', check } as const;
    const section = (object: LakeObject): ScriptSection[] => {
      const notes = outsideNote(order.outside.get(object));
      if (object.kind === 'view')
        return [{ object, lines: [...notes, ...viewLines(object.schema.name, object.view, options)] }];
      if (object.kind === 'macro')
        return [{ object, lines: [...notes, ...macroLines(object.schema.name, object.macro, options)] }];
      const table = input.tables.get(object.id);
      return table ? [{ object, lines: createLines(tableDdl(object.schema.name, table, check)) }] : [];
    };
    const tables = objects.filter(({ kind }) => kind === 'table').flatMap(section);
    const ordered = order.ordered.flatMap(section);
    const unclear = order.unclear.flatMap(section);
    sections = [...tables, ...ordered, ...unclear];
    // Without a graph every view and macro is here, and one alone needs no order.
    const tail = input.graph ? [UNCLEAR] : unclear.length > 1 ? [NO_GRAPH] : [];
    return [
      ...header(input.snapshot),
      '',
      ...schemas.map((name) => `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(name)};`),
      ...(tables.length + ordered.length > 0 ? ['', ...joined([...tables, ...ordered])] : []),
      ...(unclear.length > 0 ? ['', ...tail, ...joined(unclear)] : []),
    ];
  }, tokenize);
  return { text, sections };
}

/** `create-all.sql` with the whole script, and a file per object with its lines (`filePaths`); each ends in `\n`. */
export function scriptFiles({ text, sections }: GeneratedScript): PlannedFile[] {
  const objects = sections.map((section) => ({
    section,
    kind: section.object.kind,
    schemaName: section.object.schema.name,
    name: section.object.name,
    rank: section.object.kind === 'macro' && section.object.macro.kind === 'table' ? 1 : 0,
  }));
  const paths = filePaths(objects);
  return [
    { path: [ALL_FILE], text: `${text}\n` },
    ...objects.map((object) => ({
      path: paths.get(object) ?? [],
      text: `${object.section.lines.join('\n')}\n`,
    })),
  ];
}
