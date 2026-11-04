import { LIST_CSS, SHELL_CSS } from '../shell/style';

/** The Activity stylesheet: the shell sheet plus the rules of the filters, charts and detail pane. */
export const ACTIVITY_CSS = `${SHELL_CSS}${LIST_CSS}
.kinds { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.chart.short { height: 240px; }
details.alternative { margin: 4px 0 0; }
details.alternative summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
details.alternative summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
td.name, td.who { font-family: var(--vscode-editor-font-family); }
.detail h3 { margin: 12px 0 4px; font-size: 1em; }
.label { margin: 0 4px; color: var(--vscode-descriptionForeground); }
.tables, .others { margin: 0; padding: 0; list-style: none; }
.table-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.table-row .name { font-family: var(--vscode-editor-font-family); font-weight: 600; }
.table-row .what { color: var(--vscode-descriptionForeground); }
button.table-pick { padding: 0; color: inherit; background: none; border: 0; font: inherit; font-family: var(--vscode-editor-font-family); text-decoration: underline; cursor: pointer; }
button.table-pick:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
`;
