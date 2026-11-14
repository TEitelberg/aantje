/** Spacing of every page and its container `.app`, which the page script creates, so no page forgets the gutter. */
export const LAYOUT_CSS = `
:root { --aantje-gutter: 20px; --aantje-section-gap: 16px; --aantje-card-padding: 10px 12px; --aantje-control-gap: 8px; }
html, body { height: 100%; margin: 0; padding: 0; }
body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.app { box-sizing: border-box; display: flex; flex-direction: column; min-height: 100%; padding: var(--aantje-gutter); }
.app > * { min-width: 0; }
.stale-note { margin: 0 0 var(--aantje-section-gap); padding: 6px 10px; border-left: 4px solid var(--vscode-editorWarning-foreground); background: var(--vscode-editorWidget-background); }
`;

/**
 * The stylesheet every report shares; reports add rules, the page inlines it with the CSP nonce.
 * A heading carries its own gap above it. The margin of a heading starting a plain `section` or `div` collapses
 * through the wrapper, keeping the gap to the previous block. A box with a border or padding that starts with a
 * heading sets that heading's margin itself.
 */
export const SHELL_CSS = `${LAYOUT_CSS}
header { margin: 0 0 var(--aantje-section-gap); }
h1 { margin: 0; font-size: 1.4em; font-weight: 600; }
.subtitle { margin: 2px 0 var(--aantje-control-gap); color: var(--vscode-descriptionForeground); }
.tabs { display: flex; flex-wrap: wrap; margin: 0 0 var(--aantje-section-gap); border-bottom: 1px solid var(--vscode-panel-border); }
.tab { padding: 6px 14px; color: var(--vscode-tab-inactiveForeground); background: none; border: 0; border-bottom: 2px solid transparent; font: inherit; cursor: pointer; }
.tab:hover { color: var(--vscode-tab-activeForeground); }
.tab[aria-selected="true"] { color: var(--vscode-tab-activeForeground); border-bottom-color: var(--vscode-focusBorder); }
.tab:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
main { flex: 1; }
h2 { margin: var(--aantje-section-gap) 0 var(--aantje-control-gap); font-size: 1.1em; font-weight: 600; }
main > h2:first-child { margin-top: 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: var(--aantje-section-gap); margin-bottom: var(--aantje-section-gap); }
.cards.cards-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
@media (max-width: 760px) { .cards.cards-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.card { padding: var(--aantje-card-padding); background: var(--vscode-editorWidget-background, transparent); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-radius: 4px; }
.card.warning, .card.error { border-left-width: 4px; }
.card-label { color: var(--vscode-descriptionForeground); }
.card-value { margin: 2px 0; font-size: 1.7em; font-weight: 600; overflow-wrap: anywhere; }
.card.warning .card-value::after { content: " \\26A0"; font-size: 0.6em; }
.card.error .card-value::after { content: " \\2716"; font-size: 0.6em; }
.card-detail { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
.chart { width: 100%; height: 320px; }
.empty { padding: 24px 0; color: var(--vscode-descriptionForeground); }
.note { margin: var(--aantje-control-gap) 0 0; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
.note.warning { color: var(--vscode-editorWarning-foreground); }
.table-scroll { max-width: 100%; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 4px 10px; text-align: left; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
th { color: var(--vscode-descriptionForeground); font-weight: normal; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--aantje-control-gap) var(--aantje-section-gap); margin-bottom: var(--aantje-control-gap); }
.toolbar label, .toolbar .axis { display: inline-flex; align-items: center; gap: 4px; }
.toolbar input[type="number"], .toolbar input[type="search"] { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); font: inherit; }
.toolbar input[type="number"] { width: 6em; }
.toolbar input[type="search"] { width: 20em; max-width: 100%; }
button.action, button.mode, button.pick { margin: 2px 4px 2px 0; padding: 2px 8px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-contrastBorder, transparent); font: inherit; cursor: pointer; }
button.action:hover, button.mode:hover, button.pick:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.mode[aria-pressed="true"], button.pick[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button.action:focus-visible, button.mode:focus-visible, button.pick:focus-visible, .filter summary:focus-visible, .finding summary:focus-visible, .keylist button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.actions { display: flex; flex-wrap: wrap; align-items: center; }
.kinds { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.keylist { margin: 0; padding: 0; list-style: none; }
.keylist button { display: block; width: 100%; padding: 4px 8px; text-align: left; color: inherit; background: none; border: 0; border-bottom: 1px solid var(--vscode-panel-border); font: inherit; cursor: pointer; }
.keylist button:hover { background: var(--vscode-list-hoverBackground); }
.keylist button[aria-selected="true"] { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
.finding { margin: var(--aantje-control-gap) 0; border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-radius: 4px; }
.finding.warning, .finding.error { border-left-width: 4px; }
.finding summary { padding: 6px 10px; cursor: pointer; font-weight: 600; }
.finding.warning summary::before { content: "\\26A0 "; }
.finding.error summary::before { content: "\\2716 "; }
.finding-body { padding: 0 10px 8px; }
.finding-body p { margin: 4px 0; }
body.vscode-high-contrast .card, body.vscode-high-contrast-light .card, body.vscode-high-contrast .finding, body.vscode-high-contrast-light .finding { border-color: var(--vscode-contrastBorder); }
body.vscode-high-contrast .tabs, body.vscode-high-contrast-light .tabs, body.vscode-high-contrast th, body.vscode-high-contrast-light th, body.vscode-high-contrast td, body.vscode-high-contrast-light td { border-bottom-color: var(--vscode-contrastBorder); }
`;

/** The toolbar and the list of the reports of snapshots by time (Snapshot Report, Activity, Growth). */
export const LIST_CSS = `
.toolbar select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); font: inherit; max-width: 20em; }
td.who { white-space: normal; max-width: 30em; }
td.number { text-align: right; }
.list { margin-top: var(--aantje-section-gap); }
.list tr.selected td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
`;

/** The pane of the selected snapshot (Snapshot Report, Activity, Growth, Schema History). */
export const DETAIL_CSS = `
.detail { margin-top: var(--aantje-section-gap); }
.detail:focus { outline: none; }
.detail h3 { margin: 12px 0 4px; font-size: 1em; }
.who-line { white-space: pre-wrap; }
.label { margin: 0 4px; color: var(--vscode-descriptionForeground); }
.tables, .others { margin: 0; padding: 0; list-style: none; }
.table-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.table-row .name { font-family: var(--vscode-editor-font-family); font-weight: 600; }
.table-row .what { color: var(--vscode-descriptionForeground); }
`;
