import { SHELL_CSS } from '../shell/style';
import { ICON_BUTTON_CSS } from '../shell/svg-icon';

/** The Inactive Tables stylesheet: the shell sheet plus the table list and the icons of its rows. */
export const INACTIVE_CSS = `${SHELL_CSS}
td.name, td.who { font-family: var(--vscode-editor-font-family); }
td.who { white-space: normal; max-width: 30em; }
td.number { text-align: right; }
td.icons { padding-top: 0; padding-bottom: 0; }
td.icons button.icon + button.icon { margin-left: 2px; }
${ICON_BUTTON_CSS}
`;
