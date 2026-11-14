import { SHELL_CSS } from '../shell/style';

/** The Dependencies stylesheet: the shell sheet plus the rules of the indented list, the detail pane and its icons. */
export const DEPENDENCIES_CSS = `${SHELL_CSS}
[hidden] { display: none !important; }
.direction { display: inline-flex; gap: 4px; }
.keylist.objects button { font-family: var(--vscode-editor-font-family); }
.keylist .sign { display: inline-block; min-width: 2.2em; color: var(--vscode-descriptionForeground); }
.keylist .kind, .keylist .edge { margin-left: 8px; color: var(--vscode-descriptionForeground); }
.keylist button[aria-selected="true"] .sign, .keylist button[aria-selected="true"] .kind, .keylist button[aria-selected="true"] .edge { color: inherit; }
.detail ul { margin: 4px 0; padding-left: 20px; }
.detail { margin-top: var(--aantje-section-gap); padding: var(--aantje-card-padding); border: 1px solid var(--vscode-focusBorder); border-radius: 4px; }
.detail:focus { outline: none; }
.detail .title-line { display: flex; align-items: center; gap: var(--aantje-control-gap); margin-bottom: 4px; }
.detail .title-line h2 { flex: 1; min-width: 0; margin: 0; overflow-wrap: anywhere; }
.icons { display: flex; flex: none; gap: 2px; }
button.icon { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; color: var(--vscode-icon-foreground, var(--vscode-foreground)); background: none; border: 1px dashed transparent; border-radius: 5px; cursor: pointer; }
button.icon:hover { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-toolbar-hoverOutline, transparent); }
button.icon:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
button.icon svg { display: block; }
.detail h3 { margin: 12px 0 4px; font-size: 1em; }
td.name, td.what { font-family: var(--vscode-editor-font-family); }
td.detail-text { font-family: var(--vscode-editor-font-family); white-space: normal; overflow-wrap: anywhere; }
`;
