import { LAYOUT_CSS } from '../shell/style';

/** The only stylesheet of the grid. It is inlined into the page (with the CSP nonce) and uses the theme variables of VS Code. */
export const GRID_CSS = `${LAYOUT_CSS}
.app { height: 100%; }
.toolbar { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.toolbar button, .err button { padding: 2px 10px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; cursor: pointer; font: inherit; }
.toolbar button:hover, .err button:hover { background: var(--vscode-button-secondaryHoverBackground); }
.toolbar button:focus-visible, .err button:focus-visible, .tab:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.status { margin-left: auto; color: var(--vscode-descriptionForeground); }
.scroll { flex: 1; min-height: 0; overflow: auto; scroll-padding-top: 4.5em; }
table { border-collapse: separate; border-spacing: 0; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
th, td { padding: 2px 8px; border-right: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
thead th { position: sticky; top: 0; z-index: 1; padding-top: 4px; text-align: left; font-weight: normal; background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background)); user-select: none; }
thead th button { display: block; width: 100%; padding: 0; color: inherit; background: none; border: 0; font: inherit; text-align: left; cursor: pointer; }
.name { font-weight: bold; }
.type { margin-left: 6px; color: var(--vscode-descriptionForeground); }
.mark { margin-left: 6px; }
thead input { display: block; box-sizing: border-box; width: 100%; min-width: 6em; margin: 4px 0; padding: 1px 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); font: inherit; }
td { max-width: 40em; overflow: hidden; text-overflow: ellipsis; }
td.rn, th.rn { text-align: right; color: var(--vscode-descriptionForeground); }
td.num { text-align: right; }
td.null { color: var(--vscode-descriptionForeground); font-style: italic; opacity: 0.7; }
tbody tr:nth-child(even) { background: color-mix(in srgb, var(--vscode-editor-foreground) 5%, transparent); }
tbody tr:hover { background: var(--vscode-list-hoverBackground); }
td.mk, th.mk { width: 1.5em; padding: 2px 4px; text-align: center; font-weight: bold; }
tbody tr.chg-insert { background: var(--vscode-diffEditor-insertedTextBackground); }
tbody tr.chg-delete { background: var(--vscode-diffEditor-removedTextBackground); }
tbody tr.chg-update-before, tbody tr.chg-update-after { background: color-mix(in srgb, var(--vscode-editor-foreground) 10%, transparent); }
tr.chg-update-before td.changed:not(:focus) { background: var(--vscode-diffEditor-removedTextBackground); }
tr.chg-update-after td.changed:not(:focus) { background: var(--vscode-diffEditor-insertedTextBackground); }
td.changed { font-weight: bold; text-decoration: underline dotted; }
.summary { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
body.vscode-high-contrast tbody tr[class^="chg-"], body.vscode-high-contrast-light tbody tr[class^="chg-"], body.vscode-high-contrast tr td.changed:not(:focus), body.vscode-high-contrast-light tr td.changed:not(:focus) { background: none; }
body.vscode-high-contrast tr.chg-insert td, body.vscode-high-contrast-light tr.chg-insert td { box-shadow: inset 0 1px var(--vscode-diffEditor-insertedTextBorder, var(--vscode-contrastBorder)), inset 0 -1px var(--vscode-diffEditor-insertedTextBorder, var(--vscode-contrastBorder)); }
body.vscode-high-contrast tr.chg-delete td, body.vscode-high-contrast-light tr.chg-delete td { box-shadow: inset 0 1px var(--vscode-diffEditor-removedTextBorder, var(--vscode-contrastBorder)), inset 0 -1px var(--vscode-diffEditor-removedTextBorder, var(--vscode-contrastBorder)); }
body.vscode-high-contrast tr[class^="chg-update"] td, body.vscode-high-contrast-light tr[class^="chg-update"] td { box-shadow: inset 0 1px var(--vscode-contrastActiveBorder, var(--vscode-contrastBorder)), inset 0 -1px var(--vscode-contrastActiveBorder, var(--vscode-contrastBorder)); }
.tabbar { display: flex; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); }
.tabs { display: flex; min-width: 0; overflow-x: auto; }
.tab { padding: 4px 12px; color: var(--vscode-tab-inactiveForeground); background: var(--vscode-tab-inactiveBackground); border: 0; border-right: 1px solid var(--vscode-tab-border, var(--vscode-panel-border)); border-bottom: 2px solid transparent; font: inherit; white-space: nowrap; cursor: pointer; }
.tab.selected { color: var(--vscode-tab-activeForeground); background: var(--vscode-tab-activeBackground); border-bottom-color: var(--vscode-focusBorder); }
.run { margin-left: auto; padding: 0 8px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.pane, .result { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.result > .sql { padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); font-family: var(--vscode-editor-font-family); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.banner { padding: 4px 8px; color: var(--vscode-editorWarning-foreground); border-bottom: 1px solid var(--vscode-panel-border); }
.messages-view { flex: 1; min-height: 0; overflow: auto; }
table.messages { width: 100%; }
table.messages td.sql { max-width: 60em; }
table.messages td.num, table.messages th.num { text-align: right; }
td.st { text-align: center; font-weight: bold; }
td.st-ok { color: var(--vscode-testing-iconPassed, var(--vscode-editor-foreground)); }
td.st-error { color: var(--vscode-errorForeground); }
td.error { white-space: normal; }
td.error .message { margin-bottom: 4px; color: var(--vscode-errorForeground); white-space: pre-wrap; word-break: break-word; }
.end { padding: 6px 8px; color: var(--vscode-descriptionForeground); }
td:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
tr.sizer { visibility: collapse; }
tbody:focus { outline: none; }
`;
