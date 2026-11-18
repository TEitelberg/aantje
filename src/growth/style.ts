import { DETAIL_CSS, LIST_CSS, SHELL_CSS } from '../shell/style';

/**
 * The Growth stylesheet: the shell, list and detail sheets; its filter takes longer table names, and the tabs keep a
 * little more room below the key figures than the usual section gap. The table of the snapshots is the shell's paged
 * table, whose rules are in the shell sheet.
 */
export const GROWTH_CSS = `${SHELL_CSS}${LIST_CSS}${DETAIL_CSS}
.toolbar select { max-width: 24em; }
.tab-row { margin-top: calc(var(--aantje-section-gap) + var(--aantje-control-gap)); }
`;
