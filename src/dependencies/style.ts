import { LIST_CSS, SHELL_CSS } from '../shell/style';
import { ICON_BUTTON_CSS } from '../shell/svg-icon';

/**
 * The Dependencies stylesheet: the shell and list sheets plus the tables of objects and columns with the icons of their
 * rows, the icons of the header and the groups of the toolbar.
 */
export const DEPENDENCIES_CSS = `${SHELL_CSS}${LIST_CSS}
.mode-group { display: inline-flex; gap: 4px; }
td.name { font-family: var(--vscode-editor-font-family); }
td.detail-text { font-family: var(--vscode-editor-font-family); white-space: normal; overflow-wrap: anywhere; }
th.number, td.number { text-align: right; }
.depends-on table, .used-by table { table-layout: fixed; }
.depends-on th.kind, .used-by th.kind { width: 9em; }
.depends-on th.number, .used-by th.number { width: 4em; }
.depends-on th.icons, .used-by th.icons { width: 7.5em; }
.depends-on td.name, .used-by td.name { white-space: normal; overflow-wrap: anywhere; }
td.icons { padding-top: 0; padding-bottom: 0; }
td.icons button.icon + button.icon { margin-left: 2px; }
header button.icon { margin-right: 4px; }
${ICON_BUTTON_CSS}
`;
