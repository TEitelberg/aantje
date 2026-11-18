/// <reference lib="dom" />
// The Templates page: the logo and a search field in the middle, as on the start page of a search engine, and the
// tiles of the templates below (`tiles.ts`). Before anything is typed it shows the most used and the last used
// templates; while typing, the templates that match. Browse lists every template instead, with filters and pages
// (`browse.ts`); Tiles goes back. All template text is written as text (`textContent`), never as markup.
import { isObject, own } from '../guards';
import { actionButton, modeGroup, note } from '../shell/blocks';
import { el } from '../shell/dom';
import type { PageKind } from '../shell/page';
import { browseView, templateList } from './browse';
import type { BrowseState } from './browse';
import { isTemplatesMessage } from './protocol';
import type { TemplateActionId } from './protocol';
import { TEMPLATE_SOURCES } from './search';
import type { TemplatesData } from './search';
import { tileBlocks } from './tiles';

type View = 'tiles' | 'browse';

/** What the page keeps while VS Code takes a hidden panel down: the search, the view, and the state of Browse. */
interface Kept extends BrowseState {
  readonly query: string;
  readonly view: View;
}

function keptOf(state: unknown): Kept {
  const field = (name: string): unknown => (isObject(state) ? own(state, name) : undefined);
  const text = (name: string): string | undefined => {
    const value = field(name);
    return typeof value === 'string' ? value : undefined;
  };
  const page = field('page');
  const source = field('source');
  return {
    query: text('query') ?? '',
    view: field('view') === 'browse' ? 'browse' : 'tiles',
    text: text('text') ?? '',
    page: typeof page === 'number' && Number.isInteger(page) && page >= 0 ? page : 0,
    tag: text('tag'),
    source: TEMPLATE_SOURCES.find((known) => known === source),
    selected: text('selected'),
  };
}

export const templatesPage: PageKind<TemplatesData> = {
  type: 'templates',
  isMessage: isTemplatesMessage,
  create(context) {
    let data: TemplatesData | undefined;
    let kept = keptOf(context.state.get());
    const keep = (next: Partial<Kept>): void => {
      kept = { ...kept, ...next };
      context.state.set(kept);
    };
    const post = (action: TemplateActionId, id?: string): void =>
      context.post({ type: 'action', action, ...(id === undefined ? {} : { id }) });

    const logo = el('img', 'templates-logo');
    logo.alt = 'aantje';
    const search = el('input', 'templates-search');
    search.type = 'search';
    search.value = kept.query;
    search.placeholder = 'Search the templates: name, description, tag or SQL';
    search.setAttribute('aria-label', 'Search the templates');
    // The search field serves both views: the tiles, and the list of Browse, which goes back to its first page.
    const searchFor = (text: string): void => {
      keep({ query: text, page: 0 });
      draw();
    };
    search.addEventListener('input', () => searchFor(search.value));
    // Escape empties the search and brings the rows back.
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && search.value !== '') {
        event.preventDefault();
        search.value = '';
        searchFor('');
      }
    });
    const views = modeGroup<View>(
      'View',
      [
        { value: 'tiles', text: 'Tiles' },
        { value: 'browse', text: 'Browse' },
      ],
      kept.view,
      (view) => {
        keep({ view });
        draw();
      },
      { className: 'templates-views' },
    );
    const tools = el('div', 'templates-tools actions');
    tools.append(
      views,
      actionButton('Import...', () => post('import'), 'Import template files (.sql) or a bundle (.json)'),
      actionButton(
        'Download example',
        () => post('example'),
        'Save an example template with every field of the header explained',
      ),
    );
    const top = el('header', 'templates-top');
    top.append(logo, el('h1', 'visually-hidden', 'Templates'), search, tools);
    const notes = el('div', 'templates-notes');
    const main = el('main');
    let mounted = false;

    function draw(): void {
      if (!data) return;
      main.replaceChildren(
        ...(kept.view === 'browse'
          ? browseView(data.templates, kept, kept.query, { act: post, keep })
          : tileBlocks(data.templates, kept.query, post, (cards) => templateList(cards, post))),
      );
    }

    return {
      // New data (a use, an import, a saved template) draws the view again; the search field keeps its text and focus,
      // Browse its filters, page and pick.
      show(next) {
        data = next;
        logo.src = next.logo;
        notes.replaceChildren(...next.notes.map((text) => note(text, 'warning')));
        draw();
        if (!mounted) {
          mounted = true;
          context.app.replaceChildren(top, notes, main);
          if (kept.view === 'tiles') search.focus();
        }
      },
      // Nothing on the page depends on the theme; the stylesheet fits the tiles to the width of the window.
      redraw: () => undefined,
      resize: () => undefined,
    };
  },
};
