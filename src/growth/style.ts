import { LIST_CSS, SHELL_CSS } from '../shell/style';

/** The Growth stylesheet: the shell sheet and the list rules; its filter takes longer table names. */
export const GROWTH_CSS = `${SHELL_CSS}${LIST_CSS}
.toolbar select { max-width: 24em; }
`;
