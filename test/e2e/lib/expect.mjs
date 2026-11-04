import { expect as playwrightExpect } from '@playwright/test';

const TIMEOUT_MS = 15_000;

/**
 * Playwright's `expect`: web-first assertions on locators that retry until they hold, and `expect.poll` for values
 * that are read with a function. The timeout is longer than Playwright's default because a workbench in a
 * container needs time, for example for the first start of the extension host.
 *
 * For a block of several steps use `eventually`, not `expect(block).toPass()`: toPass has no timeout by default.
 */
export const expect = playwrightExpect.configure({ timeout: TIMEOUT_MS });

/**
 * Runs `block` again and again until it does not throw, for at most `timeout` ms (15 s unless given), and then
 * rethrows the last error. Use it for a sequence that has to be repeated as a whole, for example "find the row,
 * then click it".
 *
 * This is `expect(block).toPass({ timeout })` with a timeout that cannot be forgotten: without one, toPass retries
 * for ever, even when the page is gone, and the spec hangs until the runner gives up on it.
 */
export function eventually(block, { timeout = TIMEOUT_MS, intervals } = {}) {
  return expect(block).toPass({ timeout, intervals });
}
