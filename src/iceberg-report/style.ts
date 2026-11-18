import { SHELL_CSS } from '../shell/style';

/**
 * The Iceberg stylesheet: the Iceberg logo in the title before its text, as tall as the title's line, so that the
 * logo of aantje stays as tall as the two lines; the state of a table is green or red text, ids are code.
 */
export const ICEBERG_CSS = `${SHELL_CSS}
h1 { display: flex; align-items: center; gap: 8px; }
h1 svg.logo { flex: none; width: 1.25em; height: 1.25em; }
td.name, td.ids { font-family: var(--vscode-editor-font-family); }
td.ids { white-space: normal; overflow-wrap: anywhere; }
td.state.good { color: var(--aantje-ok); font-weight: 600; }
td.state.bad { color: var(--aantje-error); font-weight: 600; }
.verdict { font-size: 1.05em; margin: 0 0 12px; }
.verdict.good { color: var(--aantje-ok); }
.verdict.bad { color: var(--aantje-error); }
`;
