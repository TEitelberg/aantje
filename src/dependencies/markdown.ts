import { capRows, code, markdownTable, reportHeadingLine } from '../markdown';
import { DARK_ROLES } from '../shell/house-colors';
import { scopeSchema } from '../shell/scope';
import { markdownText } from '../markdown';
import {
  DIRECTIONS,
  DIRECTION_LABEL,
  DEPENDENCIES_KIND_LABEL,
  MAX_DEPTH,
  issuesOf,
  lakeRows,
  limitNote,
  nameAt,
  traverse,
} from './model';
import type { DependenciesData } from './model';
import { lineageMarkdown } from './lineage-markdown';
import { lineageName } from './lineage-view';
import { picture } from './picture';
import type { GraphReach, Picture, PictureItem } from './picture';

/** The choices on the page that the document repeats; the extension fits them to the data. */
export interface DependenciesMarkdownView {
  /** How many levels the tables of an object follow. */
  readonly depth: number;
  /** The filter box of the table of the lake or a schema. */
  readonly text: string;
  /** What the graph of an object holds besides the objects connected to it; nothing more without it. */
  readonly reach?: GraphReach | undefined;
}

// The page shows more rows; a smaller depth or a filter reaches the others.
const MARKDOWN_ROWS = 200;
const MARKDOWN_OBJECTS = 100;
// Larger graphs are unreadable as a diagram, and Mermaid refuses more than 500 edges.
const MARKDOWN_GRAPH_ITEMS = 150;
const MARKDOWN_GRAPH_EDGES = 400;

// The opening and the closing of each shape, in Mermaid's flowchart syntax.
const MERMAID_SHAPE: Readonly<Record<PictureItem['kind'], readonly [string, string]>> = {
  table: ['[(', ')]'],
  view: ['[', ']'],
  scalarMacro: ['([', '])'],
  tableMacro: ['[[', ']]'],
  missing: ['{{', '}}'],
};

// Catalog text in a quoted Mermaid label: characters that Mermaid or HTML would read become entity codes.
const mermaidText = (text: string): string =>
  text.replace(/\s+/g, ' ').replace(/[#"<>&`]/g, (char) => `#${char.codePointAt(0)};`);

/** The graph as a Mermaid flowchart along the data flow; too large a graph is only counted. */
export function mermaidGraph(shown: Picture): string[] {
  if (shown.items.length > MARKDOWN_GRAPH_ITEMS || shown.edges.length > MARKDOWN_GRAPH_EDGES) {
    return [
      `The graph has ${shown.items.length} objects and ${shown.edges.length} dependencies; a document draws it up to ${MARKDOWN_GRAPH_ITEMS} objects and ${MARKDOWN_GRAPH_EDGES} dependencies.`,
    ];
  }
  const classes = (name: string, test: (item: PictureItem) => boolean): string[] => {
    const items = shown.items.flatMap((item, index) => (test(item) ? [`n${index}`] : []));
    return items.length === 0 ? [] : [`  class ${items.join(',')} ${name}`];
  };
  return [
    '```mermaid',
    'flowchart LR',
    ...shown.items.map((item, index) => {
      const [open, close] = MERMAID_SHAPE[item.kind];
      return `  n${index}${open}"${mermaidText(item.name)}"${close}`;
    }),
    ...shown.edges.map(({ from, to, kind }) => `  n${from} ${kind === 'reads' ? '-->' : '-.->'} n${to}`),
    // The error colour of aantje that keeps 3:1 on a light and on a dark Markdown preview.
    `  classDef missing stroke:${DARK_ROLES.error},stroke-dasharray:4`,
    '  classDef faint opacity:0.4',
    ...classes('missing', ({ kind }) => kind === 'missing'),
    ...classes('faint', ({ faint }) => faint),
    '```',
  ];
}

function graphSection(shown: Picture): string[] {
  return [
    '## Graph',
    '',
    'The data flows from left to right; a dashed arrow is a call of a macro or a name that no object has.',
    '',
    ...mermaidGraph(shown),
    '',
  ];
}

// The key figures of the problems, as the page counts them.
function problemRows(data: DependenciesData): string[][] {
  const { broken, unresolved } = issuesOf(data);
  return [
    ['Broken references', String(broken.length)],
    ['Not followed', String(unresolved.length)],
  ];
}

function lakeMarkdown(data: DependenciesData, text: string): string {
  // One cut, at the limit of the document, so that one note counts everything left out.
  const { rows, omitted } = lakeRows(data, text, MARKDOWN_OBJECTS);
  const note = limitNote(data);
  return [
    reportHeadingLine('Dependencies', data.connection, scopeSchema(data.scope)),
    '',
    `Read at snapshot @${data.snapshot}.`,
    '',
    ...(note ? [note, ''] : []),
    ...markdownTable(
      ['Property', 'Value'],
      [
        ...(data.scope.kind === 'schema'
          ? [
              [
                'Scope',
                `The objects of the schema ${code(data.scope.name)} that use or are used by another, and the objects of other schemas next to them`,
              ],
            ]
          : []),
        ['Objects with dependencies', String(data.nodes.length)],
        ['Dependencies', String(data.edges.length)],
        ...problemRows(data),
        ['Objects without any', String(data.isolated)],
        ['Filter', text === '' ? 'none' : code(text)],
      ],
    ),
    '',
    '## Objects',
    '',
    ...(rows.length === 0
      ? ['No object matches the filter.']
      : [
          ...markdownTable(
            ['Name', 'Type', 'Used by', 'Depends on'],
            rows.map(({ node, usedBy, dependsOn }) => [
              code(nameAt(data, node)),
              DEPENDENCIES_KIND_LABEL[data.nodes[node]?.kind ?? 'table'],
              String(usedBy),
              String(dependsOn),
            ]),
          ),
          ...(omitted > 0 ? ['', `… ${omitted} more omitted (limit: ${MARKDOWN_OBJECTS}).`] : []),
        ]),
    '',
    ...(data.nodes.length > 0 ? graphSection(picture(data, { reach: 'all' })) : []),
  ].join('\n');
}

// The tables of an object as on the page: what it depends on, then what uses it, to the depth.
function objectTables(data: DependenciesData, start: number, depth: number): string[] {
  return DIRECTIONS.flatMap((direction) => {
    const { rows, cycle } = traverse(data, start, direction, depth);
    const listed = capRows(rows, MARKDOWN_ROWS);
    return [
      `## ${DIRECTION_LABEL[direction]}`,
      '',
      ...(rows.length === 0
        ? ['None.']
        : [
            ...markdownTable(
              ['Name', 'Type', 'Level'],
              listed.shown.map((row) => [
                code(nameAt(data, row.node)),
                DEPENDENCIES_KIND_LABEL[data.nodes[row.node]?.kind ?? 'table'],
                String(row.depth),
              ]),
            ),
            ...listed.omitted,
          ]),
      ...(cycle ? ['', 'The dependencies contain a cycle; each object is listed once.'] : []),
      '',
    ];
  });
}

/** The Dependencies report as Markdown, for one object or for the lake or a schema. Catalog text is code. */
export function dependenciesMarkdown(data: DependenciesData, view?: DependenciesMarkdownView): string {
  const start = data.target;
  const target = start === null ? undefined : data.nodes[start];
  if (start === null || !target) {
    return lakeMarkdown(data, view?.text.trim() ?? '');
  }
  const depth = Math.min(Math.max(Math.trunc(view?.depth ?? MAX_DEPTH), 1), MAX_DEPTH);
  const focus = data.lineage?.focus;
  const note = limitNote(data);
  return [
    focus === undefined
      ? reportHeadingLine('Dependencies', data.connection, nameAt(data, start))
      : reportHeadingLine('Column Lineage', data.connection, lineageName(data, focus)),
    '',
    `Read from ${markdownText(data.connection.replace(/\s+/g, ' ').trim())} at snapshot @${data.snapshot}.`,
    '',
    ...(note ? [note, ''] : []),
    ...markdownTable(
      ['Property', 'Value'],
      [
        ['Object', code(nameAt(data, start))],
        ['Kind', DEPENDENCIES_KIND_LABEL[target.kind]],
        ['Depth', String(depth)],
        ...problemRows(data),
      ],
    ),
    '',
    ...objectTables(data, start, depth),
    ...lineageMarkdown(data),
    ...graphSection(picture(data, { reach: view?.reach ?? 'connected' })),
  ].join('\n');
}
