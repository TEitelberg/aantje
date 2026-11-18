import { LIST_CSS, SHELL_CSS } from '../shell/style';

/**
 * The Activity stylesheet: the shell and list sheets plus the note above the key figures, a wider gap between the key
 * figures and the tabs, the day table behind its summary and the table names that filter.
 */
export const ACTIVITY_CSS = `${SHELL_CSS}${LIST_CSS}
.notes { margin-bottom: var(--aantje-section-gap); }
.tab-row { margin-top: calc(var(--aantje-section-gap) + var(--aantje-control-gap)); }
details.alternative { margin: 4px 0 0; }
details.alternative summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
details.alternative summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
td.name, td.who { font-family: var(--vscode-editor-font-family); }
button.table-pick { padding: 0; color: inherit; background: none; border: 0; font: inherit; font-family: var(--vscode-editor-font-family); text-decoration: underline; cursor: pointer; }
button.table-pick:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
`;
