import { expect } from './expect.mjs';
import { PROJECT } from './server.mjs';
import { pick, quickInput, runCommand } from './quick-input.mjs';

const part = (page, name) => page.locator(`[id="workbench.parts.${name}"]`);

/**
 * Opens the workbench with the project folder and waits until it is usable. The page must be a secure context, which
 * the runner takes care of: without it the clipboard and the web views (README of an extension) do not work.
 */
export async function openWorkbench(page, { url, folder = PROJECT }) {
  await page.goto(`${url}/?folder=${folder}`);
  await expect(page.locator('.monaco-workbench')).toBeVisible();
  await expect(part(page, 'statusbar')).toBeVisible();
  await expect(activityBarTab(page, 'Explorer')).toBeVisible();
  expect(await page.evaluate(() => window.isSecureContext), 'the page is a secure context').toBe(true);
}

/** The left side bar: the view of the selected Activity Bar item. */
export function sidebar(page) {
  return part(page, 'sidebar');
}

/** The bottom panel: Output, Problems, Terminal. */
export function panel(page) {
  return part(page, 'panel');
}

/** The Activity Bar. */
export function activityBar(page) {
  return part(page, 'activitybar');
}

/** The tab of a view container in the Activity Bar, for example 'Explorer', 'Extensions' or 'aantje'. */
export function activityBarTab(page, name) {
  return activityBar(page).getByRole('tab', { name });
}

/**
 * Shows the view container of the Activity Bar tab. A click on the tab that is selected already would hide the
 * side bar, so a selected tab is left alone.
 */
export async function openView(page, name) {
  const tab = activityBarTab(page, name);
  if ((await tab.getAttribute('aria-selected')) !== 'true') {
    await tab.click();
  }
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** The items of the status bar as { label, text }; `label` is what a screen reader hears, with the tooltip. */
export function statusBarItems(page) {
  return part(page, 'statusbar')
    .locator('.statusbar-item')
    .evaluateAll((items) =>
      items.map((item) => ({
        label: item.getAttribute('aria-label') ?? '',
        text: item.textContent?.trim() ?? '',
      })),
    );
}

/** The status bar item that contains this text (string) or matches it (RegExp). */
export function statusBarItem(page, text) {
  return part(page, 'statusbar').locator('.statusbar-item').filter({ hasText: text });
}

/**
 * Switches the color theme with "Preferences: Color Theme". `name` is the label in the picker, for example
 * 'Light 2026' (the default of code-server 4.144) or 'Dark 2026'; `kind` is 'light' or 'dark' and is what the
 * workbench must show afterwards. The setting is saved in the user settings of the server and goes away with a reset.
 */
export async function setColorTheme(page, { name, kind }) {
  await runCommand(page, 'Preferences: Color Theme');
  await pick(page, name);
  // "vs" is the class of the light kinds and "vs-dark" of the dark ones; \b would match "vs" inside "vs-dark".
  await expect(page.locator('.monaco-workbench')).toHaveClass(
    kind === 'dark' ? /(^|\s)vs-dark(\s|$)/ : /(^|\s)vs(\s|$)/,
  );
}

/** The names of all output channels that exist now. A channel appears when its extension creates it. */
export async function outputChannels(page) {
  const q = quickInput(page);
  await runCommand(page, 'Output: Show Output Channels...');
  await expect(q.rows.first()).toBeVisible();
  const labels = await q.labels();
  await page.keyboard.press('Escape');
  await expect(q.widget).toBeHidden();
  return labels;
}

/**
 * Shows an output channel in the Output panel and returns the panel, whose text is the log, for example
 * `expect(await showOutputChannel(page, 'aantje')).toContainText('Connected to')`.
 */
export async function showOutputChannel(page, name) {
  await runCommand(page, 'Output: Show Output Channels...');
  await pick(page, name);
  const output = panel(page);
  await expect(output.locator('.output-view')).toBeVisible();
  return output;
}
