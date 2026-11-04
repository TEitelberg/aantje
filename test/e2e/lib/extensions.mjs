import { expect } from './expect.mjs';
import { openView, sidebar } from './workbench.mjs';

/**
 * Searches the installed extensions in the Extensions view (`@installed <name>`), opens the details page of the
 * extension with this id (`teitelberg.aantje`) and returns its parts (see `extensionDetails`).
 */
export async function openExtensionDetails(page, id) {
  await openView(page, 'Extensions');
  // The search box is an editor, not an input element: click into it, replace its text and type.
  await sidebar(page).locator('.suggest-input-container .monaco-editor').first().click();
  await page.keyboard.press('Control+A');
  // The search matches names, not ids: "teitelberg.aantje" would find nothing.
  await page.keyboard.type(`@installed ${id.split('.')[1]}`);
  const entry = sidebar(page).locator(`[data-extension-id="${id}"]`);
  await expect(entry).toHaveCount(1);
  await entry.click();
  const details = extensionDetails(page);
  await expect(details.editor).toBeVisible();
  return details;
}

/**
 * The details page of the extension that is open, as locators: the header (`name`, `publisher`, `description`,
 * `icon`), the whole page (`editor`, which includes the "Installation" facts such as identifier and version), and
 * the README (`readme`, the body of the web view that VS Code renders it in).
 */
export function extensionDetails(page) {
  const editor = page.locator('.extension-editor');
  const header = editor.locator('.header');
  return {
    editor,
    name: header.getByRole('heading'),
    publisher: header.locator('.publisher-name'),
    description: header.locator('.description'),
    icon: header.locator('img.icon'),
    // The web view is not inside the editor: VS Code lays it over the editor from outside of it.
    readme: page
      .locator('iframe.webview')
      .filter({ visible: true })
      .contentFrame()
      .locator('iframe#active-frame')
      .contentFrame()
      .locator('body'),
  };
}
