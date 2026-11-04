import { SHELL_CSS } from '../shell/style';

/** The Dependencies stylesheet: the shell sheet plus the rules of the indented list and the detail pane. */
export const DEPENDENCIES_CSS = `${SHELL_CSS}
.direction { display: inline-flex; gap: 4px; }
.keylist.objects button { font-family: var(--vscode-editor-font-family); }
.keylist .sign { display: inline-block; min-width: 2.2em; color: var(--vscode-descriptionForeground); }
.keylist .kind, .keylist .edge { margin-left: 8px; color: var(--vscode-descriptionForeground); }
.keylist button[aria-selected="true"] .sign, .keylist button[aria-selected="true"] .kind, .keylist button[aria-selected="true"] .edge { color: inherit; }
.impact { margin: var(--aantje-section-gap) 0; padding: var(--aantje-card-padding); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-left-width: 4px; border-radius: 4px; }
.impact.warning { border-left-color: var(--vscode-editorWarning-foreground); }
.impact h2 { margin: 0 0 4px; }
.impact ul, .detail ul { margin: 4px 0; padding-left: 20px; }
.detail { margin-top: var(--aantje-section-gap); padding: var(--aantje-card-padding); border: 1px solid var(--vscode-focusBorder); border-radius: 4px; }
.detail:focus { outline: none; }
.detail h2 { margin: 0 0 4px; }
.detail h3 { margin: 12px 0 4px; font-size: 1em; }
td.name, td.what { font-family: var(--vscode-editor-font-family); }
td.detail-text { font-family: var(--vscode-editor-font-family); white-space: normal; overflow-wrap: anywhere; }
`;
