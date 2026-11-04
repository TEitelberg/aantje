import { SHELL_CSS } from '../shell/style';

/** The Storage stylesheet: the shell sheet plus the rules of the table list and the selection. */
export const STORAGE_CSS = `${SHELL_CSS}
td.name { font-family: var(--vscode-editor-font-family); font-weight: 600; }
td.number, th.number { text-align: right; }
th button.sort { padding: 0; color: inherit; background: none; border: 0; font: inherit; cursor: pointer; }
th button.sort:hover { color: var(--vscode-foreground); }
th button.sort:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
th[aria-sort="ascending"] button.sort::after { content: " \\25B2"; font-size: 0.7em; }
th[aria-sort="descending"] button.sort::after { content: " \\25BC"; font-size: 0.7em; }
td.name button.pick { font-family: var(--vscode-editor-font-family); font-weight: 600; }
tr.selected td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.selection { margin: var(--aantje-control-gap) 0; padding: var(--aantje-card-padding); border: 1px solid var(--vscode-focusBorder); border-radius: 4px; }
.selection h3 { margin: 0 0 4px; font-size: 1em; }
.selection p { margin: 2px 0 6px; color: var(--vscode-descriptionForeground); }
.scheduled.warning { padding-left: 8px; border-left: 4px solid var(--vscode-editorWarning-foreground); }
`;
