import { LIST_CSS, SHELL_CSS } from '../shell/style';

/**
 * The Schema History stylesheet: the shell and list sheets plus From and To on one line, the comparison and the list
 * of the changes of a column.
 */
export const HISTORY_CSS = `${SHELL_CSS}${LIST_CSS}
.notes { margin-bottom: var(--aantje-control-gap); }
.range-pair { display: inline-flex; flex-wrap: nowrap; align-items: center; gap: var(--aantje-section-gap); }
.toolbar select { max-width: none; }
.comparison th, .comparison td, .column-history td { vertical-align: top; }
.comparison td.name { font-family: var(--vscode-editor-font-family); font-weight: 600; }
.comparison .former { color: var(--vscode-descriptionForeground); font-weight: normal; }
.comparison td.state, .comparison td.changes, .column-history td.change { font-family: var(--vscode-editor-font-family); white-space: normal; }
.comparison td.absent { color: var(--vscode-descriptionForeground); }
.time { display: block; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
.legend { margin: var(--aantje-control-gap) 0 0; }
`;
