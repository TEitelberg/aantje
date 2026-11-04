import { expect } from './expect.mjs';
import { webview } from './data-features-support.mjs';

/** The status bar item of the SQL editor (the extension id plus the id the extension gave the item). */
export function queryStatus(page) {
  return page.locator('[id="workbench.parts.statusbar"] [id="teitelberg.aantje.aantje.queryStatus"]');
}

/** The text of the status bar item of the SQL editor, trimmed. */
export async function queryStatusText(page) {
  return ((await queryStatus(page).textContent()) ?? '').trim();
}

/**
 * What the results panel of the SQL editor shows now: the tabs with their selection, the line of the run, the
 * statements of the Messages tab (mark, number, text, result, time), the errors, and the grid of a selected result tab.
 */
export async function readResults(page) {
  const frame = webview(page);
  await expect(frame.locator('.tabbar .tabs[role=tablist]')).toBeVisible();
  return frame.locator('body').evaluate((body) => {
    const text = (node) => node?.textContent ?? '';
    const tabs = [...body.querySelectorAll('.tabbar .tabs[role=tablist] button.tab[role=tab]')].map(
      (tab) => ({
        label: text(tab),
        selected: tab.getAttribute('aria-selected') === 'true',
      }),
    );
    const statements = [...body.querySelectorAll('table.messages tr.stmt')].map((row) => {
      const cells = row.querySelectorAll('td');
      return {
        status: cells[0]?.getAttribute('aria-label') ?? '',
        number: text(row.querySelector('td.rn')),
        sql: text(row.querySelector('td.sql')),
        result: text(cells[3]),
        time: text(row.querySelector('td.num')),
      };
    });
    const errors = [...body.querySelectorAll('table.messages tr.err td.error')].map((cell) => ({
      message: text(cell.querySelector('.message')),
      hasGoTo: [...cell.querySelectorAll('button')].some((button) => text(button) === 'Go to statement'),
    }));
    const result = body.querySelector('.result');
    const headers = [...body.querySelectorAll('.result thead th')].slice(1).map((th) => ({
      name: text(th.querySelector('.name')),
      type: text(th.querySelector('.type')),
    }));
    const rows = [...body.querySelectorAll('.result tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].slice(1).map((td) => ({
        text: text(td),
        isNull: td.classList.contains('null'),
      })),
    );
    return {
      tabs,
      run: text(body.querySelector('.run')),
      statements,
      errors,
      result: result
        ? {
            sql: text(result.querySelector('.sql')),
            banner: text(result.querySelector('.banner')),
            headers,
            rows,
            status: text(result.querySelector('.status')),
            hasToolbar: result.querySelector('.toolbar') !== null,
          }
        : undefined,
    };
  });
}

/** Clicks a tab of the results panel by its label. */
export async function openResultTab(page, label) {
  const tab = webview(page).getByRole('tab', { name: label, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/**
 * Clears the line that tells how the last run ended, so that a spec that waits for "Completed in ..." after the next
 * run cannot be satisfied by the text of the run before. The panel writes the line again when the next run begins.
 */
export async function forgetRun(page) {
  const line = webview(page).locator('.run');
  if ((await line.count()) > 0) {
    await line.evaluate((element) => {
      element.textContent = '';
    });
  }
}
