import { escapeHtml } from '../html-escape';

interface WebviewHtmlOptions {
  /** A fresh random value for every page. */
  readonly nonce: string;
  /** The `webview.asWebviewUri` of the page script in `dist` (`grid-client.js`, `report-client.js`). */
  readonly scriptUri: string;
  /** Scripts that run before it, e.g. `plan-client.js` of the results page. */
  readonly scriptsBefore?: readonly string[];
  readonly title: string;
  /** The stylesheet of the page, e.g. `GRID_CSS` of the grid or the stylesheet of a report kind. */
  readonly css: string;
}

/**
 * The page of every webview of aantje: the grid, the results and the reports. It carries no data; the rows arrive by
 * postMessage, so no table text reaches the markup.
 */
export function webviewHtml(options: WebviewHtmlOptions): string {
  const nonce = escapeHtml(options.nonce);
  // Only the page's scripts and the one style element carry the nonce.
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(options.title)}</title>
<style nonce="${nonce}">${options.css}</style>
</head>
<body>
${[...(options.scriptsBefore ?? []), options.scriptUri].map((uri) => `<script nonce="${nonce}" src="${escapeHtml(uri)}"></script>`).join('\n')}
</body>
</html>
`;
}
