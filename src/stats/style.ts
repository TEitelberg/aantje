import { SHELL_CSS } from '../shell/style';

/** The statistics stylesheet: the shell sheet plus the rules of the column table. */
export const STATS_CSS = `${SHELL_CSS}
td.name { font-family: var(--vscode-editor-font-family); font-weight: 600; }
td.type, td.range { font-family: var(--vscode-editor-font-family); }
td.range { max-width: 20em; overflow: hidden; text-overflow: ellipsis; }
.nulls-cell { display: flex; align-items: center; gap: 8px; min-width: 12em; }
.bar { flex: 1; height: 8px; min-width: 60px; background: color-mix(in srgb, var(--vscode-editor-foreground) 15%, transparent); border-radius: 4px; overflow: hidden; }
.bar > div { height: 100%; }
body.vscode-high-contrast .bar, body.vscode-high-contrast-light .bar { border: 1px solid var(--vscode-contrastBorder); }
`;
