import { eventually, expect } from './expect.mjs';

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The Quick Input widget: VS Code uses it for the Command Palette, for quick picks (`showQuickPick`) and for input
 * boxes (`showInputBox`). Only one prompt is open at a time.
 */
export function quickInput(page) {
  const widget = page.locator('.quick-input-widget');
  const rows = widget.locator('.monaco-list-row[role="option"]');
  return {
    widget,
    /** The text field: the filter of a pick, the value of an input box. */
    input: widget.locator('input.input'),
    rows,
    /** The title of the prompt, as the extension set it. Not shown (and empty) when the extension gave none. */
    title: widget.locator('.quick-input-title'),
    /** The prompt text of an input box, or its validation error. */
    message: widget.locator('.quick-input-message'),
    /** The row whose label is exactly `label` (the first one when there are several). */
    row: (label) =>
      rows
        .filter({
          has: page.locator('a.label-name').filter({ hasText: new RegExp(`^${escapeRegExp(label)}$`) }),
        })
        .first(),
    /** The labels of the rows that are shown now, in order (not their descriptions). */
    labels: () => labelsOf(rows),
    /** The rows that are shown now as { label, description, detail }, in order. */
    entries: () => entriesOf(rows),
  };
}

function labelsOf(rows) {
  return rows.evaluateAll((elements) =>
    elements.map((row) => row.querySelector('a.label-name')?.textContent ?? ''),
  );
}

function entriesOf(rows) {
  return rows.evaluateAll((elements) =>
    elements.map((row) => {
      // The first line of a row holds label and description, the second one the detail.
      const [first, second] = row.querySelectorAll('.quick-input-list-row');
      return {
        label: first?.querySelector('a.label-name')?.textContent ?? '',
        description: first?.querySelector('.label-description')?.textContent ?? '',
        detail: second?.querySelector('a.label-name')?.textContent ?? '',
      };
    }),
  );
}

/**
 * Clicks the row whose label is exactly `label`. The row is looked up again for every attempt, because the list
 * filters while text is typed and a row that was found a moment ago can be gone. A long list renders only the rows in
 * view: with `filter` the label is typed into the filter of the pick when the row is not there.
 */
async function clickRow(q, label, { timeout, filter = false } = {}) {
  const row = q.row(label);
  await eventually(
    async () => {
      if ((await row.count()) === 0) {
        const labels = await q.labels();
        if (filter && (await q.input.isVisible())) {
          await q.input.fill(label);
        }
        throw new Error(`no row "${label}" among ${JSON.stringify(labels)}`);
      }
      await row.click({ timeout: 2_000 });
    },
    { timeout },
  );
}

/** Waits until the prompt that had the title `before` is closed or replaced; says why when the value was refused. */
async function waitUntilAnswered(q, before) {
  await eventually(async () => {
    if (!(await q.widget.isVisible())) {
      return;
    }
    if ((await q.title.textContent()) !== before) {
      return;
    }
    const message = (await q.message.textContent())?.trim();
    throw new Error(`the prompt "${before}" is still open${message ? `: ${message}` : ''}`);
  });
}

/**
 * Runs a command from the Command Palette by its title as the palette shows it, for example
 * 'aantje: Add Connection...'. Returns when the palette is gone; the command itself runs on, and a command that asks
 * a question has its prompt open by then or shortly after (wait for it with `pick` or `input`).
 *
 * Right after the workbench has loaded, the palette still lacks commands that are registered a moment later, and a
 * palette that is open does not rebuild its list. So every attempt opens the palette anew, for up to 45 s.
 */
export async function runCommand(page, title) {
  const q = quickInput(page);
  const typed = `>${title}`;
  await expect(q.widget, 'no other prompt may be open').toBeHidden();
  await eventually(
    async () => {
      if (await q.widget.isVisible()) {
        await page.keyboard.press('Escape');
        await expect(q.widget).toBeHidden({ timeout: 2_000 });
      }
      await page.keyboard.press('F1');
      await expect(q.widget).toBeVisible({ timeout: 2_000 });
      await q.input.fill(typed);
      await clickRow(q, title, { timeout: 3_000 });
    },
    { timeout: 45_000 },
  );
  // The palette closes, or a prompt of the command takes its place.
  await eventually(async () => {
    if ((await q.widget.isVisible()) && (await q.input.inputValue()) === typed) {
      throw new Error(`the Command Palette still shows "${typed}"`);
    }
  });
}

/**
 * Answers a quick pick by clicking the row with this label. With `title`, the pick must have this title (string or
 * RegExp), so that a prompt is never answered by mistake. Returns when the prompt is closed or replaced.
 */
export async function pick(page, label, { title } = {}) {
  const q = quickInput(page);
  await expect(q.widget).toBeVisible();
  if (title !== undefined) {
    await expect(q.title).toHaveText(title);
  }
  const before = await q.title.textContent();
  await clickRow(q, label, { filter: true });
  await waitUntilAnswered(q, before);
}

/**
 * Answers an input box: types the text and presses Enter. With `title`, the box must have this title. Returns when the
 * prompt is closed or replaced; when the extension refuses the value, it fails and quotes the validation message.
 */
export async function input(page, text, { title } = {}) {
  const q = quickInput(page);
  await expect(q.widget).toBeVisible();
  if (title !== undefined) {
    await expect(q.title).toHaveText(title);
  }
  const before = await q.title.textContent();
  await q.input.fill(text);
  await page.keyboard.press('Enter');
  await waitUntilAnswered(q, before);
}

/** Closes the open prompt with Escape, as a user who cancels. */
export async function cancelPrompt(page) {
  const q = quickInput(page);
  await expect(q.widget).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(q.widget).toBeHidden();
}
