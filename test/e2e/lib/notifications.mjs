import { eventually, expect } from './expect.mjs';
import { runCommand } from './quick-input.mjs';

const MESSAGES = '.notifications-toasts .notification-toast .notification-list-item-message';

/** The messages of the notification toasts that are shown now (information, warnings, errors, progress). */
export function notificationTexts(page) {
  return page.locator(MESSAGES).allTextContents();
}

/**
 * Waits for a toast whose message equals `expected` (string) or matches it (RegExp) and returns the message. Toasts
 * of information and progress go away after a few seconds, so call this right after the action.
 */
export async function waitForNotification(page, expected) {
  let found;
  await eventually(async () => {
    const texts = await notificationTexts(page);
    found = texts.find((text) => (typeof expected === 'string' ? text === expected : expected.test(text)));
    if (found === undefined) {
      throw new Error(`no notification matches ${expected}; shown: ${JSON.stringify(texts)}`);
    }
  });
  return found;
}

/** Clears all notifications, like the command "Notifications: Clear All Notifications". */
export async function dismissNotifications(page) {
  await runCommand(page, 'Notifications: Clear All Notifications');
  await expect(page.locator(MESSAGES)).toHaveCount(0);
}

/**
 * Answers a modal dialog (`showWarningMessage` with `{ modal: true }`) by clicking the button with this label. With
 * `message`, the text of the dialog must match (string: contained, RegExp: matches).
 */
export async function answerDialog(page, button, { message } = {}) {
  const dialog = page.locator('.monaco-dialog-box');
  await expect(dialog).toBeVisible();
  if (message !== undefined) {
    await expect(dialog).toContainText(message);
  }
  await dialog.getByRole('button', { name: button, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** The labels of the buttons of the toast whose message matches `expected` (RegExp or string, contained). */
export async function notificationButtons(page, expected) {
  const toast = page.locator('.notifications-toasts .notification-toast').filter({ hasText: expected });
  await expect(toast).toHaveCount(1);
  return (await toast.getByRole('button').allTextContents()).map((label) => label.trim()).filter(Boolean);
}

/** Presses a button of the toast whose message matches `expected`. */
export async function pressNotificationButton(page, expected, label) {
  const toast = page.locator('.notifications-toasts .notification-toast').filter({ hasText: expected });
  await expect(toast).toHaveCount(1);
  await toast.getByRole('button', { name: label, exact: true }).click();
}
