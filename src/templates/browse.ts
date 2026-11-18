/// <reference lib="dom" />
// Browse on the Templates page: every template in a list sorted by name, a page at a time, with a filter box, a tag
// and a source above it; the actions of a template as icon buttons in its row. The list is the shell's `pagedTable`;
// it fits the block of the tiles as the list of Recently created does (style.ts). All template text is written as
// text (`textContent`), never as markup.
import { choiceSelect, dataTable, tableRow } from '../shell/blocks';
import { el } from '../shell/dom';
import { pagedTable } from '../shell/paged-table';
import type { PagedColumn, PagedRow, PagedTable } from '../shell/paged-table';
import type { TemplateActionId } from './protocol';
import { allTags, BROWSE_PAGE_ROWS, browseTemplates, SOURCE_LABEL, sourcesOf } from './search';
import type { TemplateCard, TemplateSource } from './search';
import type { ListColumn } from './style';
import { tagList, templateButtons } from './tiles';

/** What Browse keeps for a hidden panel: the filter box and its page, the tag and the source, the template picked. */
export interface BrowseState {
  readonly text: string;
  readonly page: number;
  readonly tag: string | undefined;
  readonly source: TemplateSource | undefined;
  readonly selected: string | undefined;
}

export interface BrowseHooks {
  /** A button of a row: the action on its template. */
  readonly act: (action: TemplateActionId, id: string) => void;
  /** The state changed, to keep for a hidden panel. */
  readonly keep: (state: BrowseState) => void;
}

const column = (name: ListColumn, label: string): PagedColumn => ({ label, className: `list-${name}` });

/**
 * The columns of Browse and of the list of Recently created; the class `list-<column>` of their cells gives each its
 * width for the width of the block, or leaves it out (style.ts).
 */
const COLUMNS: readonly PagedColumn[] = [
  column('name', 'Name'),
  column('description', 'Description'),
  column('tags', 'Tags'),
  column('source', 'Source'),
  column('actions', 'Actions'),
];

function rowOf(template: TemplateCard, act: (action: TemplateActionId) => void): PagedRow<string> {
  // The description in two lines at most, the whole of it on hover; the file of a folder template on its source.
  const description = el('div', 'template-clamp', template.description);
  if (template.description !== '') description.title = template.description;
  const source = el('span', undefined, SOURCE_LABEL[template.source]);
  source.title = template.file ?? SOURCE_LABEL[template.source];
  const tags = tagList(template.tags);
  tags.title = template.tags.join(', ');
  const actions = el('div', 'actions');
  actions.append(...templateButtons(template, act, 'icon'));
  return {
    key: template.id,
    label: template.name,
    cells: [description, template.tags.length > 0 ? tags : '', source, actions],
    search: [template.description, ...template.tags, SOURCE_LABEL[template.source]].join('\n'),
  };
}

/**
 * A list of templates with the columns and the icon buttons of Browse, without its filters and pages: the templates
 * created last, below the tiles. Like Browse, it fits the block of the tiles; a narrower block shows fewer columns.
 */
export function templateList(
  templates: readonly TemplateCard[],
  act: (action: TemplateActionId, id: string) => void,
): HTMLElement {
  const cell = <K extends 'th' | 'td'>(
    tag: K,
    index: number,
    content: string | HTMLElement,
  ): HTMLElementTagNameMap[K] => {
    const box = el(tag, COLUMNS[index]?.className);
    box.append(content);
    return box;
  };
  const rows = templates.map((template) => {
    const { label, cells } = rowOf(template, (action) => act(action, template.id));
    return tableRow([label, ...cells].map((content, index) => cell('td', index, content)));
  });
  const list = el('div', 'templates-list');
  list.append(
    dataTable(
      COLUMNS.map(({ label }, index) => cell('th', index, label)),
      rows,
    ),
  );
  return list;
}

/**
 * The filters and the list of Browse. The search field of the page (`query`) finds a template as it finds tiles; the
 * tag and the source narrow the list, and a change of any goes back to the first page. A template is picked by its
 * name or by a button of its row, and stays marked. A kept tag or source that no template has any more is dropped.
 */
export function browseView(
  templates: readonly TemplateCard[],
  start: BrowseState,
  query: string,
  hooks: BrowseHooks,
): HTMLElement[] {
  const tags = allTags(templates);
  const sources = sourcesOf(templates);
  let state: BrowseState = {
    text: start.text,
    page: start.page,
    tag: tags.find((tag) => tag.toLowerCase() === start.tag?.toLowerCase()),
    source: sources.find((source) => source === start.source),
    selected: templates.some((template) => template.id === start.selected) ? start.selected : undefined,
  };
  const change = (next: Partial<BrowseState>): void => {
    state = { ...state, ...next };
    hooks.keep(state);
  };

  // The filter box and the pages of the table are rebuilt with it; the choices stay, and so does their focus.
  const controls = el('div', 'templates-slot');
  const list = el('div', 'templates-list');
  let table: PagedTable<string> | undefined;
  const pick = (id: string): void => {
    change({ selected: id });
    table?.mark(id);
  };
  function drawTable(): void {
    table = pagedTable<string>({
      columns: COLUMNS,
      rows: browseTemplates(templates, { ...state, query }).map((template) =>
        rowOf(template, (action) => {
          pick(template.id);
          hooks.act(action, template.id);
        }),
      ),
      pageSize: BROWSE_PAGE_ROWS,
      noun: ['template', 'templates'],
      noMatch: 'No template matches the filters.',
      none: 'There is no template yet.',
      // The search field of the page filters the list; the filter box of the table is hidden (style.ts).
      text: '',
      page: state.page,
      selected: state.selected,
      onSelect: pick,
      onChange: ({ page }) => change({ page }),
    });
    controls.replaceChildren(table.controls);
    list.replaceChildren(table.table);
  }

  const tag = choiceSelect(
    'Tag',
    'All tags',
    tags.map((name) => ({ key: name, label: name })),
    state.tag,
    (key) => {
      change({ tag: key, page: 0 });
      drawTable();
    },
  );
  const source = choiceSelect(
    'Source',
    'All sources',
    sources.map((name) => ({ key: name, label: SOURCE_LABEL[name] })),
    state.source,
    (key) => {
      change({ source: sources.find((name) => name === key), page: 0 });
      drawTable();
    },
  );
  drawTable();
  const filters = el('div', 'toolbar templates-filters');
  filters.append(controls, tag.element, source.element);
  // As wide as the block of the tiles and centred like it, so that the page keeps its width when the view changes.
  const block = el('section', 'template-block template-browse');
  block.append(filters, list);
  return [block];
}
