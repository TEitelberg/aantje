import { eventually, expect } from './expect.mjs';
import { quickInput } from './quick-input.mjs';
import { contextMenuItems } from './tree.mjs';
import { sidebar } from './workbench.mjs';

/** The status bar item of aantje (the id is the extension id plus the id the extension gave the item). */
export function aantjeStatus(page) {
  return page.locator('[id="workbench.parts.statusbar"] [id="teitelberg.aantje.aantje.status"]');
}

/** The text of the status bar item of aantje, trimmed (the icon in front of it has no text). */
export async function aantjeStatusText(page) {
  return ((await aantjeStatus(page).textContent()) ?? '').trim();
}

/** The labels of the actions that a tree row shows inline (on hover), in order. */
export async function inlineActionLabels(row) {
  await row.hover();
  return row
    .locator('.actions a.action-label')
    .evaluateAll((actions) => actions.map((action) => action.getAttribute('aria-label')));
}

/** Clicks an inline action of a tree row (the icons that appear when the pointer is over the row). */
export async function clickInlineAction(row, label) {
  await row.hover();
  await row.getByRole('button', { name: label, exact: true }).click();
}

/** An action in the title bar of the aantje view ("Add Connection...", "Search Catalog...", "Refresh", "Collapse All"). */
export function titleAction(page, label) {
  return sidebar(page).locator('.composite.title .title-actions').getByRole('button', {
    name: label,
    exact: true,
  });
}

/** The labels of the title bar actions, in order. */
export function titleActionLabels(page) {
  return sidebar(page)
    .locator('.composite.title .title-actions a.action-label')
    .evaluateAll((actions) => actions.map((action) => action.getAttribute('aria-label')));
}

/**
 * Hovers over `target`, saves a screenshot while the tooltip is shown (`t.shot(label)`), and returns the text of the
 * tooltip.
 */
export async function hoverWithShot(t, target, label) {
  const { page } = t;
  // The pointer may still rest on something that has a tooltip of its own (the tab of the Activity Bar after a click):
  // wait until no tooltip is left, so that the one that appears belongs to `target`.
  const hovers = page.locator('.monaco-hover:visible');
  await awayFromTooltips(page, hovers);
  await target.hover();
  const hover = hovers.first();
  await expect(hover).toBeVisible();
  const text = await hover.innerText();
  if (label) {
    await t.shot(label);
  }
  await awayFromTooltips(page, hovers);
  return text;
}

// The middle of the editor area, which has no tooltip. The pointer is moved again on every attempt, because a tooltip that
// is about to appear for the place where the pointer was can come back once.
async function awayFromTooltips(page, hovers) {
  await eventually(async () => {
    await page.mouse.move(720, 450);
    await expect(hovers).toHaveCount(0, { timeout: 2_000 });
  });
}

/**
 * All rows of the open quick pick as { label, description, detail }, in order. A long list renders only the rows in
 * view, so this pages down until the number of rows that the list announces (aria-setsize) has been seen.
 */
export async function allPickEntries(page) {
  const q = quickInput(page);
  await expect(q.rows.first()).toBeVisible();
  const total = Number(await q.rows.first().getAttribute('aria-setsize'));
  const seen = new Map();
  await eventually(async () => {
    for (const entry of await q.entries()) {
      seen.set(entry.label, entry);
    }
    if (seen.size < total) {
      await page.keyboard.press('PageDown');
      throw new Error(`${seen.size} of ${total} rows seen`);
    }
  });
  return [...seen.values()];
}

/** The label of the row that is highlighted (active) in the open quick pick. */
export function activePickLabel(page) {
  return quickInput(page).widget.locator('.monaco-list-row.focused a.label-name').first().textContent();
}

/** The text of a color as { r, g, b, a } (Chromium reports colors as rgb() or rgba()). */
function parseColor(text) {
  const [r, g, b, a = 1] = text.match(/[\d.]+/g).map(Number);
  return { r, g, b, a };
}

const luminance = ({ r, g, b }) => {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
};

/**
 * The color that VS Code paints the icon of an Activity Bar tab with (the icon is a mask over a colored box), the
 * color of the Activity Bar behind it, and the WCAG contrast ratio between them (3:1 is the minimum for graphics).
 */
export async function activityIconContrast(page, tab) {
  const { icon, background } = await tab.evaluate((element) => {
    const label = element.querySelector('a.action-label') ?? element;
    const bar = element.closest('[id="workbench.parts.activitybar"]');
    return {
      icon: getComputedStyle(label).backgroundColor,
      background: getComputedStyle(bar).backgroundColor,
    };
  });
  const back = parseColor(background);
  const front = parseColor(icon);
  const mixed = {
    r: front.r * front.a + back.r * (1 - front.a),
    g: front.g * front.a + back.g * (1 - front.a),
    b: front.b * front.a + back.b * (1 - front.a),
  };
  const [lighter, darker] = [luminance(mixed), luminance(back)].sort((a, b) => b - a);
  return { icon, background, ratio: (lighter + 0.05) / (darker + 0.05) };
}

const COMMIT_SCRIPT = `
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const [file, name] = process.argv.slice(2);
const db = new DatabaseSync(file);
const last = db.prepare('SELECT * FROM ducklake_snapshot ORDER BY snapshot_id DESC LIMIT 1').get();
const id = last.snapshot_id + 1;
const time = new Date().toISOString().replace('T', ' ').replace('Z', '+00');
db.exec('BEGIN');
db.prepare('INSERT INTO ducklake_snapshot VALUES (?, ?, ?, ?, ?)').run(
  id, time, last.schema_version + 1, last.next_catalog_id + 1, last.next_file_id);
db.prepare('INSERT INTO ducklake_snapshot_changes (snapshot_id, changes_made) VALUES (?, ?)').run(
  id, 'created_schema:"' + name + '"');
db.prepare(
  'INSERT INTO ducklake_schema (schema_id, schema_uuid, begin_snapshot, schema_name, path, path_is_relative) VALUES (?, ?, ?, ?, ?, 1)',
).run(last.next_catalog_id, randomUUID(), id, name, name + '/');
db.exec('COMMIT');
console.log(id);
`;

/**
 * Commits a new snapshot to a SQLite DuckLake catalog in the container, as a writer of the catalog would: it creates
 * the schema `name`. Returns the id of the new snapshot. Uses the SQLite module of the Node that ships with code-server.
 */
export async function commitSchema(server, file, name) {
  await server.writeFile('/tmp/tree-features-commit.mjs', COMMIT_SCRIPT);
  const { code, stdout, stderr } = await server.exec(
    `/usr/lib/code-server/lib/node --no-warnings /tmp/tree-features-commit.mjs '${file}' '${name}'`,
  );
  if (code !== 0) {
    throw new Error(`Cannot commit to ${file}: ${stderr}`);
  }
  return Number(stdout.trim());
}

/**
 * The color that the extension gave the icon of a tree row, as VS Code wrote it into the style of the icon (`rgb(...)`;
 * empty without one). The computed color is no use: a selected row paints all its icons in the color of the selection.
 */
export function iconColor(row) {
  return row
    .locator('.custom-view-tree-node-item-icon')
    .first()
    .evaluate((icon) => icon.style.color);
}

/** True when a color is clearly green: the green channel is the largest by a margin. */
export function isGreen(color) {
  if (color === '') {
    return false;
  }
  const { r, g, b } = parseColor(color);
  return g > r + 20 && g > b + 20;
}

/**
 * Waits until the context menu of a connection that was just connected offers its connected entries (the Reports
 * submenu). The row shows its buttons a moment before the menu has the new state of the node.
 */
export async function waitForConnectedMenu(page, row) {
  await eventually(
    async () => {
      expect(await contextMenuItems(page, row)).toContain('Reports');
    },
    { timeout: 20_000 },
  );
}
