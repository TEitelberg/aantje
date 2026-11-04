import { SHELL_CSS } from '../shell/style';

export const HISTORY_CSS = `${SHELL_CSS}
.kinds { display: flex; flex-wrap: wrap; gap: 4px 12px; }
.legend { margin: 4px 0 8px; }
.matrix { overflow: auto; max-height: 70vh; }
.matrix table { width: auto; }
.matrix th, .matrix td { vertical-align: top; }
.matrix thead th { position: sticky; top: 0; z-index: 1; background: var(--vscode-editor-background); }
.matrix th.selected { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
.matrix td.name { font-family: var(--vscode-editor-font-family); font-weight: 600; }
.matrix td.type, .matrix td.events { font-family: var(--vscode-editor-font-family); }
.matrix td.events { white-space: normal; min-width: 8em; color: var(--vscode-descriptionForeground); }
.matrix td.selected { background: var(--vscode-list-activeSelectionBackground); }
.matrix td.former { color: var(--vscode-descriptionForeground); font-weight: normal; }
button.cell { display: block; width: 100%; margin: 0 0 2px; padding: 1px 4px; text-align: left; color: inherit; background: none; border: 1px solid var(--vscode-panel-border); font: inherit; font-family: var(--vscode-editor-font-family); cursor: pointer; }
button.cell:hover { background: var(--vscode-list-hoverBackground); }
button.cell[aria-pressed="true"] { color: var(--vscode-list-activeSelectionForeground); background: var(--vscode-list-activeSelectionBackground); }
button.cell:focus-visible, button.pick:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.time { display: block; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
.detail { margin-top: var(--aantje-section-gap); }
.detail:focus { outline: none; }
.detail h3 { margin: 12px 0 4px; font-size: 1em; }
.who { white-space: pre-wrap; }
.label { margin: 0 4px; color: var(--vscode-descriptionForeground); }
.changes { margin: 0; padding: 0; list-style: none; }
.changes li { padding: 2px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.changes li.selected { font-weight: 600; }
.changes .name { margin-right: 12px; font-family: var(--vscode-editor-font-family); }
`;
