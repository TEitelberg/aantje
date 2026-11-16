import { SHELL_CSS } from '../shell/style';

/** The Iceberg stylesheet: the logo before the title, the state of a table is green or red text, ids are code. */
export const ICEBERG_CSS = `${SHELL_CSS}
h1 { display: flex; align-items: center; gap: 10px; }
h1 svg.logo { flex: none; }
td.name, td.ids { font-family: var(--vscode-editor-font-family); }
td.ids { white-space: normal; overflow-wrap: anywhere; }
td.state.good { color: var(--vscode-charts-green); font-weight: 600; }
td.state.bad { color: var(--vscode-charts-red); font-weight: 600; }
.verdict { font-size: 1.05em; margin: 0 0 12px; }
.verdict.good { color: var(--vscode-charts-green); }
.verdict.bad { color: var(--vscode-charts-red); }
`;
