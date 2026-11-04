import { eventually, expect } from './expect.mjs';
import { sidebar } from './workbench.mjs';

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The rows of the tree in the side bar that are rendered now (VS Code renders only the rows in view). */
function treeRows(page, level) {
  return sidebar(page).locator(
    `.monaco-list-row[role="treeitem"]${level === undefined ? '' : `[aria-level="${level}"]`}`,
  );
}

/**
 * The row whose label is exactly `label`; `level` (1 = top) tells apart rows with the same label, for example the
 * `name` fields of two structs.
 */
export function treeRow(page, label, { level } = {}) {
  return treeRows(page, level).filter({
    has: page.locator('.label-name').filter({ hasText: new RegExp(`^${escapeRegExp(label)}$`) }),
  });
}

/** Every rendered row as { label, description, level, expanded }; `expanded` is undefined for a leaf. */
export function readTree(page) {
  return treeRows(page).evaluateAll((rows) =>
    rows.map((row) => ({
      label: row.querySelector('.label-name')?.textContent ?? '',
      description: row.querySelector('.label-description')?.textContent ?? '',
      level: Number(row.getAttribute('aria-level')),
      expanded: row.hasAttribute('aria-expanded') ? row.getAttribute('aria-expanded') === 'true' : undefined,
    })),
  );
}

/**
 * The rows as indented text, one line per row: two spaces per level below the first, then the label and, when the
 * row has one, ' : ' and its description. This is the format of test/integration/expectations.ts.
 */
export async function outline(page) {
  return (await readTree(page)).map(
    ({ label, description, level }) =>
      `${'  '.repeat(level - 1)}${label}${description ? ` : ${description}` : ''}`,
  );
}

/**
 * Expands a node with a click on its label and waits until it is expanded. Its children may still be loading; wait
 * for them with `expect(treeRow(page, '...')).toBeVisible()` or `expect.poll(() => outline(page))`.
 */
export async function expandNode(page, label, options) {
  const row = treeRow(page, label, options);
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) !== 'true') {
    await row.locator('.label-name').click();
  }
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

/** Collapses a node with a click on its label and waits until it is collapsed. */
export async function collapseNode(page, label, options) {
  const row = treeRow(page, label, options);
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) !== 'false') {
    await row.locator('.label-name').click();
  }
  await expect(row).toHaveAttribute('aria-expanded', 'false');
}

/**
 * Opens the context menu of `target` (a locator) with a right click and chooses the item with this label. The menu
 * swallows clicks for a moment after it opened, so the click is repeated until the menu has closed.
 */
export async function chooseFromContextMenu(page, target, label) {
  await target.click({ button: 'right' });
  const menu = page.locator('.monaco-menu').first();
  await expect(menu).toBeVisible();
  const item = menu.getByRole('menuitem', { name: label });
  await eventually(async () => {
    await item.click({ timeout: 2_000 });
    await expect(menu).toBeHidden({ timeout: 1_500 });
  });
}

/** The labels of the items of the context menu of `target`; the menu is closed again. */
export async function contextMenuItems(page, target) {
  await target.click({ button: 'right' });
  const menu = page.locator('.monaco-menu').first();
  await expect(menu).toBeVisible();
  const items = await menu.getByRole('menuitem').allTextContents();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  return items.map((item) => item.trim());
}

/** Hovers over `target` (a locator) and returns the text of the tooltip that appears. */
export async function hoverText(page, target) {
  await target.hover();
  const hover = page.locator('.monaco-hover:visible').first();
  await expect(hover).toBeVisible();
  const text = await hover.innerText();
  // Away from the target, so that the tooltip does not cover what the next step wants to click.
  await page.mouse.move(0, 0);
  await expect(hover).toBeHidden();
  return text;
}

/** Opens the context menu of `target` and the submenu with this label in it; returns the submenu's labels (it stays open). */
async function openSubmenu(page, target, submenu) {
  await target.click({ button: 'right' });
  const menu = page.locator('.monaco-menu').first();
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: submenu, exact: true }).click();
  const opened = page.locator('.monaco-menu').nth(1);
  await expect(opened).toBeVisible();
  return { menu, opened };
}

/**
 * Chooses an item of a submenu of the context menu of `target`, for example "Script as" > "Script as CREATE". Like
 * `chooseFromContextMenu`, the click is repeated until the menus have closed.
 */
export async function chooseFromSubmenu(page, target, submenu, label) {
  const { menu, opened } = await openSubmenu(page, target, submenu);
  const item = opened.getByRole('menuitem', { name: label, exact: true });
  await eventually(async () => {
    await item.click({ timeout: 2_000 });
    await expect(menu).toBeHidden({ timeout: 1_500 });
  });
}

/** The labels of the items of the submenu `submenu` in the context menu of `target`; the menus are closed again. */
export async function submenuItems(page, target, submenu) {
  const { menu, opened } = await openSubmenu(page, target, submenu);
  const items = (await opened.getByRole('menuitem').allTextContents()).map((item) => item.trim());
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  return items;
}

/**
 * The labels of the items of the submenu `submenu` that are shown but disabled (greyed out, by the `enablement` of
 * their command); the menus are closed again. VS Code marks such an item with `aria-disabled` and the class `disabled`.
 */
export async function disabledSubmenuItems(page, target, submenu) {
  const { menu, opened } = await openSubmenu(page, target, submenu);
  const items = await opened
    .getByRole('menuitem')
    .evaluateAll((elements) =>
      elements
        .filter(
          (element) =>
            element.getAttribute('aria-disabled') === 'true' ||
            element.classList.contains('disabled') ||
            element.closest('.action-item')?.classList.contains('disabled') === true,
        )
        .map((element) => (element.textContent ?? '').trim()),
    );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  return items;
}

/**
 * Scrolls the tree until the row with this label is rendered (a long list draws only the rows in view) and returns the
 * row. It moves the focus from the top down by pages, which scrolls the list, and one page further, so that the row is
 * in the upper part of the list and the children that the caller expands next are in view as well.
 */
export async function scrollToRow(page, label, options) {
  const row = treeRow(page, label, options);
  const list = sidebar(page).locator('.monaco-list').first();
  await list.focus();
  await page.keyboard.press('Home');
  await eventually(
    async () => {
      if ((await row.count()) === 0) {
        await page.keyboard.press('PageDown');
        throw new Error(`the row "${label}" is not rendered yet`);
      }
    },
    { timeout: 30_000 },
  );
  await page.keyboard.press('PageDown');
  await expect(row).toBeVisible();
  return row;
}
