import { SHELL_CSS } from '../shell/style';

/** The Advisor stylesheet: the shell sheet plus the rules of the figures and the policy. */
export const ADVISOR_CSS = `${SHELL_CSS}
.levels { margin: 2px 0 6px; color: var(--vscode-descriptionForeground); }
.figures { width: auto; margin: 6px 0; }
.figures td, .figures th { padding: 2px 12px 2px 0; border-bottom: 0; }
.figures th { font-weight: normal; text-align: left; }
.policy { margin: 4px 0; padding-left: 20px; }
.skipped { padding-left: 8px; border-left: 4px solid var(--vscode-editorWarning-foreground); }
`;
