import { SHELL_CSS } from '../shell/style';
import { ICON_BUTTON_CSS } from '../shell/svg-icon';

/** The widths of the window below which a row of tiles has three, two and one column (see TEMPLATES_CSS). */
const NARROWER: readonly (readonly [width: number, columns: 1 | 2 | 3])[] = [
  [1208, 3],
  [912, 2],
  [616, 1],
];

/** A column of the lists of Browse and Recently created; its cells have the class `list-<column>` (browse.ts). */
export type ListColumn = 'name' | 'description' | 'tags' | 'source' | 'actions';

type ListWidth = number | 'auto' | null;

/**
 * The width of each column of the lists of Browse and Recently created in pixels, its padding included, when the block
 * of the tiles has four, three, two and one columns: `auto` takes what is left, `null` leaves the column out. A list
 * never scrolls sideways: its layout is fixed, the widths of a row leave room for the `auto` column in the block, and
 * text wraps or is cut with an ellipsis. The actions are four icon buttons of 22 pixels at most.
 */
export const LIST_WIDTHS: Readonly<
  Record<ListColumn, readonly [ListWidth, ListWidth, ListWidth, ListWidth]>
> = {
  name: [230, 200, 160, 'auto'],
  description: ['auto', 'auto', 'auto', null],
  tags: [170, 150, 130, null],
  source: [80, 80, null, null],
  actions: [114, 114, 114, 114],
};

const listRules = (columns: 1 | 2 | 3 | 4): string =>
  Object.entries(LIST_WIDTHS)
    .map(([column, widths]) => {
      const width = widths[4 - columns];
      const rule =
        width === null
          ? 'display: none;'
          : `display: table-cell; width: ${width === 'auto' ? 'auto' : `${width}px`};`;
      return `.templates-list .list-${column} { ${rule} }`;
    })
    .join(' ');

/**
 * The Templates page: the logo and the search field in the middle, as on the start page of a search engine; the tiles
 * below in a centred block of four columns of one width, `--template-tile`. A row has as many columns as fit beside
 * the gutters: N columns need N tiles, N - 1 section gaps and two gutters, so four need 4 x 280 + 3 x 16 + 2 x 20 =
 * 1208 pixels, three 912 and two 616; below that a row has one column less. Fewer tiles than columns start at the left
 * of the block, and so does its heading. Browse: the filters on one line (the box and the pages of the shell's paged
 * table with the tag and the source between them, wrapping in a narrow block) above its list. The lists of Browse and
 * Recently created: as wide as the block, with fewer columns in a narrower one (`LIST_WIDTHS`), the description cut
 * to two lines, and icon buttons.
 */
export const TEMPLATES_CSS = `${SHELL_CSS}
${ICON_BUTTON_CSS}
.templates-top { display: flex; flex-direction: column; align-items: center; gap: var(--aantje-control-gap); margin: var(--aantje-section-gap) 0; }
.templates-logo { width: 96px; height: 96px; margin-bottom: var(--aantje-section-gap); object-fit: contain; }
body.vscode-dark .templates-logo, body.vscode-high-contrast .templates-logo { padding: 12px; background: #ffffff; border-radius: 50%; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.templates-search { box-sizing: border-box; width: min(640px, 100%); padding: 8px 16px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 20px; font: inherit; font-size: 1.15em; }
.templates-search:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.templates-tools { display: flex; flex-wrap: wrap; justify-content: center; }
.templates-views { display: flex; margin-right: var(--aantje-section-gap); }
.templates-notes:not(:empty) { margin-bottom: var(--aantje-section-gap); }
:root { --template-tile: 280px; --template-columns: 4; }
${NARROWER.map(([width, columns]) => `@media (width < ${width}px) { :root { --template-columns: ${columns}; } }`).join('\n')}
.template-block { width: min(100%, calc(var(--template-columns) * var(--template-tile) + (var(--template-columns) - 1) * var(--aantje-section-gap))); margin: 0 auto; }
main > .template-block:first-child > h2:first-child { margin-top: 0; }
.templates-count { margin: 0 0 var(--aantje-control-gap); color: var(--vscode-descriptionForeground); }
.template-grid { display: grid; grid-template-columns: repeat(var(--template-columns), minmax(0, 1fr)); gap: var(--aantje-section-gap); margin-bottom: var(--aantje-section-gap); }
.template-card { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: var(--aantje-card-padding); background: var(--vscode-editorWidget-background, transparent); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-radius: 4px; }
.template-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--aantje-control-gap); }
.template-card h3 { margin: 0; font-size: 1em; font-weight: 600; overflow-wrap: anywhere; }
.template-source { flex: none; padding: 0 6px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); border-radius: 8px; font-size: 0.85em; }
.template-description, .template-use { margin: 0; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
.template-use { font-size: 0.9em; }
.template-tags { display: flex; flex-wrap: wrap; gap: 4px; margin: 0; padding: 0; list-style: none; }
.template-tags li { padding: 0 6px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; font-size: 0.85em; }
.template-card .actions { margin-top: auto; }
/* Browse is filtered by the search field of the page, not by the filter box of its table. */
.template-browse .templates-filters .search { display: none; }
.templates-filters .templates-slot, .templates-filters .paged-controls { display: contents; }
.templates-filters .pager { order: 1; }
.templates-filters select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); font: inherit; max-width: 16em; }
.templates-list table { table-layout: fixed; }
.templates-list th, .templates-list td { box-sizing: border-box; overflow: hidden; text-overflow: ellipsis; }
.templates-list th, .templates-list td.list-name, .templates-list td.list-description, .templates-list td.list-tags { white-space: normal; overflow-wrap: anywhere; }
.templates-list button.pick { text-align: left; }
.template-clamp { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; color: var(--vscode-descriptionForeground); }
.templates-list .template-tags li { max-width: 100%; box-sizing: border-box; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.templates-list .actions { flex-wrap: nowrap; gap: 2px; }
.templates-list tr.selected .template-clamp, .templates-list tr.selected button.icon { color: inherit; }
.templates-list tr.selected .template-tags li { border-color: currentColor; }
${listRules(4)}
${NARROWER.map(([width, columns]) => `@media (width < ${width}px) { ${listRules(columns)} }`).join('\n')}
body.vscode-high-contrast .template-card, body.vscode-high-contrast-light .template-card { border-color: var(--vscode-contrastBorder); }
`;
