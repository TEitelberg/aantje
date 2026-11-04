/// <reference lib="dom" />
// DOM builders of the Dependencies page. They take the state they show and report user input through callbacks.
import { actionButton, dataTable, empty, keyList, note, tableRow, truncation } from '../shell/blocks';
import { el } from '../shell/dom';
import {
  BROKEN_KIND,
  DEPENDENCIES_KIND_LABEL,
  DIRECTION_LABEL,
  KIND_SIGN,
  MAX_ISSUES,
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
import type { DependenciesActionId } from './protocol';

const DETAIL_NAMES = 30;

type Ask = (action: DependenciesActionId, node: number) => void;

function actionsFor(current: DependenciesData, node: number, ask: Ask): HTMLElement {
  const found = current.nodes[node];
  const name = nameAt(current, node);
  const actions = el('div', 'actions');
  actions.append(
    actionButton('Show in tree', () => ask('showInTree', node), `Show ${name} in the tree`),
    ...(found?.kind === 'table'
      ? [actionButton('Statistics', () => ask('showStatistics', node), `Show the statistics of ${name}`)]
      : []),
    ...(node === current.target
      ? []
      : [
          actionButton(
            'Dependencies',
            () => ask('showDependencies', node),
            `Show the dependencies of ${name}`,
          ),
        ]),
    actionButton('Script as CREATE', () => ask('scriptCreate', node), `Open the CREATE script of ${name}`),
    actionButton('Script as ALTER', () => ask('scriptAlter', node), `Open the ALTER script of ${name}`),
    actionButton(
      'Script as DROP',
      () => ask('scriptDrop', node),
      `Open the DROP script of ${name}; nothing runs`,
    ),
  );
  return actions;
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

export function detailChildren(
  data: DependenciesData | undefined,
  selected: number | undefined,
  ask: Ask,
): HTMLElement[] {
  const node = selected === undefined ? undefined : data?.nodes[selected];
  if (!data || selected === undefined || !node) {
    return [note('Select an object in the list to see what you can do with it.')];
  }
  return [
    el(
      'h2',
      undefined,
      `${KIND_SIGN[node.kind]} ${nameAt(data, selected)} · ${DEPENDENCIES_KIND_LABEL[node.kind]}`,
    ),
    actionsFor(data, selected, ask),
    ...(data.target === null
      ? [...neighbours(data, selected, 'usedBy'), ...neighbours(data, selected, 'dependsOn')]
      : []),
  ];
}

export function issuesChildren(current: DependenciesData, shown?: ReadonlySet<number>): HTMLElement[] {
  const { broken, unresolved } = issuesOf(current, shown);
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
      ? note('No object listed here names something that the lake does not have.')
      : dataTable(['Object', 'Names', 'As'], brokenRows),
    ...(broken.length > MAX_ISSUES ? [truncation(MAX_ISSUES, broken.length, 'broken references', '')] : []),
    el('h2', undefined, 'Not followed'),
    unresolved.length === 0
      ? note('Every text of the objects listed here was read.')
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
  /** The objects that the issues cover; undefined for the lake report. */
  readonly shown: ReadonlySet<number> | undefined;
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
    shown: undefined,
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
    shown: new Set([target, ...traversal.rows.map(({ node }) => node)]),
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

/** A group of buttons of which one is pressed, for the direction and the depth. */
export function choice<T extends string | number>(
  label: string,
  options: readonly { readonly value: T; readonly text: string }[],
  current: T,
  pick: (value: T) => void,
): HTMLElement {
  const group = el('div', 'direction');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  const pressed: { readonly value: T; readonly button: HTMLElement }[] = [];
  for (const option of options) {
    const button = el('button', 'mode', option.text);
    button.setAttribute('aria-pressed', String(option.value === current));
    button.addEventListener('click', () => {
      for (const other of pressed) {
        other.button.setAttribute('aria-pressed', String(other.value === option.value));
      }
      pick(option.value);
    });
    pressed.push({ value: option.value, button });
    group.append(button);
  }
  return group;
}

export function impactSection(current: DependenciesData, target: number, ask: Ask): HTMLElement {
  const impact = dropImpact(current, target);
  const section = el('section', impact.objects.length > 0 ? 'impact warning' : 'impact');
  section.append(
    el('h2', undefined, `If you drop ${nameAt(current, target)}`),
    el(
      'p',
      undefined,
      `${impact.objects.length > 0 ? '⚠ ' : ''}${impactText(nameAt(current, target), impact)}`,
    ),
  );
  if (impact.objects.length > 0) {
    const names = el('ul');
    names.append(...impact.names.map((name) => el('li', undefined, name)));
    section.append(names, ...(impact.more > 0 ? [note(`… and ${impact.more} more`)] : []));
  }
  const actions = el('div', 'actions');
  actions.append(
    actionButton(
      'Open Script as DROP',
      () => ask('scriptDrop', target),
      `Open the DROP script of ${nameAt(current, target)} in a SQL document; nothing runs`,
    ),
  );
  section.append(actions);
  return section;
}
