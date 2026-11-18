import { escapeHtml } from '../html-escape';

interface WebviewHtmlOptions {
  /** A fresh random value for every page. */
  readonly nonce: string;
  /** The `webview.asWebviewUri` of the page script in `dist` (`grid-client.js`, `report-client.js`). */
  readonly scriptUri: string;
  /** Scripts that run before it, e.g. `plan-client.js` of the results page. */
  readonly scriptsBefore?: readonly string[];
  /** The webview address of the logo of aantje, written on the body (`data-logo`) for the header of a report. */
  readonly logo?: string;
  readonly title: string;
  /** The stylesheet of the page, e.g. `GRID_CSS` of the grid or the stylesheet of a report kind. */
  readonly css: string;
  /** Where images may load from (`webview.cspSource`, the logo of the Templates page); without it the page loads none. */
  readonly imageSource?: string;
}

/**
 * The page of every webview of aantje: the grid, the results, the reports and the Templates page. It carries no data;
 * the rows arrive by postMessage, so no table text reaches the markup.
 */
export function webviewHtml(options: WebviewHtmlOptions): string {
  const nonce = escapeHtml(options.nonce);
  // Only the page's scripts and the one style element carry the nonce.
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    ...(options.imageSource === undefined ? [] : [`img-src ${escapeHtml(options.imageSource)}`]),
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
<body${options.logo === undefined ? '' : ` data-logo="${escapeHtml(options.logo)}"`}>
${[...(options.scriptsBefore ?? []), options.scriptUri].map((uri) => `<script nonce="${nonce}" src="${escapeHtml(uri)}"></script>`).join('\n')}
</body>
</html>
`;
}
