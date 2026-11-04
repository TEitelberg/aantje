import { expect } from './expect.mjs';
import { input, pick, quickInput } from './quick-input.mjs';
import { USER_DATA } from './server.mjs';

/**
 * Connection data of the PostgreSQL that run.ps1 starts for specs that read E2E_POSTGRES_* (see test/e2e/pg.ps1).
 * The password is random per run.
 */
export function postgresFromEnvironment() {
  const {
    E2E_POSTGRES_HOST,
    E2E_POSTGRES_PORT,
    E2E_POSTGRES_DATABASE,
    E2E_POSTGRES_USER,
    E2E_POSTGRES_PASSWORD,
  } = process.env;
  if (!E2E_POSTGRES_HOST || !E2E_POSTGRES_PASSWORD) {
    throw new Error(
      'E2E_POSTGRES_* is not set: run this spec with test/e2e/run.ps1, which starts PostgreSQL.',
    );
  }
  return {
    host: E2E_POSTGRES_HOST,
    port: Number(E2E_POSTGRES_PORT),
    database: E2E_POSTGRES_DATABASE,
    user: E2E_POSTGRES_USER,
    password: E2E_POSTGRES_PASSWORD,
  };
}

/**
 * Records every text that a notification (toast or entry of the notification center) shows, from now on and across
 * page loads, because a toast goes away after a few seconds and a spec may look too late. Returns the list, which
 * grows; call before the first `page.goto`.
 */
export async function recordNotifications(page) {
  const seen = [];
  await page.exposeFunction('__e2eNotificationSeen', (text) => {
    if (!seen.includes(text)) {
      seen.push(text);
    }
  });
  await page.addInitScript(() => {
    let scheduled = false;
    const scan = () => {
      scheduled = false;
      for (const message of document.querySelectorAll('.notification-list-item-message')) {
        globalThis.__e2eNotificationSeen(message.textContent ?? '');
      }
    };
    new globalThis.MutationObserver(() => {
      if (!scheduled) {
        scheduled = true;
        globalThis.requestAnimationFrame(scan);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  return seen;
}

/** The answers of the wizard for a PostgreSQL catalog, in the order in which it asks. */
export async function addPostgresConnection(
  page,
  { name, host, port, database, user, tls = 'No', password, readOnly = 'No' },
) {
  const heading = (index) => `Add Connection (${index}/9)`;
  await pick(page, 'PostgreSQL', { title: 'Add Connection: where is the DuckLake metadata stored?' });
  await input(page, name, { title: heading(1) });
  await input(page, host, { title: heading(2) });
  await input(page, String(port), { title: heading(3) });
  await input(page, database, { title: heading(4) });
  await pick(page, 'Password', { title: `${heading(5)}: How do you sign in to PostgreSQL?` });
  await input(page, user, { title: heading(6) });
  await pick(page, tls, { title: `${heading(7)}: Use TLS for the connection?` });
  await input(page, password, { title: heading(8) });
  await pick(page, readOnly, { title: `${heading(9)}: Open SQL editor sessions read-only?` });
}

/** Waits for the question for the password of a connection and returns its prompt text. */
export async function expectPasswordPrompt(page, name) {
  const q = quickInput(page);
  await expect(q.title).toHaveText(`Password for "${name}"`);
  await expect(q.input).toHaveAttribute('type', 'password');
  // VS Code appends the hint for the keys to the prompt text.
  return (await q.message.textContent()).replace(/ \(Press 'Enter'.*\)$/, '').trim();
}

/**
 * Every file below the user data directory of the server that contains `text` (searched as binary, so SQLite files
 * count too), as paths. A password in a settings file or a log would show up here.
 */
export async function filesContaining(server, text) {
  const { code, stdout } = await server.exec(`grep -rlaF -- '${text}' ${USER_DATA} 2>/dev/null; true`);
  if (code !== 0) {
    throw new Error('grep failed');
  }
  return stdout.split('\n').filter(Boolean).sort();
}

/** Clicks the inline action (the small button that appears on hover) of a tree row, for example "Connect". */
export async function clickInlineAction(page, row, label) {
  await row.hover();
  await row.getByRole('button', { name: label, exact: true }).click();
}

/** The aantje logs of every session of the server (each start of code-server writes its own), as one text. */
export async function allAantjeLogs(server) {
  const { stdout } = await server.exec(
    `find ${USER_DATA}/logs -path '*/teitelberg.aantje/aantje.log' -exec cat {} +; true`,
  );
  return stdout;
}
