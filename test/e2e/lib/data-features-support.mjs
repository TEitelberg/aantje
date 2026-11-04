import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { installDuckdbApi } from './duckdb-api.mjs';
import { eventually, expect } from './expect.mjs';
import { quickInput, runCommand } from './quick-input.mjs';
import { PROJECT } from './server.mjs';

/** The data fixture (test/fixtures/data) as a copy in the project folder, with its data path rewritten. */
export const DATA = `${PROJECT}/data`;
export const NODE = '/usr/lib/code-server/lib/node';
const TOOL = '/tmp/data-features-tool.mjs';
const quote = (text) => `'${String(text).replaceAll("'", `'\\''`)}'`;

/**
 * The address and the keys of the S3 server that run.ps1 started for this spec (E2E_S3_*). Throws with a pointer to
 * run.ps1 when they are missing, like postgresFromEnvironment does for PostgreSQL.
 */
export function s3FromEnvironment() {
  const {
    E2E_S3_HOST: host,
    E2E_S3_PORT: port,
    E2E_S3_ACCESS_KEY: keyId,
    E2E_S3_SECRET_KEY: secretKey,
  } = process.env;
  if (!host || !port || !keyId || !secretKey) {
    throw new Error(
      'E2E_S3_* is not set. Run the spec with test/e2e/run.ps1: it starts the S3 server and passes them.',
    );
  }
  return { host, port: Number(port), endpoint: `http://${host}:${port}`, keyId, secretKey };
}

/**
 * Runs a shell command in the code-server container and waits for it to end. The control API of the server cuts a
 * command off after 30 s, so the command runs in the background and its exit code is polled. Resolves to
 * { code, output } (stdout and stderr together); a failing command does not throw.
 */
export async function runLong(server, command, { timeoutSeconds = 240 } = {}) {
  const id = Math.random().toString(36).slice(2);
  const base = `/tmp/long-${id}`;
  await server.exec(
    `(setsid sh -c ${quote(`( ${command} ) > ${base}.out 2>&1; echo $? > ${base}.code`)} < /dev/null > /dev/null 2>&1 &)`,
  );
  let code;
  await eventually(
    async () => {
      const { code: seen, stdout } = await server.exec(`cat ${base}.code 2>/dev/null`);
      if (seen !== 0 || stdout.trim() === '') {
        throw new Error(`still running: ${command.slice(0, 80)}`);
      }
      code = Number(stdout.trim());
    },
    { timeout: timeoutSeconds * 1000, intervals: [1000] },
  );
  const output = (await server.exec(`cat ${base}.out`)).stdout;
  await server.exec(`rm -f ${base}.out ${base}.code`);
  return { code, output };
}

/** Copies the tool program that runs in the container (data-features-tool.mjs) there. */
export async function installTool(server) {
  await installDuckdbApi(server);
  await server.writeFile(TOOL, readFileSync(new URL('./data-features-tool.mjs', import.meta.url), 'utf8'));
}

/** Runs the tool; throws with its output when it fails. `env` is a map of environment variables for the program. */
export async function runTool(server, args, { env = {}, timeoutSeconds } = {}) {
  const variables = Object.entries(env).map(([name, value]) => `${name}=${quote(value)}`);
  const { code, output } = await runLong(
    server,
    `${variables.join(' ')} ${NODE} --no-warnings ${TOOL} ${args.map(quote).join(' ')}`,
    {
      timeoutSeconds,
    },
  );
  if (code !== 0) {
    throw new Error(`data-features-tool ${args[0]} failed with exit code ${code}:\n${output}`);
  }
  return output;
}

/**
 * Puts the data fixture catalogs (DuckLakes with their Parquet files) into the project folder. The checked-in data
 * path is relative to the working directory of the reader, which is not the one of the extension host, so the copy gets
 * the absolute path of its own files (test/fixtures/data/README.md).
 */
export async function installDataFixture(server) {
  await installTool(server);
  const { code, stderr } = await server.exec(
    `rm -rf ${DATA} && mkdir -p ${DATA} && cp -r /e2e/fixtures/data/sqlite-files /e2e/fixtures/data/data-catalog.sqlite ${DATA}/ && chmod -R u+w ${DATA}`,
  );
  if (code !== 0) {
    throw new Error(`Cannot copy the data fixture: ${stderr}`);
  }
  await runTool(server, [
    'sqlite',
    `${DATA}/data-catalog.sqlite`,
    `UPDATE ducklake_metadata SET value = '${DATA}/sqlite-files/' WHERE key = 'data_path'`,
  ]);
}

/**
 * The content of the web view of the visible editor tab. A web view is an iframe of the workbench that holds a second
 * one with the page of the extension; this is a locator for the inner one.
 */
export function webview(page) {
  return page.frameLocator('iframe.webview.ready:visible').frameLocator('iframe#active-frame');
}

/**
 * What the grid of aantje shows now: the column headers { name, type, sort } ('asc', 'desc' or ''), the rows as lists of
 * cells { text, isNull } (without the row number), the row numbers, and the text of the status line.
 */
export async function readGrid(page) {
  const frame = webview(page);
  await expect(frame.locator('table')).toBeVisible();
  return frame.locator('body').evaluate((body) => {
    // A grid of changes has a column with the mark of the row behind the row number.
    const lead = body.querySelector('thead th.mk') ? 2 : 1;
    const headers = [...body.querySelectorAll('thead th')].slice(lead).map((th) => ({
      name: th.querySelector('.name')?.textContent ?? '',
      type: th.querySelector('.type')?.textContent ?? '',
      sort: { ascending: 'asc', descending: 'desc' }[th.getAttribute('aria-sort') ?? ''] ?? '',
    }));
    const trs = [...body.querySelectorAll('tbody tr')];
    const rows = trs.map((tr) =>
      [...tr.querySelectorAll('td')].slice(lead).map((td) => ({
        text: td.textContent ?? '',
        isNull: td.classList.contains('null'),
      })),
    );
    const numbers = trs.map((tr) => tr.querySelector('td')?.textContent ?? '');
    return {
      headers,
      rows,
      numbers,
      status: body.querySelector('.status')?.textContent ?? '',
      // Only a grid of changes has these: the kind of each row (chg-insert, ...), its mark, the changed cells, the summary.
      kinds: trs.map((tr) => [...tr.classList].find((name) => name.startsWith('chg-'))?.slice(4) ?? ''),
      marks: trs.map((tr) => tr.querySelector('td.mk')?.textContent ?? ''),
      changed: trs.map((tr) =>
        [...tr.querySelectorAll('td')]
          .slice(lead)
          .flatMap((td, index) => (td.classList.contains('changed') ? [index] : [])),
      ),
      summary: body.querySelector('.summary')?.textContent ?? '',
      sorters: body.querySelectorAll('thead th button').length,
      filters: body.querySelectorAll('thead th input').length,
    };
  });
}

/** The rows of the grid as plain text, NULL cells as the text 'NULL'. */
export async function gridTexts(page) {
  return (await readGrid(page)).rows.map((row) => row.map((cell) => cell.text));
}

/**
 * The editor tabs of the data grids of aantje. The title names the table, the limit, the connection and the snapshot:
 * "sales.orders (top 1000) · Data lake @13". With `title` it is the tab with exactly that title.
 */
export function gridTab(page, title) {
  return page.getByRole(
    'tab',
    title === undefined ? { name: / \(top 1000\) · .+ @\d+$/ } : { name: title, exact: true },
  );
}

/** The editor tabs of the grids of the changes of a table ("shop.customers changes @15 → @18 · Data lake"). */
export function changesTab(page, title) {
  return page.getByRole(
    'tab',
    title === undefined ? { name: / changes @\d+ → @\d+ · / } : { name: title, exact: true },
  );
}

/**
 * The history fixture (test/fixtures/history: 57 snapshots with real Parquet files) as a copy in the project folder,
 * with its data path rewritten as `installDataFixture` does it. Returns the path of the SQLite catalog.
 */
export async function installHistoryFixture(server) {
  await installTool(server);
  const folder = `${PROJECT}/history`;
  const { code, stderr } = await server.exec(
    `rm -rf ${folder} && mkdir -p ${folder} && cp -r /e2e/fixtures/history/sqlite-files /e2e/fixtures/history/history.sqlite ${folder}/ && chmod -R u+w ${folder}`,
  );
  if (code !== 0) {
    throw new Error(`Cannot copy the history fixture: ${stderr}`);
  }
  await runTool(server, [
    'sqlite',
    `${folder}/history.sqlite`,
    `UPDATE ducklake_metadata SET value = '${folder}/sqlite-files/' WHERE key = 'data_path'`,
  ]);
  return `${folder}/history.sqlite`;
}

/** The Jupyter extension that the specs install; the version that fits the VS Code of the pinned code-server. */
export const JUPYTER = 'ms-toolsai.jupyter@2025.9.1';

/**
 * Installs the Jupyter extension, with its pack, from Open VSX into the extensions folder of the container, and
 * restarts code-server so that it loads them. Open the workbench again afterwards.
 */
export async function installJupyter(server) {
  const { code, output } = await runLong(
    server,
    `mkdir -p /tmp/jupyter-install && code-server --config /tmp/jupyter-install/config.yaml --user-data-dir /tmp/jupyter-install --extensions-dir /home/coder/extensions --install-extension ${JUPYTER}; status=$?; rm -rf /tmp/jupyter-install; exit $status`,
    { timeoutSeconds: 240 },
  );
  if (code !== 0 || !output.includes("'ms-toolsai.jupyter' v")) {
    throw new Error(`Installing ${JUPYTER} failed with exit code ${code}:\n${output}`);
  }
  await server.restart();
}

/**
 * Saves the active editor with "File: Save" and answers the save dialog of the workbench (a prompt, not a window) with
 * this path. The dialog suggests a path first and completes what is typed, so the value is checked before Enter.
 */
export async function saveAs(page, path) {
  const q = quickInput(page);
  await runCommand(page, 'File: Save');
  await expect(q.input).toHaveValue(/\/[^/]+\.\w+$/);
  await eventually(async () => {
    await q.input.press('Control+a');
    await q.input.fill(path);
    await expect(q.input).toHaveValue(path, { timeout: 1_500 });
  });
  await page.keyboard.press('Enter');
  await expect(q.widget).toBeHidden();
}

/**
 * A signed request to the S3 server from inside the code-server container (curl does the signature version 4).
 * Resolves to { status, body }.
 */
export async function s3Request(server, s3, method, path) {
  const { stdout, stderr, code } = await server.exec(
    `curl -sS --aws-sigv4 'aws:amz:us-east-1:s3' --user ${quote(`${s3.keyId}:${s3.secretKey}`)} -X ${method} -w '\n%{http_code}' ${quote(`${s3.endpoint}${path}`)}`,
  );
  if (code !== 0) {
    throw new Error(`curl ${method} ${path} failed: ${stderr}`);
  }
  const split = stdout.lastIndexOf('\n');
  return { status: Number(stdout.slice(split + 1)), body: stdout.slice(0, split) };
}
