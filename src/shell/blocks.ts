/// <reference lib="dom" />
// Building blocks of the report pages: they only build DOM and wire events.
import { el } from './dom';
import { whoText } from './model';
import type { Card, Severity } from './model';
import type { PageContext } from './page';

export const note = (text: string, severity: Severity = 'ok'): HTMLElement =>
  el('p', severity === 'ok' ? 'note' : 'note warning', text);

export const empty = (text: string): HTMLElement => el('p', 'empty', text);

/** A section that is rebuilt when the selection changes; it takes the focus that a button in it loses. */
export function focusPane(className: string): HTMLElement {
  const pane = el('section', className);
  pane.tabIndex = -1;
  return pane;
}

/** A secondary button; `description` is the hover text and the screen reader suffix after the label. */
export function actionButton(label: string, onClick: () => void, description?: string): HTMLButtonElement {
  const button = el('button', 'action', label);
  if (description) {
    button.setAttribute('aria-label', `${label}: ${description}`);
    button.title = description;
  }
  button.addEventListener('click', onClick);
  return button;
}

/** A select with a choice for everything plus one per entry; `current` is undefined for everything. */
export function choiceSelect(
  label: string,
  allText: string,
  entries: readonly { readonly key: string; readonly label: string }[],
  current: string | undefined,
  onChange: (key: string | undefined) => void,
): { readonly element: HTMLLabelElement; readonly show: (key: string | undefined) => void } {
  // Entry values start with `k:`, so no key can be taken for the choice for everything.
  const all = 'all';
  const valueOf = (key: string | undefined): string => (key === undefined ? all : `k:${key}`);
  const wrapper = el('label', 'choice');
  const control = el('select');
  for (const { value, text } of [
    { value: all, text: allText },
    ...entries.map((entry) => ({ value: valueOf(entry.key), text: entry.label })),
  ]) {
    const option = el('option', undefined, text);
    option.value = value;
    control.append(option);
  }
  control.value = valueOf(current);
  control.addEventListener('change', () =>
    onChange(control.value === all ? undefined : control.value.slice(2)),
  );
  wrapper.append(`${label} `, control);
  return {
    element: wrapper,
    show: (key) => {
      control.value = valueOf(key);
    },
  };
}

interface HeaderSpec {
  readonly title: string;
  readonly subtitle: string;
  /** Adds Refresh; the text is the screen reader description. */
  readonly refresh?: string;
  /** The user's choices on the page, sent with Open as Markdown. */
  readonly view?: () => unknown;
  /** Buttons before Refresh and Open as Markdown. */
  readonly actions?: readonly HTMLElement[];
}

export interface Header {
  readonly element: HTMLElement;
  /** Call after the page is built: refocuses Refresh if it asked for the data. */
  settle(): void;
}

/** Title, one-line summary, and the Refresh (if the report can be re-read) and Open as Markdown buttons. */
export function pageHeader(context: PageContext, spec: HeaderSpec): Header {
  const actions = el('div', 'actions');
  actions.append(...(spec.actions ?? []));
  let refresh: HTMLButtonElement | undefined;
  if (spec.refresh !== undefined) {
    refresh = actionButton(
      'Refresh',
      () => {
        context.refreshAsked = true;
        context.post({ type: 'refresh' });
      },
      spec.refresh,
    );
    actions.append(refresh);
  }
  actions.append(
    actionButton(
      'Open as Markdown',
      () => {
        const view = spec.view?.();
        context.post(view === undefined ? { type: 'markdown' } : { type: 'markdown', view });
      },
      'Open this report as a Markdown document',
    ),
  );
  const element = el('header');
  element.append(el('h1', undefined, spec.title), el('p', 'subtitle', spec.subtitle), actions);
  return {
    element,
    settle() {
      if (context.refreshAsked) {
        refresh?.focus();
        context.refreshAsked = false;
      }
    },
  };
}

/** Key figures; a severity colours the border. `columns` fixes the column count, else as many as fit. */
export function cardGrid(
  cards: readonly Card[],
  colorOf: (severity: Severity) => string,
  columns?: 4,
): HTMLElement {
  const grid = el('div', columns === undefined ? 'cards' : `cards cards-${columns}`);
  for (const card of cards) {
    const box = el('div', card.severity === 'ok' ? 'card' : `card ${card.severity}`);
    box.title = card.hint ?? '';
    if (card.severity !== 'ok') {
      // The stylesheet cannot know the palette (it has its own contrast check); the sign after the figure is the text marker.
      box.style.borderColor = colorOf(card.severity);
    }
    box.append(el('div', 'card-label', card.label), el('div', 'card-value', card.value));
    if (card.detail) {
      box.append(el('div', 'card-detail', card.detail));
    }
    grid.append(box);
  }
  return grid;
}

/** The tab that a key moves to in a bar of `count` tabs: the arrows wrap around, Home and End go to the ends. */
export function tabAfterKey(key: string, index: number, count: number): number | undefined {
  if (count === 0) return undefined;
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}

/** Tabs per the WAI-ARIA pattern: only the selected tab is in the tab order; the keys of `tabAfterKey` move. */
export function tabBar<Id extends string>(
  tabs: readonly { readonly id: Id; readonly label: string }[],
  selected: Id,
  select: (id: Id, refocus: boolean) => void,
): HTMLElement {
  const bar = el('div', 'tabs');
  bar.setAttribute('role', 'tablist');
  for (const { id, label } of tabs) {
    const button = el('button', 'tab', label);
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(id === selected));
    button.tabIndex = id === selected ? 0 : -1;
    button.addEventListener('click', () => select(id, false));
    button.addEventListener('keydown', (event) => {
      const target = tabAfterKey(
        event.key,
        tabs.findIndex((candidate) => candidate.id === id),
        tabs.length,
      );
      const next = target === undefined ? undefined : tabs[target];
      if (next) {
        event.preventDefault();
        select(next.id, true);
      }
    });
    bar.append(button);
  }
  return bar;
}

export function toolbar(...controls: readonly (HTMLElement | string)[]): HTMLElement {
  const bar = el('div', 'toolbar');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Filters');
  bar.append(...controls);
  return bar;
}

export function searchBox(label: string, value: string, onInput: (text: string) => void): HTMLLabelElement {
  const wrapper = el('label', 'search');
  const input = el('input');
  input.type = 'search';
  input.value = value;
  input.addEventListener('input', () => onInput(input.value));
  wrapper.append(`${label} `, input);
  return wrapper;
}

/** The set with the members added (`on`) or removed; the set itself stays as it was. */
export function withMembers<T>(set: ReadonlySet<T>, members: readonly T[], on: boolean): Set<T> {
  const next = new Set(set);
  for (const member of members) {
    if (on) {
      next.add(member);
    } else {
      next.delete(member);
    }
  }
  return next;
}

/** A checkbox; `apply` gets its new state. */
function checkbox(text: string, checked: boolean, apply: (on: boolean) => void): HTMLLabelElement {
  const label = el('label', 'check');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => apply(input.checked));
  label.append(input, text);
  return label;
}

/** A checkbox per kind of change; a change hands a new set of the chosen kinds to `set`. */
export function kindBoxes<Kind extends string>(
  kinds: readonly Kind[],
  label: Readonly<Record<Kind, string>>,
  chosen: () => ReadonlySet<Kind>,
  set: (next: Set<Kind>) => void,
): HTMLElement {
  const box = el('div', 'kinds');
  box.append(
    ...kinds.map((kind) =>
      checkbox(label[kind], chosen().has(kind), (on) => set(withMembers(chosen(), [kind], on))),
    ),
  );
  return box;
}

/** A number field for one end of a snapshot range, clamped to `first`..`last`; non-numbers keep `current`. */
export function rangeField(
  label: string,
  first: number,
  last: number,
  current: () => number,
  set: (next: number) => void,
): HTMLLabelElement {
  const wrapper = el('label', 'range');
  const input = el('input');
  input.type = 'number';
  input.min = String(first);
  input.max = String(last);
  input.value = String(current());
  input.addEventListener('change', () => {
    // An emptied field and a non-numeric one both hold ''; Number('') would be 0.
    const parsed = input.value.trim() === '' ? Number.NaN : Number(input.value);
    const next = Number.isInteger(parsed) ? Math.min(Math.max(parsed, first), last) : current();
    input.value = String(next);
    set(next);
  });
  wrapper.append(`${label} @`, input);
  return wrapper;
}

/** The From and To fields of a snapshot range, clamped to `first`..`last`. */
export function rangeFields(
  first: number,
  last: number,
  current: (end: 'from' | 'to') => number,
  set: (end: 'from' | 'to', next: number) => void,
): HTMLLabelElement[] {
  return (['from', 'to'] as const).map((end) =>
    rangeField(
      end === 'from' ? 'From' : 'To',
      first,
      last,
      () => current(end),
      (next) => set(end, next),
    ),
  );
}

/**
 * A group of buttons of which one is pressed. `label` names the group for assistive technology; `shown` also writes it
 * in front of the buttons, where it is hidden from assistive technology so that it is not read twice.
 */
export function modeGroup<T extends string | number>(
  label: string,
  options: readonly { readonly value: T; readonly text: string }[],
  current: T,
  pick: (value: T) => void,
  look: { readonly className?: string; readonly shown?: boolean } = {},
): HTMLElement {
  const group = el('div', look.className);
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);
  if (look.shown) {
    const visible = el('span', undefined, `${label}: `);
    visible.setAttribute('aria-hidden', 'true');
    group.append(visible);
  }
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

/** The author and message of a snapshot as one line; nothing when it has neither. */
export function whoLine(author: string | null, message: string | null): HTMLElement[] {
  const text = whoText(author, message);
  return text === '' ? [] : [el('p', 'who-line', text)];
}

/** A row of a list that one picks from, and the button in its first cell. */
export interface ListRow {
  readonly row: HTMLElement;
  readonly pick: HTMLElement;
}

/** The first cell of a row: a button that picks the row; `label` is its screen reader text. */
export function pickCell(
  text: string,
  label: string,
  onPick: (event: MouseEvent) => void,
): { readonly cell: HTMLTableCellElement; readonly pick: HTMLButtonElement } {
  const pick = el('button', 'pick', text);
  pick.setAttribute('aria-label', label);
  pick.addEventListener('click', onPick);
  const cell = el('td');
  cell.append(pick);
  return { cell, pick };
}

/** Marks the row of `selected` (and the one of `other` with its own class) and presses the button of the selected. */
export function markPicked(
  rows: ReadonlyMap<number, ListRow>,
  selected: number | undefined,
  other?: number,
): void {
  for (const [id, { row, pick }] of rows) {
    row.className = [id === selected ? 'selected' : '', id === other ? 'other' : '']
      .filter(Boolean)
      .join(' ');
    pick.setAttribute('aria-pressed', String(id === selected));
  }
}

export function tableRow(cells: readonly (string | HTMLElement)[]): HTMLTableRowElement {
  const row = el('tr');
  for (const cell of cells) {
    if (typeof cell === 'string') {
      row.append(el('td', undefined, cell));
    } else {
      row.append(cell);
    }
  }
  return row;
}

/** Wraps a table in a sideways-scrolling box, so a wide table scrolls inside the gutter, not the page. */
export function scrollable(table: HTMLTableElement): HTMLElement {
  const box = el('div', 'table-scroll');
  box.append(table);
  return box;
}

/** A table with a heading row; a heading is text or a cell (a sortable column). */
export function dataTable(
  headings: readonly (string | HTMLTableCellElement)[],
  rows: readonly HTMLTableRowElement[],
): HTMLElement {
  const head = el('tr');
  for (const heading of headings) {
    head.append(typeof heading === 'string' ? el('th', undefined, heading) : heading);
  }
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  tbody.append(...rows);
  const table = el('table');
  table.append(thead, tbody);
  return scrollable(table);
}

/** Says that a list is partial and how to get the rest. */
export function truncation(shown: number, total: number, noun: string, advice: string): HTMLElement {
  return note(`${shown} of ${total} ${noun} are shown. ${advice}`);
}

interface FindingSpec {
  readonly severity: Severity;
  readonly title: string;
  readonly body: readonly string[];
  readonly actions?: readonly HTMLElement[];
  readonly open?: boolean;
}

/** An expandable card: the title and a warning or error sign stay visible; details and actions open with it. */
export function findingCard(spec: FindingSpec): HTMLElement {
  const card = el('details', spec.severity === 'ok' ? 'finding' : `finding ${spec.severity}`);
  card.open = spec.open ?? false;
  const body = el('div', 'finding-body');
  body.append(...spec.body.map((text) => el('p', undefined, text)));
  if (spec.actions && spec.actions.length > 0) {
    const actions = el('div', 'actions');
    actions.append(...spec.actions);
    body.append(actions);
  }
  card.append(el('summary', undefined, spec.title), body);
  return card;
}

/** A keyboard list: one button per item, only the focused one in the tab order. Arrows, Home and End move; Enter or Space picks. */
export function keyList(
  items: readonly { readonly label: string; readonly selected?: boolean }[],
  pick: (index: number) => void,
): HTMLElement {
  const list = el('ul', 'keylist');
  list.setAttribute('role', 'listbox');
  const buttons = items.map((item, index) => {
    const button = el('button', undefined, item.label);
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(item.selected === true));
    button.tabIndex = index === 0 ? 0 : -1;
    button.addEventListener('click', () => pick(index));
    return button;
  });
  buttons.forEach((button, index) => {
    button.addEventListener('keydown', (event) => {
      const last = buttons.length - 1;
      const target =
        event.key === 'ArrowDown'
          ? Math.min(index + 1, last)
          : event.key === 'ArrowUp'
            ? Math.max(index - 1, 0)
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? last
                : undefined;
      if (target !== undefined) {
        event.preventDefault();
        buttons.forEach((candidate, at) => (candidate.tabIndex = at === target ? 0 : -1));
        buttons[target]?.focus();
      }
    });
    const item = el('li');
    item.setAttribute('role', 'none');
    item.append(button);
    list.append(item);
  });
  return list;
}
