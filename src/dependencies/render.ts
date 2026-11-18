/// <reference lib="dom" />
// DOM builders of the Dependencies page. They take the state they show and report user input through callbacks.
import { dataTable, modeGroup, note, tableRow, truncation } from '../shell/blocks';
import { el } from '../shell/dom';
import type { PagedColumn, PagedRow } from '../shell/paged-table';
import { iconButton } from './icons';
import {
  DEPENDENCIES_KIND_LABEL,
  DEPTHS,
  DIRECTIONS,
  DIRECTION_LABEL,
  KIND_SIGN,
  lakeRows,
  limitNote,
  nameAt,
  traverse,
} from './model';
import type { DependenciesData } from './model';
import type { GraphReach } from './picture';
import type { DependenciesActionId } from './protocol';

/** What the icons of an object do: Visualize stays on the page, the other actions go to the extension. */
export interface Act {
  readonly ask: (action: DependenciesActionId, node: number) => void;
  readonly visualize: (node: number) => void;
}

/** The kind of an object as its sign and word (`◧ view`): the meaning does not hang on colour. */
function kindText(current: DependenciesData, node: number): string {
  const found = current.nodes[node];
  return found ? `${KIND_SIGN[found.kind]} ${DEPENDENCIES_KIND_LABEL[found.kind]}` : '';
}

/**
 * The actions of an object as icon buttons, each named for a screen reader with the object: Visualize, Dependencies
 * (not of the object of the report), Statistics (of a table) and Show in tree.
 */
export function objectIcons(current: DependenciesData, node: number, act: Act): HTMLElement {
  const name = nameAt(current, node);
  const icons = el('span');
  icons.append(
    iconButton('graph', 'Visualize', `Show ${name} in the graph of the dependencies`, () =>
      act.visualize(node),
    ),
    ...(node === current.target
      ? []
      : [
          iconButton('hierarchy', 'Dependencies', `Show the dependencies of ${name}`, () =>
            act.ask('showDependencies', node),
          ),
        ]),
    ...(current.nodes[node]?.kind === 'table'
      ? [
          iconButton('chart', 'Statistics', `Show the statistics of ${name}`, () =>
            act.ask('showStatistics', node),
          ),
        ]
      : []),
    iconButton('tree', 'Show in tree', `Show ${name} in the tree`, () => act.ask('showInTree', node)),
  );
  return icons;
}

/** The actions of the object of a report in its header, before Refresh: Statistics of a table, Show in tree. */
export function headerIcons(current: DependenciesData, ask: Act['ask']): HTMLElement[] {
  const { target } = current;
  if (target === null) return [];
  const name = nameAt(current, target);
  return [
    ...(current.nodes[target]?.kind === 'table'
      ? [
          iconButton('chart', 'Statistics', `Show the statistics of ${name}`, () =>
            ask('showStatistics', target),
          ),
        ]
      : []),
    iconButton('tree', 'Show in tree', `Show ${name} in the tree`, () => ask('showInTree', target)),
  ];
}

/** The columns of the table of the lake or a schema; the last holds the icons of the actions. */
export const LAKE_COLUMNS: readonly PagedColumn[] = [
  { label: 'Name', className: 'name' },
  { label: 'Type' },
  { label: 'Used by', className: 'number' },
  { label: 'Depends on', className: 'number' },
  { label: '', className: 'icons', description: 'Actions' },
];

/**
 * The rows of the table of the lake or a schema, most used first, then by name (`lakeRows`): the name as text, the kind,
 * the numbers of direct users and dependencies, and the icons. The filter box finds the name and the kind.
 */
export function lakeTableRows(current: DependenciesData, act: Act): PagedRow<number>[] {
  return lakeRows(current, '').rows.map(({ node, usedBy, dependsOn }) => ({
    key: node,
    label: nameAt(current, node),
    cells: [kindText(current, node), String(usedBy), String(dependsOn), objectIcons(current, node, act)],
    search: DEPENDENCIES_KIND_LABEL[current.nodes[node]?.kind ?? 'table'],
  }));
}

/** What the table and the graph of the lake or a schema show without objects. */
export const emptyLakeText = (current: DependenciesData): string =>
  current.scope.kind === 'schema'
    ? `No view or macro of the schema ${current.scope.name} uses or is used by a table, view or macro.`
    : 'No view or macro in this lake uses a table, view or macro.';

/** The depth of the tables of an object as a drop-down, Depth 1 to Depth 5. */
export function depthPicker(depth: number, onDepth: (depth: number) => void): HTMLSelectElement {
  const control = el('select');
  control.setAttribute('aria-label', 'Depth');
  for (const value of DEPTHS) {
    const option = el('option', undefined, `Depth ${value}`);
    option.value = String(value);
    control.append(option);
  }
  control.value = String(depth);
  control.addEventListener('change', () => {
    const chosen = Number(control.value);
    if (DEPTHS.includes(chosen)) onDepth(chosen);
  });
  return control;
}

/** What the graph of an object holds: the objects connected to it, or every object with dependencies, faint. */
export const reachGroup = (reach: GraphReach, onReach: (reach: GraphReach) => void): HTMLElement =>
  modeGroup(
    'Objects in the graph',
    [
      { value: 'connected' as const, text: 'Connected' },
      { value: 'all' as const, text: 'Show all' },
    ],
    reach,
    onReach,
    { className: 'mode-group' },
  );

const OBJECT_CLASS = { dependsOn: 'depends-on', usedBy: 'used-by' } as const;

// The table of one side of an object: Name, Type, Level and the icons, in the order of the chain. The widths of the
// columns are fixed after the name (style.ts), so that the two tables line up.
function sideTable(
  current: DependenciesData,
  rows: ReturnType<typeof traverse>['rows'],
  act: Act,
): HTMLElement {
  return dataTable(
    ['Name', el('th', 'kind', 'Type'), el('th', 'number', 'Level'), iconHeading()],
    rows.map(({ node, depth }) => {
      const icons = el('td', 'icons');
      icons.append(objectIcons(current, node, act));
      return tableRow([
        el('td', 'name', nameAt(current, node)),
        kindText(current, node),
        el('td', 'number', String(depth)),
        icons,
      ]);
    }),
  );
}

// The heading of a column of icons: empty on the screen, Actions for a screen reader.
function iconHeading(): HTMLTableCellElement {
  const heading = el('th', 'icons');
  heading.title = 'Actions';
  heading.setAttribute('aria-label', 'Actions');
  return heading;
}

/**
 * The tables of an object: what it depends on and what uses it, each through the chain up to `depth`, every object once
 * at the level where it is first reached. Each under its title, `None.` when it is empty.
 */
export function objectTables(current: DependenciesData, depth: number, act: Act): HTMLElement[] {
  const target = current.target;
  if (target === null) return [];
  const sides = DIRECTIONS.map((direction) => ({
    direction,
    ...traverse(current, target, direction, depth),
  }));
  return [
    ...(sides.some(({ cycle }) => cycle) ? [note('The dependencies contain a cycle.', 'warning')] : []),
    ...sides.map(({ direction, rows, omitted }) => {
      const side = el('div', OBJECT_CLASS[direction]);
      side.append(
        el('h2', undefined, DIRECTION_LABEL[direction]),
        rows.length === 0 ? note('None.') : sideTable(current, rows, act),
        ...(omitted > 0
          ? [
              truncation(
                rows.length,
                rows.length + omitted,
                'objects',
                'Choose a smaller depth to see fewer levels.',
              ),
            ]
          : []),
      );
      return side;
    }),
  ];
}

/** The notes above the tabs: views and macros left unread, what a schema report holds, objects left out of the lake. */
export function noteChildren(current: DependenciesData): HTMLElement[] {
  const limit = limitNote(current);
  return [
    ...(limit ? [note(limit, 'warning')] : []),
    ...(current.scope.kind === 'schema'
      ? [
          note(
            `The objects of the schema ${current.scope.name} and the objects of other schemas next to them; their counts are those of the edges listed here.`,
          ),
        ]
      : []),
    ...(current.target === null && current.isolated > 0
      ? [note(`${current.isolated} objects use no other object and are used by none; they are not listed.`)]
      : []),
  ];
}
