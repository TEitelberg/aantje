import { escapeHtml } from '../html-escape';
import { GRID_CSS } from './style';

interface GridHtmlOptions {
  /** A fresh random value for every page. */
  readonly nonce: string;
  /** The `webview.asWebviewUri` of the page script in `dist` (`grid-client.js`, `report-client.js`). */
  readonly scriptUri: string;
  readonly title: string;
  /** The stylesheet of the page; the grid's own one when absent. */
  readonly css?: string;
}

/** The page carries no data; the rows arrive by postMessage, so no table text reaches the markup. */
export function gridHtml(options: GridHtmlOptions): string {
  const nonce = escapeHtml(options.nonce);
  // Only the one script and the one style element carry the nonce.
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
<style nonce="${nonce}">${options.css ?? GRID_CSS}</style>
</head>
<body>
<script nonce="${nonce}" src="${escapeHtml(options.scriptUri)}"></script>
</body>
</html>
`;
}
