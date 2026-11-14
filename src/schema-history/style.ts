import { DETAIL_CSS, SHELL_CSS } from '../shell/style';

/**
 * The Schema History stylesheet: the shell and detail sheets plus the matrix and the list of changes. Of the header of
 * the matrix only the row of the snapshots stays at the top: the row of the events below it would lie on it.
 */
export const HISTORY_CSS = `${SHELL_CSS}${DETAIL_CSS}
.legend { margin: 4px 0 8px; }
.matrix { overflow: auto; max-height: 70vh; }
.matrix table { width: auto; }
.matrix th, .matrix td { vertical-align: top; }
.matrix thead th { position: sticky; top: 0; z-index: 1; background: var(--vscode-editor-background); }
.matrix thead tr.events-row th { position: static; }
.matrix th.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
.matrix td.name { font-family: var(--vscode-editor-font-family); font-weight: 600; }
.matrix td.type, .matrix th.events { font-family: var(--vscode-editor-font-family); }
.matrix th.events { white-space: normal; min-width: 8em; color: var(--vscode-descriptionForeground); }
.matrix td.selected { background: var(--vscode-list-activeSelectionBackground); }
.matrix .former { color: var(--vscode-descriptionForeground); font-weight: normal; }
button.cell { display: block; width: 100%; margin: 0 0 2px; padding: 1px 4px; text-align: left; color: inherit; background: none; border: 1px solid var(--vscode-panel-border); font: inherit; font-family: var(--vscode-editor-font-family); cursor: pointer; }
button.cell:hover { background: var(--vscode-list-hoverBackground); }
button.cell[aria-pressed="true"] { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
button.cell:focus-visible, button.pick:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.time { display: block; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
.changes { margin: 0; padding: 0; list-style: none; }
.changes li { padding: 2px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.changes li.selected { font-weight: 600; }
.changes .name { margin-right: 12px; font-family: var(--vscode-editor-font-family); }
`;
