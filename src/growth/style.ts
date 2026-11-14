import { DETAIL_CSS, LIST_CSS, SHELL_CSS } from '../shell/style';

/** The Growth stylesheet: the shell, list and detail sheets; its filter takes longer table names. */
export const GROWTH_CSS = `${SHELL_CSS}${LIST_CSS}${DETAIL_CSS}
.toolbar select { max-width: 24em; }
`;
