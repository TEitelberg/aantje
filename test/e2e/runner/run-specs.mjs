// Runs the specs of test/e2e/specs in the Playwright container (started by test/e2e/run.ps1).
//
//   node run-specs.mjs [spec ...]     no argument runs every spec
//
// A spec is a module that exports `title` (optional) and a default async function that gets the context `t`
// (see docs/en/e2e-tests.md). Every spec gets a clean code-server (control API /reset) and a browser context of its
// own. Results: <E2E_OUT>/<spec>.json, screenshots <spec>-<nn>-<label>.png, and, for a failed spec, a Playwright
// trace (<spec>.trace.zip) and the log of the aantje output channel (<spec>.aantje.log).
import { chromium } from '@playwright/test';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { URL } from 'node:url';
import { serverControl } from '../lib/server.mjs';

const url = process.env.E2E_URL;
const out = process.env.E2E_OUT ?? '/out';
const server = serverControl(process.env.E2E_CONTROL);
const specsDirectory = new URL('../specs/', import.meta.url);
const SPEC_TIMEOUT_MS = Number(process.env.E2E_SPEC_TIMEOUT_SECONDS ?? 300) * 1000;

const requested = process.argv.slice(2);
const names = requested.length > 0 ? requested : await specNames();
await mkdir(out, { recursive: true });

// A user reaches code-server as http://localhost:8443, which browsers treat as a secure context. The test server is
// reached by its container name, so the flag makes that origin secure as well; without it the clipboard and the web
// views (the README on the details page of an extension) do not work. The headless shell ignores the flag, hence
// the channel: the full Chromium in its headless mode.
const browser = await chromium.launch({
  channel: 'chromium',
  args: [`--unsafely-treat-insecure-origin-as-secure=${new URL(url).origin}`],
});
console.log(`chromium ${browser.version()}, ${names.length} spec(s) against ${url}`);
let failed = 0;
for (const name of names) {
  failed += (await runSpec(name)) ? 0 : 1;
}
await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 10_000))]);
// A spec that was cut off by its timeout may have left promises behind: do not wait for them.
process.exit(failed === 0 ? 0 : 1);

async function specNames() {
  return (await readdir(specsDirectory))
    .filter((file) => file.endsWith('.mjs'))
    .map((file) => file.slice(0, -'.mjs'.length))
    .sort();
}

async function removeOldOutput(name) {
  for (const file of await readdir(out)) {
    if (file === `${name}.json` || file.startsWith(`${name}-`) || file.startsWith(`${name}.`)) {
      await rm(join(out, file), { force: true });
    }
  }
}

/** Runs one spec and writes its result. Returns whether it passed. */
async function runSpec(name) {
  console.log(`\n== ${name}`);
  await removeOldOutput(name);
  const result = {
    spec: name,
    title: name,
    ok: false,
    startedAt: new Date().toISOString(),
    steps: [],
    warnings: [],
    screenshots: [],
  };
  const started = Date.now();
  const consoleLines = [];
  let context;
  let page;
  let timer;

  try {
    const module = await import(new URL(`${name}.mjs`, specsDirectory));
    result.title = module.title ?? name;
    await server.reset();
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: 'light',
      locale: 'en-US',
      timezoneId: 'UTC',
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin });
    await context.tracing.start({ screenshots: true, snapshots: true });
    page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) {
        consoleLines.push(`[${message.type()}] ${message.text().split('\n')[0]}`);
      }
    });
    page.on('pageerror', (error) => consoleLines.push(`[pageerror] ${error.message}`));

    // The spec may ignore a closed page and retry for ever, so the timeout does not wait for it to end.
    const running = module.default(specContext({ name, url, page, context, result }));
    running.catch(() => undefined);
    await Promise.race([
      running,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The spec did not finish within ${SPEC_TIMEOUT_MS / 1000} s.`)),
          SPEC_TIMEOUT_MS,
        );
      }),
    ]);
    result.ok = true;
  } catch (error) {
    result.error = describe(error);
    await attachDiagnostics(name, result, page, context);
  } finally {
    clearTimeout(timer);
    await Promise.race([
      context?.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    result.durationMs = Date.now() - started;
    await writeFile(join(out, `${name}.json`), `${JSON.stringify(result, undefined, 2)}\n`);
    if (consoleLines.length > 0) {
      await writeFile(join(out, `${name}.console.log`), `${consoleLines.join('\n')}\n`);
    }
  }
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${name} (${(result.durationMs / 1000).toFixed(1)} s)`);
  return result.ok;
}

/** What a spec gets: the page, the helpers that need the result, and the control of the server. */
function specContext({ name, url: base, page, context, result }) {
  let screenshotCount = 0;
  return {
    name,
    url: base,
    page,
    context,
    server,
    out,

    /** Runs one named part of the spec. The first failing step ends the spec. */
    async step(title, run) {
      const entry = { name: title, ok: false, durationMs: 0 };
      result.steps.push(entry);
      const started = Date.now();
      console.log(`  ... ${title}`);
      try {
        await run();
        entry.ok = true;
      } catch (error) {
        entry.error = describe(error);
        throw error;
      } finally {
        entry.durationMs = Date.now() - started;
      }
      console.log(`  ok  ${title} (${(entry.durationMs / 1000).toFixed(1)} s)`);
    },

    /**
     * Saves a screenshot as <spec>-<nn>-<label>.png and returns the file name. The target is the page (default), a
     * locator, or an object with a `clip` rectangle in page coordinates (see `around` in lib/screenshots.mjs).
     */
    async shot(label, target = page) {
      const file = `${name}-${String(++screenshotCount).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
      const isTarget = typeof target.screenshot === 'function';
      await (isTarget ? target : page).screenshot({ path: join(out, file), ...(isTarget ? {} : target) });
      result.screenshots.push(file);
      return file;
    },

    /**
     * Records a finding that does not fail the spec, for a known defect of the product that has to stay visible. The
     * warning is printed in the summary of run.ps1 and stored in the result file.
     */
    warn(message) {
      result.warnings.push(message);
      console.log(`  WARN ${message}`);
    },
  };
}

async function attachDiagnostics(name, result, page, context) {
  const attempt = async (action) => {
    try {
      await action();
    } catch {
      // The diagnostics are a bonus: never hide the real failure behind a failed screenshot.
    }
  };
  await attempt(async () => {
    const file = `${name}-FAILED.png`;
    await page.screenshot({ path: join(out, file) });
    result.screenshots.push(file);
  });
  await attempt(() => context.tracing.stop({ path: join(out, `${name}.trace.zip`) }));
  await attempt(async () => {
    const log = await server.readLog('teitelberg.aantje/aantje.log');
    if (log) {
      await writeFile(join(out, `${name}.aantje.log`), log);
    }
  });
}

function describe(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
