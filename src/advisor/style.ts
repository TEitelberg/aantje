import { SHELL_CSS } from '../shell/style';

/** The Advisor stylesheet: the shell sheet plus the rules of the policy and of what was not measured. */
export const ADVISOR_CSS = `${SHELL_CSS}
.policy { margin: 4px 0; padding-left: 20px; }
.skipped { padding-left: 8px; border-left: 4px solid var(--vscode-editorWarning-foreground); }
`;
