import { capRows, code, markdownTable, reportTitle } from '../markdown';
import { scopeSchema } from '../shell/scope';
import { markdownText } from '../tree/format';
import {
  BROKEN_KIND,
  DIRECTIONS,
  DIRECTION_LABEL,
  DEPENDENCIES_KIND_LABEL,
  MAX_DEPTH,
  REASON_TEXT,
  brokenName,
  dropImpact,
  edgeVerb,
  impactText,
  issuesOf,
  lakeRows,
  limitNote,
  nameAt,
  traverse,
} from './model';
import type { DependenciesData, Direction } from './model';

/** The choices on the page that the document repeats; the extension fits them to the data. */
export interface DependenciesMarkdownView {
  readonly direction: Direction;
  readonly depth: number;
  /** The filter of the lake list. */
  readonly text: string;
}

// The page shows more rows; a smaller depth or a filter reaches the others.
const MARKDOWN_ROWS = 200;
const MARKDOWN_OBJECTS = 100;
const MARKDOWN_NAMES = 50;
const MARKDOWN_ISSUES = 100;

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
  const shown = new Set([start]);
  const lists = (view ? [view.direction] : DIRECTIONS).flatMap((direction) => {
    const { rows, cycle } = traverse(data, start, direction, depth);
    for (const { node } of rows) {
      shown.add(node);
    }
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
  const impact = dropImpact(data, start);
  const names = capRows(
    impact.objects.map((node) => `- ${code(nameAt(data, node))}`),
    MARKDOWN_NAMES,
  );
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
    `## If you drop ${code(nameAt(data, start))}`,
    '',
    impactText(code(nameAt(data, start)), impact),
    ...(impact.objects.length > 0 ? ['', ...names.shown, ...names.omitted] : []),
    '',
    ...issueTables(data, shown),
    '',
  ].join('\n');
}
