import { writeClipboard } from './clipboard.mjs';
import { eventually, expect } from './expect.mjs';

/**
 * Puts the keyboard focus into the first text editor, which is where a SQL document opens. An editor that has the focus
 * is left alone, so that its cursor stays where it is; otherwise a click in the empty space below the text (inside the editor) focuses it.
 */
export async function focusEditor(page) {
  if (await page.evaluate(() => globalThis.document.activeElement?.closest('.monaco-editor') != null)) {
    return;
  }
  // The editor can be short (a results panel lies in a group below it), so the click stays inside its box.
  const editor = page.locator('.editor-group-container .monaco-editor').first();
  const box = await editor.boundingBox();
  await editor.click({
    position: { x: Math.min(400, (box?.width ?? 800) / 2), y: Math.min(400, (box?.height ?? 800) - 10) },
  });
  await expect(page.locator('.monaco-editor.focused').first()).toBeVisible();
}

/**
 * The lines of an editor as they are drawn, joined by line breaks (`lines` is its `.view-lines` element). Only a short
 * document is complete: the editor draws the lines that are in view.
 */
function drawnText(lines) {
  return lines.evaluate((element) =>
    [...element.querySelectorAll('.view-line')]
      .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
      .map((line) => line.textContent.replaceAll(' ', ' '))
      .join('\n'),
  );
}

const firstEditorLines = (page) =>
  page.locator('.editor-group-container').first().locator('.monaco-editor .view-lines').first();

/**
 * Replaces the whole text of the active editor by pasting it, so that the editor does not close brackets or quotes
 * on the way, and waits until the editor shows it. The text must be short (see `drawnText`).
 */
export async function setEditorText(page, text) {
  await eventually(async () => {
    await focusEditor(page);
    await writeClipboard(page, text);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+v');
    await expect.poll(() => drawnText(firstEditorLines(page)), { timeout: 2_000 }).toBe(text);
  });
}

/** The text of the active editor (which must have the focus), read through the clipboard: select all, copy. */
export async function editorText(page) {
  await focusEditor(page);
  await writeClipboard(page, '');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  let text = '';
  await eventually(async () => {
    text = await page.evaluate(() => globalThis.navigator.clipboard.readText());
    if (text === '') {
      throw new Error('nothing was copied');
    }
  });
  return text;
}

/** The selected tab of the first editor group (the document that the editor shows; a results panel opens in a group below it). */
export function activeTab(page) {
  return page.locator('.editor-group-container').first().locator('.tabs-container .tab.active');
}

/** The texts of the two sides of the diff editor that is visible, as { original, modified } (a short document). */
export async function diffEditorTexts(page) {
  const diff = page.locator('.monaco-diff-editor').first();
  await expect(diff).toBeVisible();
  const side = (name) => diff.locator(`.editor.${name} .view-lines`);
  await expect(side('original')).toBeVisible();
  await expect(side('modified')).toBeVisible();
  return { original: await drawnText(side('original')), modified: await drawnText(side('modified')) };
}
