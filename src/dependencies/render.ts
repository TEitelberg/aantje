/// <reference lib="dom" />
// DOM builders of the Dependencies page. They take the state they show and report user input through callbacks.
import { dataTable, empty, keyList, modeGroup, note, searchBox, tableRow, truncation } from '../shell/blocks';
import { el } from '../shell/dom';
import {
  BROKEN_KIND,
  DEPENDENCIES_KIND_LABEL,
  DEPTHS,
  DIRECTIONS,
  DIRECTION_LABEL,
  KIND_SIGN,
  MAX_ISSUES,
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
import { iconButton } from './icons';
import type { GraphReach } from './picture';
import type { DependenciesActionId } from './protocol';
import type { DependenciesShow } from './state';

const DETAIL_NAMES = 30;

type Ask = (action: DependenciesActionId, node: number) => void;

// The icons at the end of the heading line. `visualize` is given while the list shows: the graph is then one click away.
function actionsFor(
  current: DependenciesData,
  node: number,
  ask: Ask,
  visualize: ((node: number) => void) | undefined,
): HTMLElement {
  const found = current.nodes[node];
  const name = nameAt(current, node);
  const icons = el('div', 'icons');
  icons.append(
    ...(visualize
      ? [
          iconButton('graph', 'Visualize', `Show ${name} in the graph of the dependencies`, () =>
            visualize(node),
          ),
        ]
      : []),
    ...(node === current.target
      ? []
      : [
          iconButton('hierarchy', 'Dependencies', `Show the dependencies of ${name}`, () =>
            ask('showDependencies', node),
          ),
        ]),
    ...(found?.kind === 'table'
      ? [
          iconButton('chart', 'Statistics', `Show the statistics of ${name}`, () =>
            ask('showStatistics', node),
          ),
        ]
      : []),
    iconButton('tree', 'Show in tree', `Show ${name} in the tree`, () => ask('showInTree', node)),
  );
  return icons;
}

function neighbours(current: DependenciesData, node: number, which: Direction): HTMLElement[] {
  const { rows } = traverse(current, node, which, 1);
  const heading = el('h3', undefined, `${DIRECTION_LABEL[which]} (${rows.length})`);
  if (rows.length === 0) {
    return [
      heading,
      note(which === 'usedBy' ? 'No view or macro uses it.' : 'It uses no table, view or macro.'),
    ];
  }
  const items = el('ul');
  for (const row of rows.slice(0, DETAIL_NAMES)) {
    items.append(
      el(
        'li',
        undefined,
        `${KIND_SIGN[current.nodes[row.node]?.kind ?? 'table']} ${nameAt(current, row.node)}`,
      ),
    );
  }
  return [
    heading,
    items,
    ...(rows.length > DETAIL_NAMES ? [note(`… ${rows.length - DETAIL_NAMES} more not shown`)] : []),
  ];
}

/** The pane of the selected object: its heading line with the icons, and its direct neighbours; empty without one. */
export function detailChildren(
  data: DependenciesData | undefined,
  selected: number | undefined,
  ask: Ask,
  visualize?: (node: number) => void,
): HTMLElement[] {
  const node = selected === undefined ? undefined : data?.nodes[selected];
  if (!data || selected === undefined || !node) {
    return [];
  }
  const line = el('div', 'title-line');
  line.append(
    el(
      'h2',
      undefined,
      `${KIND_SIGN[node.kind]} ${nameAt(data, selected)} · ${DEPENDENCIES_KIND_LABEL[node.kind]}`,
    ),
    actionsFor(data, selected, ask, visualize),
  );
  return [line, ...neighbours(data, selected, 'usedBy'), ...neighbours(data, selected, 'dependsOn')];
}

/** The problems of the given objects (all of them without a set): broken references and texts not followed. */
export function issuesChildren(current: DependenciesData, covered?: ReadonlySet<number>): HTMLElement[] {
  const { broken, unresolved } = issuesOf(current, covered);
  const brokenRows = broken.slice(0, MAX_ISSUES).map((item) => {
    const name = el('td', 'name', nameAt(current, item.from));
    return tableRow([name, el('td', 'what', brokenName(item)), BROKEN_KIND[item.kind]]);
  });
  const unresolvedRows = unresolved.slice(0, MAX_ISSUES).map((item) => {
    const name = el('td', 'name', nameAt(current, item.node));
    return tableRow([name, REASON_TEXT[item.reason], el('td', 'detail-text', item.detail)]);
  });
  return [
    el('h2', undefined, 'Broken references'),
    broken.length === 0
      ? note('No object here names something that the lake does not have.')
      : dataTable(['Object', 'Names', 'As'], brokenRows),
    ...(broken.length > MAX_ISSUES ? [truncation(MAX_ISSUES, broken.length, 'broken references', '')] : []),
    el('h2', undefined, 'Not followed'),
    unresolved.length === 0
      ? note('Every text of the objects here was read.')
      : dataTable(['Object', 'Why', 'Detail'], unresolvedRows),
    ...(unresolved.length > MAX_ISSUES ? [truncation(MAX_ISSUES, unresolved.length, 'texts', '')] : []),
  ];
}

interface ListItem {
  readonly label: string;
  readonly selected: boolean;
  readonly indent: number;
  readonly description: string;
}

interface ListView {
  readonly items: readonly ListItem[];
  /** The object of each item. */
  readonly nodes: readonly number[];
  readonly cut: HTMLElement | undefined;
  readonly emptyText: string;
  readonly cycle: boolean;
}

interface ListInput {
  readonly text: string;
  readonly direction: Direction;
  readonly depth: number;
  readonly selected: number | undefined;
}

function lakeList(current: DependenciesData, input: ListInput): ListView {
  const { rows, omitted } = lakeRows(current, input.text);
  const items = rows.map(({ node, usedBy, dependsOn }) => {
    const found = current.nodes[node];
    const kind = found ? DEPENDENCIES_KIND_LABEL[found.kind] : '';
    return {
      label: `${KIND_SIGN[found?.kind ?? 'table']} ${nameAt(current, node)} · ${kind} · used by ${usedBy} · depends on ${dependsOn}`,
      selected: node === input.selected,
      indent: 0,
      description: `${kind} ${nameAt(current, node)}, used by ${usedBy}, depends on ${dependsOn}`,
    };
  });
  return {
    items,
    nodes: rows.map(({ node }) => node),
    cut:
      omitted > 0
        ? truncation(rows.length, rows.length + omitted, 'objects', 'Type in the filter to see the others.')
        : undefined,
    emptyText:
      current.nodes.length === 0
        ? 'No view or macro in this lake uses a table, view or macro.'
        : 'No object matches the filter.',
    cycle: false,
  };
}

function targetList(current: DependenciesData, target: number, input: ListInput): ListView {
  const { direction, depth } = input;
  const traversal = traverse(current, target, direction, depth);
  const items = traversal.rows.map((row) => {
    const found = current.nodes[row.node];
    const kind = found ? DEPENDENCIES_KIND_LABEL[found.kind] : '';
    const verb = `${edgeVerb(row.via, direction)} ${nameAt(current, row.parent)}`;
    return {
      label: `${KIND_SIGN[found?.kind ?? 'table']} ${nameAt(current, row.node)} · ${kind} · ${verb}`,
      selected: row.node === input.selected,
      indent: row.depth - 1,
      description: `Level ${row.depth}: ${kind} ${nameAt(current, row.node)}, ${verb}`,
    };
  });
  return {
    items,
    nodes: traversal.rows.map(({ node }) => node),
    cut:
      traversal.omitted > 0
        ? truncation(
            items.length,
            items.length + traversal.omitted,
            'objects',
            'Choose a smaller depth to see fewer levels.',
          )
        : undefined,
    emptyText:
      direction === 'usedBy'
        ? `No view or macro uses ${nameAt(current, target)}.`
        : `${nameAt(current, target)} uses no table, view or macro.`,
    cycle: traversal.cycle,
  };
}

export function listView(current: DependenciesData, input: ListInput): ListView {
  return current.target === null ? lakeList(current, input) : targetList(current, current.target, input);
}

export function noteChildren(current: DependenciesData, cycle: boolean): HTMLElement[] {
  const limit = limitNote(current);
  return [
    ...(limit ? [note(limit, 'warning')] : []),
    ...(cycle
      ? [
          note(
            'The dependencies contain a cycle. Each object is listed once, where it is first reached.',
            'warning',
          ),
        ]
      : []),
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

/** The list with arrow keys, Home and End; `buttons` are the focusable items in the order of `view.items`. */
export function listChildren(
  view: ListView,
  onSelect: (node: number) => void,
): { readonly children: HTMLElement[]; readonly buttons: HTMLElement[] } {
  if (view.items.length === 0) return { children: [empty(view.emptyText)], buttons: [] };
  const keyed = keyList(view.items, (index) => {
    const node = view.nodes[index];
    if (node !== undefined) onSelect(node);
  });
  const buttons = Array.from(keyed.children, (item) => item.children[0] as HTMLElement);
  view.items.forEach((item, index) => {
    const button = buttons[index];
    if (button) {
      button.style.paddingLeft = `${8 + item.indent * 20}px`;
      button.setAttribute('aria-label', item.description);
    }
  });
  return { children: [keyed, ...(view.cut ? [view.cut] : [])], buttons };
}

// The groups of the toolbar take the class of their stylesheet.
const DIRECTION_LOOK = { className: 'direction' } as const;

export interface ToolbarChoices {
  readonly show: DependenciesShow;
  readonly reach: GraphReach;
  readonly direction: Direction;
  readonly depth: number;
  readonly text: string;
}

/**
 * The controls: List or Graph, then the filter of the lake, or the direction, the depth and what the graph of an object
 * holds. `listOnly` and `graphOnly` are hidden in the other view: the graph of an object shows both directions.
 */
export function toolbarChildren(
  current: DependenciesData,
  choices: ToolbarChoices,
  onChange: (change: Partial<ToolbarChoices>) => void,
): {
  readonly children: HTMLElement[];
  readonly listOnly: HTMLElement[];
  readonly graphOnly: HTMLElement[];
} {
  const shows = modeGroup(
    'Show as',
    [
      { value: 'list' as const, text: 'List' },
      { value: 'graph' as const, text: 'Graph' },
    ],
    choices.show,
    (show) => onChange({ show }),
    DIRECTION_LOOK,
  );
  if (current.target === null) {
    const search = searchBox('Object', choices.text, (text) => onChange({ text }));
    return { children: [shows, search], listOnly: [search], graphOnly: [] };
  }
  const reaches = modeGroup(
    'Objects in the graph',
    [
      { value: 'connected' as const, text: 'Connected' },
      { value: 'all' as const, text: 'Show all' },
    ],
    choices.reach,
    (reach) => onChange({ reach }),
    DIRECTION_LOOK,
  );
  const directions = modeGroup(
    'Direction',
    DIRECTIONS.map((value) => ({ value, text: DIRECTION_LABEL[value] })),
    choices.direction,
    (direction) => onChange({ direction }),
    DIRECTION_LOOK,
  );
  return {
    children: [
      shows,
      directions,
      modeGroup(
        'Depth',
        DEPTHS.map((value) => ({ value, text: `Depth ${value}` })),
        choices.depth,
        (depth) => onChange({ depth }),
        DIRECTION_LOOK,
      ),
      reaches,
    ],
    listOnly: [directions],
    graphOnly: [reaches],
  };
}
