import { SHELL_CSS } from '../shell/style';

/** The Parquet inspector stylesheet: the shell sheet plus the range bars of the row groups. */
export const PARQUET_CSS = `${SHELL_CSS}
td.name, .path { font-family: var(--vscode-editor-font-family); }
td.name { font-weight: 600; }
td.number, th.number { text-align: right; }
td.value { font-family: var(--vscode-editor-font-family); white-space: normal; overflow-wrap: anywhere; max-width: 30em; }
.path { overflow-wrap: anywhere; }
.toolbar select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); font: inherit; max-width: 30em; }
.toolbar select.files { max-width: 100%; font-family: var(--vscode-editor-font-family); }
td.range { width: 40%; min-width: 120px; }
.range-track { position: relative; height: 10px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); }
.range-bar { position: absolute; top: 0; bottom: 0; min-width: 2px; background: var(--aantje-navy); }
body.vscode-high-contrast .range-bar, body.vscode-high-contrast-light .range-bar { background: var(--vscode-contrastBorder); }
`;
