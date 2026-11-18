// The columns in Open as Markdown: the tables of the tab Columns, with the same titles. Catalog text is code.
import { capRows, code, markdownTable } from '../markdown';
import type { Reach } from './columns';
import { LINEAGE_TABLES, USE_LABEL, lineageColumn, lineageView } from './lineage-view';
import type { SourceRow } from './lineage-view';
import { nameAt } from './model';
import type { DependenciesData } from './model';

// The page shows more rows; Show Column Lineage on one column shows fewer.
const MARKDOWN_COLUMN_ROWS = 200;

// A column of another object as two cells: its name and its object.
function columnCells(data: DependenciesData, column: number): string[] {
  const { name, node } = lineageColumn(data, column);
  return [code(name), node === undefined ? '' : code(nameAt(data, node))];
}

const reachCells = (data: DependenciesData, reach: Reach): string[] => [
  ...columnCells(data, reach.column),
  USE_LABEL[reach.use],
  String(reach.level),
];

function sourceCells(data: DependenciesData, source: SourceRow['source']): string[] {
  switch (source.kind) {
    case 'column':
      return reachCells(data, source.reach);
    case 'unknown':
      return [`unknown: ${code(source.detail)}`, '', '', String(source.level)];
    case 'none':
      return ['', '', '', ''];
  }
}

// The name of a column of the object in the first row of its group, an empty cell in the others.
function grouped<T extends { readonly column: number }>(
  data: DependenciesData,
  rows: readonly T[],
  cells: (row: T) => string[],
): string[][] {
  let previous: number | undefined;
  return rows.map((row) => {
    const first = row.column !== previous;
    previous = row.column;
    return [first ? code(lineageColumn(data, row.column).name) : '', ...cells(row)];
  });
}

// A table under its title, `None.` without rows; at most `MARKDOWN_COLUMN_ROWS` rows, then a line counting the rest.
function section<T>(
  table: (typeof LINEAGE_TABLES)[keyof typeof LINEAGE_TABLES],
  rows: readonly T[],
  cells: (shown: readonly T[]) => string[][],
): string[] {
  const capped = capRows(rows, MARKDOWN_COLUMN_ROWS);
  return [
    `### ${table.title}`,
    '',
    ...(rows.length === 0
      ? ['None.']
      : [...markdownTable(table.headings, cells(capped.shown)), ...capped.omitted]),
    '',
  ];
}

/** The section Columns of the object of the report; nothing without a lineage, and for the lake or a schema. */
export function lineageMarkdown(data: DependenciesData): string[] {
  const view = lineageView(data);
  const { lineage, target } = data;
  if (!view || !lineage || target === null) return [];
  if (view.opaque !== undefined) {
    return [
      '## Columns',
      '',
      `The columns of ${code(nameAt(data, target))} cannot be told: ${code(view.opaque)}.`,
      '',
    ];
  }
  const isView = data.nodes[target]?.kind === 'view';
  return [
    '## Columns',
    '',
    ...(lineage.omitted > 0
      ? [
          `The report holds the first ${lineage.edges.length} dependencies between columns; ${lineage.omitted} more are left out.`,
          '',
        ]
      : []),
    ...(isView
      ? [
          ...section(LINEAGE_TABLES.sources, view.sources, (shown) =>
            grouped(data, shown, ({ source }) => sourceCells(data, source)),
          ),
          ...section(LINEAGE_TABLES.rows, view.rows, (shown) =>
            shown.map((reach) => reachCells(data, reach)),
          ),
        ]
      : []),
    ...section(LINEAGE_TABLES.users, view.users, (shown) =>
      grouped(data, shown, ({ user }) => reachCells(data, user)),
    ),
  ];
}
