import { SHELL_CSS } from '../shell/style';

/** The Catalog Dashboard stylesheet: the shell sheet plus the names and numbers of its tables. */
export const DASHBOARD_CSS = `${SHELL_CSS}
td.name { font-family: var(--vscode-editor-font-family); font-weight: 600; }
td.number, th.number { text-align: right; }
`;
