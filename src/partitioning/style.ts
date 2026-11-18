import { SHELL_CSS } from '../shell/style';

/** The Suggest Partitioning stylesheet: the shell sheet plus the figures of a candidate. */
export const PARTITION_CSS = `${SHELL_CSS}
td.name, .keys { font-family: var(--vscode-editor-font-family); }
td.name { font-weight: 600; }
td.number, th.number { text-align: right; }
.figures { color: var(--vscode-descriptionForeground); }
.finding-body ul { margin: 4px 0; padding-left: 20px; }
`;
