/**
 * The clipboard of the browser. The runner grants the permissions `clipboard-read` and `clipboard-write` for the origin
 * of the workbench; that works because the page is a secure context.
 */
export function readClipboard(page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Replaces the clipboard, for example with an empty text to see that the next action sets it. */
export function writeClipboard(page, text) {
  return page.evaluate((value) => navigator.clipboard.writeText(value), text);
}
