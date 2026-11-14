import { DETAIL_CSS, LIST_CSS, SHELL_CSS } from '../shell/style';

/** The Snapshot Report stylesheet: the shell, list and detail sheets plus the table filter and the second snapshot. */
export const SNAPSHOT_REPORT_CSS = `${SHELL_CSS}${LIST_CSS}${DETAIL_CSS}
.filter { position: relative; }
.filter summary { cursor: pointer; }
.choices { position: absolute; z-index: 5; max-height: 50vh; min-width: 16em; overflow: auto; padding: 8px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); }
.choices .check { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
.choices .table { margin-left: 1.5em; }
.schema { margin-top: 4px; font-weight: 600; }
.schema .table { font-weight: normal; }
.list tr.other td { border-bottom: 2px dashed var(--vscode-focusBorder); }
`;
