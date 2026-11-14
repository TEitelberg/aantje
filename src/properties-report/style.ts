import { SHELL_CSS } from '../shell/style';

/** The Properties stylesheet: the rules of the metadata table, whose values are paths and settings that may be long, so they wrap. */
export const PROPERTIES_CSS = `${SHELL_CSS}
td.name { font-family: var(--vscode-editor-font-family); font-weight: 600; }
td.value { font-family: var(--vscode-editor-font-family); white-space: normal; overflow-wrap: anywhere; }
`;
