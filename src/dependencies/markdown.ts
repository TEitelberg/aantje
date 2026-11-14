import { capRows, code, markdownTable, reportTitle } from '../markdown';
import { scopeSchema } from '../shell/scope';
import { markdownText } from '../markdown';
import {
  BROKEN_KIND,
  DIRECTIONS,
  DIRECTION_LABEL,
  DEPENDENCIES_KIND_LABEL,
  MAX_DEPTH,
  REASON_TEXT,
  brokenName,
  edgeVerb,
  issuesOf,
  lakeRows,
  limitNote,
  nameAt,
  traverse,
} from './model';
import type { DependenciesData, Direction } from './model';
import { connectedObjects, picture } from './picture';
import type { GraphReach, Picture, PictureItem } from './picture';

/** The choices on the page that the document repeats; the extension fits them to the data. */
export interface DependenciesMarkdownView {
  readonly direction: Direction;
  readonly depth: number;
  /** The filter of the lake list. */
  readonly text: string;
  /** What the graph of an object holds besides what it uses and what uses it; nothing more without it. */
  readonly reach?: GraphReach | undefined;
}

// The page shows more rows; a smaller depth or a filter reaches the others.
const MARKDOWN_ROWS = 200;
const MARKDOWN_OBJECTS = 100;
const MARKDOWN_ISSUES = 100;
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
    '  classDef missing stroke:#f14c4c,stroke-dasharray:4',
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

function issueTables(data: DependenciesData, nodes?: ReadonlySet<number>): string[] {
  const { broken, unresolved } = issuesOf(data, nodes);
  const brokenRows = capRows(broken, MARKDOWN_ISSUES);
  const unresolvedRows = capRows(unresolved, MARKDOWN_ISSUES);
  return [
    '## Broken references',
    '',
    ...(broken.length === 0
      ? ['No object names something that the lake does not have.']
      : [
          ...markdownTable(
            ['Object', 'Names', 'As'],
            brokenRows.shown.map((item) => [
              code(nameAt(data, item.from)),
              code(brokenName(item)),
              BROKEN_KIND[item.kind],
            ]),
          ),
          ...brokenRows.omitted,
        ]),
    '',
    '## Not followed',
    '',
    ...(unresolved.length === 0
      ? ['Every text was read.']
      : [
          ...markdownTable(
            ['Object', 'Why', 'Detail'],
            unresolvedRows.shown.map((item) => [
              code(nameAt(data, item.node)),
              REASON_TEXT[item.reason],
              code(item.detail),
            ]),
          ),
          ...unresolvedRows.omitted,
        ]),
  ];
}

function lakeMarkdown(data: DependenciesData, text: string): string {
  // One cut, at the limit of the document, so that one note counts everything left out.
  const { rows, omitted } = lakeRows(data, text, MARKDOWN_OBJECTS);
  const note = limitNote(data);
  return [
    reportTitle('Dependencies in', data.connection, scopeSchema(data.scope)),
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
            ['Object', 'Kind', 'Used by', 'Depends on'],
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
    ...(data.nodes.length > 0 ? graphSection(picture(data, { depth: MAX_DEPTH, reach: 'all' })) : []),
    ...issueTables(data),
    '',
  ].join('\n');
}

/** The Dependencies report as Markdown, for one object or for the lake. Catalog text is code. */
export function dependenciesMarkdown(data: DependenciesData, view?: DependenciesMarkdownView): string {
  const start = data.target;
  const target = start === null ? undefined : data.nodes[start];
  if (start === null || !target) {
    return lakeMarkdown(data, view?.text.trim() ?? '');
  }
  const depth = Math.min(Math.max(Math.trunc(view?.depth ?? MAX_DEPTH), 1), MAX_DEPTH);
  const lists = (view ? [view.direction] : DIRECTIONS).flatMap((direction) => {
    const { rows, cycle } = traverse(data, start, direction, depth);
    const listed = capRows(rows, MARKDOWN_ROWS);
    return [
      `## ${DIRECTION_LABEL[direction]}`,
      '',
      ...(rows.length === 0
        ? [
            direction === 'usedBy'
              ? 'No view or macro uses this object.'
              : 'This object uses no table, view or macro.',
          ]
        : [
            ...markdownTable(
              ['Depth', 'Object', 'Kind', 'Edge'],
              listed.shown.map((row) => [
                String(row.depth),
                code(nameAt(data, row.node)),
                DEPENDENCIES_KIND_LABEL[data.nodes[row.node]?.kind ?? 'table'],
                `${edgeVerb(row.via, direction)} ${code(nameAt(data, row.parent))}`,
              ]),
            ),
            ...listed.omitted,
          ]),
      ...(cycle ? ['', 'The dependencies contain a cycle; each object is listed once.'] : []),
      '',
    ];
  });
  const note = limitNote(data);
  return [
    reportTitle('Dependencies of', nameAt(data, start)),
    '',
    `Read from ${markdownText(data.connection.replace(/\s+/g, ' ').trim())} at snapshot @${data.snapshot}.`,
    '',
    ...(note ? [note, ''] : []),
    ...markdownTable(
      ['Property', 'Value'],
      [
        ['Object', code(nameAt(data, start))],
        ['Kind', DEPENDENCIES_KIND_LABEL[target.kind]],
        ['Direction', view ? DIRECTION_LABEL[view.direction] : 'both'],
        ['Depth', String(depth)],
      ],
    ),
    '',
    ...lists,
    ...graphSection(picture(data, { depth, reach: view?.reach ?? 'connected' })),
    // The problems of what the graph connects, whatever direction the lists have; not of the faint objects.
    ...issueTables(data, connectedObjects(data, depth)),
    '',
  ].join('\n');
}
