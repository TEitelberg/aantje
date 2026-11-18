/// <reference lib="dom" />
// The tab Columns of the Dependencies page: the sources of the columns of a view, the columns that filter, join and
// group its rows, and the view columns that use the columns of the object. Plain tables: a row opens nothing.
import { dataTable, note, tableRow, truncation } from '../shell/blocks';
import { el } from '../shell/dom';
import type { Reach } from './columns';
import { KIND_SIGN, nameAt } from './model';
import type { DependenciesData } from './model';
import { LINEAGE_TABLES, USE_LABEL, lineageColumn, lineageView } from './lineage-view';
import type { SourceRow } from './lineage-view';

// Rows of each table at most; Show Column Lineage on one column shows fewer.
const MAX_COLUMN_ROWS = 500;

type Cell = string | HTMLElement;

// A column of another object as two cells: its name, and the object with the sign of its kind.
function columnCells(data: DependenciesData, column: number): HTMLElement[] {
  const { name, node } = lineageColumn(data, column);
  const kind = node === undefined ? undefined : data.nodes[node]?.kind;
  return [
    el('td', 'name', name),
    el('td', 'name', node === undefined || !kind ? '' : `${KIND_SIGN[kind]} ${nameAt(data, node)}`),
  ];
}

const levelCell = (level: number): HTMLElement => el('td', 'number', String(level));

const reachCells = (data: DependenciesData, reach: Reach): Cell[] => [
  ...columnCells(data, reach.column),
  USE_LABEL[reach.use],
  levelCell(reach.level),
];

function sourceCells(data: DependenciesData, source: SourceRow['source']): Cell[] {
  switch (source.kind) {
    case 'column':
      return reachCells(data, source.reach);
    case 'unknown':
      return [el('td', 'detail-text', `unknown: ${source.detail}`), '', '', levelCell(source.level)];
    case 'none':
      return ['', '', '', ''];
  }
}

// The rows of the columns of the object: the name of a column in the first row of its group, an empty cell in the others.
function grouped<T extends { readonly column: number }>(
  data: DependenciesData,
  rows: readonly T[],
  cells: (row: T) => Cell[],
): HTMLTableRowElement[] {
  let previous: number | undefined;
  return rows.map((row) => {
    const first = row.column !== previous;
    previous = row.column;
    return tableRow([el('td', 'name', first ? lineageColumn(data, row.column).name : ''), ...cells(row)]);
  });
}

// A table under its title, `None.` without rows, and a note when it is cut; in a block of the class `column-<key>`.
function section(
  key: keyof typeof LINEAGE_TABLES,
  rows: readonly HTMLTableRowElement[],
  total: number,
  noun: string,
): HTMLElement {
  const table = LINEAGE_TABLES[key];
  const headings = table.headings.map((heading) =>
    heading === 'Level' ? el('th', 'number', heading) : heading,
  );
  const block = el('div', `column-${key}`);
  block.append(
    el('h2', undefined, table.title),
    rows.length === 0 ? note('None.') : dataTable(headings, rows),
    ...(total > rows.length
      ? [truncation(rows.length, total, noun, 'Open as Markdown has the first 200 of them as text.')]
      : []),
  );
  return block;
}

/** The tab of the object of the report; empty without a lineage, and for the lake or a schema. */
export function lineageChildren(data: DependenciesData): HTMLElement[] {
  const view = lineageView(data);
  const { target, lineage } = data;
  if (!view || !lineage || target === null) return [];
  if (view.opaque !== undefined) {
    return [note(`The columns of ${nameAt(data, target)} cannot be told: ${view.opaque}.`, 'warning')];
  }
  const children: HTMLElement[] =
    lineage.omitted > 0
      ? [
          note(
            `The report holds the first ${lineage.edges.length} dependencies between columns; ${lineage.omitted} more are left out.`,
            'warning',
          ),
        ]
      : [];
  if (data.nodes[target]?.kind === 'view') {
    const sources = view.sources.slice(0, MAX_COLUMN_ROWS);
    const rows = view.rows.slice(0, MAX_COLUMN_ROWS);
    children.push(
      section(
        'sources',
        grouped(data, sources, ({ source }) => sourceCells(data, source)),
        view.sources.length,
        'sources',
      ),
      section(
        'rows',
        rows.map((reach) => tableRow(reachCells(data, reach))),
        view.rows.length,
        'columns',
      ),
    );
  }
  const users = view.users.slice(0, MAX_COLUMN_ROWS);
  children.push(
    section(
      'users',
      grouped(data, users, ({ user }) => reachCells(data, user)),
      view.users.length,
      'uses',
    ),
  );
  return children;
}
