import { SHELL_CSS } from '../shell/style';

export const HEALTH_CSS = `${SHELL_CSS}
.run { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin: var(--aantje-control-gap) 0; }
.run input[type="number"] { width: 6em; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); font: inherit; }
button.primary { margin: 2px 4px 2px 0; padding: 2px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid var(--vscode-contrastBorder, transparent); font: inherit; cursor: pointer; }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.primary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
button:disabled { opacity: 0.5; cursor: default; }
.groups { margin: 8px 0; padding: 0; list-style: none; }
.groups li { padding: 2px 0; }
.groups .group-name { display: inline-block; min-width: 7em; font-weight: 600; }
.verdict { margin: 12px 0 4px; font-size: 1.1em; font-weight: 600; }
.verdict.healthy::before { content: "\\2714  "; }
.verdict.problems::before, .verdict.failed::before { content: "\\2716  "; }
.verdict.incomplete::before { content: "\\26A0  "; }
.coverage { margin: 4px 0 12px; }
.coverage h3 { margin: 8px 0 2px; font-size: 1em; }
.coverage ul { margin: 0; padding-left: 1.4em; }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; margin-bottom: 8px; }
.filters .set { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 2px; }
.filters .set-label { margin-right: 4px; color: var(--vscode-descriptionForeground); }
.filters input[type="search"] { width: 18em; max-width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); font: inherit; }
.health-finding { margin: var(--aantje-control-gap) 0; border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border)); border-left-width: 4px; border-radius: 4px; }
.health-finding.error { border-left-color: var(--vscode-editorError-foreground); }
.health-finding.warning { border-left-color: var(--vscode-editorWarning-foreground); }
.health-finding.info { border-left-color: var(--vscode-editorInfo-foreground); }
.health-finding summary { padding: 6px 10px; cursor: pointer; }
.health-finding summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.health-finding .sev { margin-right: 6px; font-weight: 600; }
.health-finding .title { font-weight: 600; }
.health-finding .body { padding: 0 10px 8px; }
.health-finding dl { margin: 4px 0; }
.health-finding dt { margin-top: 4px; color: var(--vscode-descriptionForeground); }
.health-finding dd { margin: 0; overflow-wrap: anywhere; }
.health-finding pre { margin: 4px 0; padding: 6px 8px; overflow-x: auto; background: var(--vscode-textCodeBlock-background); }
.health-finding code { font-family: var(--vscode-editor-font-family); }
body.vscode-high-contrast .health-finding, body.vscode-high-contrast-light .health-finding { border-color: var(--vscode-contrastBorder); }
`;
