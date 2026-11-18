/// <reference lib="dom" />
// The tiles of the Templates page: a centred block of four columns of one width (fewer on a narrow panel, as the
// stylesheet says), with a heading or the count of a search above it. Also the buttons of a template and its tags,
// which the lists of Browse and Recently created show too, the buttons as icons. All template text is written as text
// (`textContent`), never as markup.
import { actionButton, empty, note } from '../shell/blocks';
import { el } from '../shell/dom';
import { shortUtcMinutes } from '../shell/model';
import { count, groupedPlural } from '../shell/numbers';
import { iconButton } from '../shell/svg-icon';
import { TEMPLATE_ICONS } from './icons';
import type { TemplateItemAction } from './icons';
import type { TemplateActionId } from './protocol';
import { isEditable, MAX_RESULTS, searchTemplates, SOURCE_LABEL, templateRows } from './search';
import type { TemplateCard } from './search';

/** A time of the page (milliseconds since 1970) in UTC to the minute; empty for none or one that is no date. */
function timeText(time: number | null): string {
  const date = time === null ? undefined : new Date(time);
  return date && Number.isFinite(date.getTime()) ? shortUtcMinutes(date.toISOString()) : '';
}

const usedText = ({ uses, lastUsed }: TemplateCard): string => {
  const last = timeText(lastUsed);
  return `Used ${uses === 1 ? 'once' : `${count(uses)} times`}${last === '' ? '' : `, last ${last} UTC`}`;
};

/** The name of each action on a template, and what it does. */
const ACTIONS: Readonly<
  Record<TemplateItemAction, { readonly label: string; readonly description: string }>
> = {
  use: { label: 'Use', description: 'Open it in a new query of a connection' },
  edit: { label: 'Edit', description: 'Open its text in an editor; saving keeps it' },
  export: { label: 'Export...', description: 'Save it as a .sql file' },
  delete: { label: 'Delete', description: 'Delete it after a question' },
  copy: { label: 'Duplicate', description: 'Make a template of your own of it, to edit' },
};

/**
 * The buttons of a template: Use, then Edit, Export and Delete for an own or imported one, else Duplicate. Buttons with
 * their names on a tile; in the lists of Browse and Recently created icon buttons with the name as tooltip.
 */
export function templateButtons(
  template: TemplateCard,
  act: (action: TemplateActionId) => void,
  look: 'text' | 'icon' = 'text',
): HTMLButtonElement[] {
  const actions: readonly TemplateItemAction[] = [
    'use',
    ...(isEditable(template.source) ? (['edit', 'export', 'delete'] as const) : (['copy'] as const)),
  ];
  return actions.map((action) => {
    const { label, description } = ACTIONS[action];
    return look === 'icon'
      ? iconButton(TEMPLATE_ICONS[action], label, label, () => act(action))
      : actionButton(label, () => act(action), description);
  });
}

/** The tags of a template as a list of small labels. */
export function tagList(tags: readonly string[]): HTMLElement {
  const list = el('ul', 'template-tags');
  list.setAttribute('aria-label', 'Tags');
  list.append(...tags.map((tag) => el('li', undefined, tag)));
  return list;
}

function card(template: TemplateCard, act: (action: TemplateActionId, id: string) => void): HTMLElement {
  const box = el('article', 'template-card');
  const head = el('div', 'template-head');
  head.append(
    el('h3', undefined, template.name),
    el('span', 'template-source', SOURCE_LABEL[template.source]),
  );
  box.append(head);
  if (template.file !== undefined) box.title = template.file;
  if (template.description !== '') box.append(el('p', 'template-description', template.description));
  if (template.tags.length > 0) box.append(tagList(template.tags));
  if (template.uses > 0) box.append(el('p', 'template-use', usedText(template)));
  const actions = el('div', 'actions');
  actions.append(...templateButtons(template, (action) => act(action, template.id)));
  box.append(actions);
  return box;
}

/** A block of tiles as wide as the columns of the page, in the middle: what goes above them, the tiles, what follows. */
function block(
  above: readonly HTMLElement[],
  cards: readonly TemplateCard[],
  act: (action: TemplateActionId, id: string) => void,
  below: readonly HTMLElement[] = [],
): HTMLElement {
  const section = el('section', 'template-block');
  const grid = el('div', 'template-grid');
  grid.append(...cards.map((template) => card(template, act)));
  section.append(...above, ...(cards.length > 0 ? [grid] : []), ...below);
  return section;
}

/**
 * The tiles: before anything is typed the rows of the most used and the last used templates (the first built-in ones
 * before any use), each a block with its heading, and below them the list of the templates created last; while typing,
 * the count and the templates that match.
 */
export function tileBlocks(
  templates: readonly TemplateCard[],
  query: string,
  act: (action: TemplateActionId, id: string) => void,
  /** A list of templates with the columns of Browse (`templateList` in browse.ts), for the templates created last. */
  listOf: (cards: readonly TemplateCard[]) => HTMLElement,
): HTMLElement[] {
  if (query.trim() !== '') {
    const found = searchTemplates(templates, query);
    const shown = found.slice(0, MAX_RESULTS);
    const status = el(
      'p',
      'templates-count',
      found.length === 0
        ? `No template matches "${query.trim()}".`
        : `${groupedPlural(found.length, 'template')} ${found.length === 1 ? 'matches' : 'match'}.`,
    );
    status.setAttribute('role', 'status');
    const more =
      found.length > shown.length
        ? [note(`The first ${shown.length} are shown. Add a word to the search to find the others.`)]
        : [];
    return [block([status], shown, act, more)];
  }
  const { mostUsed, recent, newest, start } = templateRows(templates);
  const blocks = [
    ['Most used', mostUsed],
    ['Recently used', recent],
    ['Start with a template of aantje', start],
  ] as const;
  const shown = [
    ...blocks
      .filter(([, cards]) => cards.length > 0)
      .map(([heading, cards]) => block([el('h2', undefined, heading)], cards, act)),
    // Below the tiles, the templates created last as a list in the block of the tiles, not wider than its columns.
    ...(newest.length > 0 ? [block([el('h2', undefined, 'Recently created'), listOf(newest)], [], act)] : []),
  ];
  return shown.length > 0 ? shown : [block([empty('There is no template yet.')], [], act)];
}
