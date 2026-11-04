import { activeTab, editorText } from './editor.mjs';
import { expect } from './expect.mjs';
import { webview } from './data-features-support.mjs';

/** The editor tab of a report panel, found by (a part of) its title, for example `Properties · History`. */
export function panelTab(page, title) {
  return page.getByRole('tab', { name: title });
}

/** Brings the panel with this title to the front and waits until its page shows. */
export async function showPanel(page, title) {
  const tab = panelTab(page, title);
  await expect(tab).toHaveCount(1);
  if ((await tab.getAttribute('aria-selected')) !== 'true') {
    await tab.click();
  }
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  return webview(page);
}

/** The key figures of the page as { label, value, detail, warning }. */
export function readCards(frame) {
  return frame.locator('.card').evaluateAll((cards) =>
    cards.map((card) => ({
      label: card.querySelector('.card-label')?.textContent ?? '',
      value: card.querySelector('.card-value')?.textContent ?? '',
      detail: card.querySelector('.card-detail')?.textContent ?? '',
      warning: card.classList.contains('warning'),
    })),
  );
}

/** The cards as a map from label to value. */
export async function cardValues(frame) {
  return Object.fromEntries((await readCards(frame)).map(({ label, value }) => [label, value]));
}

/** The rows of the first table of the page, or of `selector`, as lists of cell texts. */
export function readTable(frame, selector = 'table') {
  return frame
    .locator(`${selector} tbody tr`)
    .evaluateAll((rows) =>
      rows.map((row) => [...row.querySelectorAll('td,th')].map((cell) => cell.textContent.trim())),
    );
}

/** The canvases of the page and how many of their pixels are drawn (not transparent): a chart that is on the screen. */
export function drawnCanvases(frame) {
  return frame.locator('body').evaluate((body) =>
    [...body.querySelectorAll('canvas')].map((canvas) => {
      const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
      let drawn = 0;
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] !== 0) drawn++;
      }
      return { width: canvas.width, height: canvas.height, drawn };
    }),
  );
}

/** Waits until the page has at least `count` canvases with something drawn on them. */
export async function expectDrawnCharts(frame, count = 1) {
  await expect
    .poll(async () => (await drawnCanvases(frame)).filter(({ drawn }) => drawn > 1000).length)
    .toBeGreaterThanOrEqual(count);
}

/**
 * Presses "Open as Markdown" in the header of the panel and returns the text of the untitled Markdown document that
 * opens. The panel tab comes back to the front afterwards.
 */
export async function openAsMarkdown(page, frame, panelTitle) {
  await frame.getByRole('button', { name: /^Open as Markdown/ }).click();
  await expect(activeTab(page)).toContainText(/Untitled-\d+/);
  const text = await editorText(page);
  await showPanel(page, panelTitle);
  return text;
}

/** Collects the content security policy messages of the browser console. */
export function watchCspViolations(page) {
  const violations = [];
  page.on('console', (message) => {
    if (/content security policy|violates/i.test(message.text())) {
      violations.push(message.text().split('\n')[0]);
    }
  });
  return violations;
}
