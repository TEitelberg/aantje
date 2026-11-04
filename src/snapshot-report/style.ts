import { SHELL_CSS } from '../shell/style';

export const SNAPSHOT_REPORT_CSS = `${SHELL_CSS}
.kinds { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.filter { position: relative; }
.filter summary { cursor: pointer; }
.choices { position: absolute; z-index: 5; max-height: 50vh; min-width: 16em; overflow: auto; padding: 8px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
.choices .check { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.choices .table { margin-left: 1.5em; }
.schema { margin-top: 4px; font-weight: 600; }
.schema .table { font-weight: normal; }
.detail, .list { margin-top: var(--aantje-section-gap); }
.detail:focus { outline: none; }
.detail h3 { margin: 12px 0 4px; font-size: 1em; }
.who { white-space: pre-wrap; }
.label { margin: 0 4px; color: var(--vscode-descriptionForeground); }
.tables, .others { margin: 0; padding: 0; list-style: none; }
.table-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.table-row .name { font-family: var(--vscode-editor-font-family); font-weight: 600; }
.table-row .what { color: var(--vscode-descriptionForeground); }
.list tr.selected td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.list tr.other td { border-bottom: 2px dashed var(--vscode-focusBorder); }
.list td.who { white-space: normal; max-width: 30em; }
`;
