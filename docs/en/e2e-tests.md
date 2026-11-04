# End-to-end tests

The end-to-end tests run aantje where it is used in production: in code-server, in a browser. A real Chromium opens the workbench, replays a user's steps (open the view, run a command, answer a prompt, expand the tree) and the specs check what is on screen. Everything runs in Docker; `test/e2e/run.ps1` starts it and removes it again.

## Why a third kind of test

The [extension-host tests](integration-tests.md) run the extension in desktop VS Code with scripted prompts. They cannot see what only the whole product does:

- the Linux package with its native DuckDB engine, installed from the VSIX into code-server (Node, no Electron);
- the browser workbench: Activity Bar icon, the details page with the README, quick picks, context menu, tooltips, modal dialogs and the clipboard;
- machine-scoped settings, which code-server keeps in the `Machine/settings.json` of its user data directory;
- a restart of the server with the data on a volume;
- a real PostgreSQL server and an S3 server on the Docker network, with the password prompt and the browser's secret storage ([below](#the-secret-storage-belongs-to-the-browser)).

## Running

```powershell
npm run test:e2e
npm run test:e2e -- -Spec smoke
.\test\e2e\run.ps1 -Spec smoke,helpers -Keep
.\test\e2e\run.ps1 -Spec smoke -Reuse
.\test\e2e\run.ps1 -Up
.\test\e2e\run.ps1 -Clean
```

`npm run test:e2e` is `pwsh -NoProfile -File test/e2e/run.ps1`; what follows `--` goes to the script.

Prerequisites: PowerShell 7, Docker with Linux containers and the package `artifacts/aantje-linux-x64-<version>.vsix` (`npm run package:linux`, or add `-Rebuild`). The script warns when the package is older than the sources. The first run pulls the Playwright image (about 3.6 GB) and builds a small runner image; PostgreSQL and S3 images are pulled when a spec needs them. One spec downloads DuckDB extensions and the Jupyter extension, so it needs network access from the code-server container. A run of all specs takes about fifteen minutes.

The script prints PASS or FAIL per spec with the failed step and exits with 1 when a spec failed. It removes everything it created, also after a failure.

| Parameter             | Effect                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `-Spec`               | Spec names without extension, comma separated, or `all` (default).                                                                 |
| `-Keep`               | Leaves code-server, volume, network and databases in place and prints the address of the workbench.                                |
| `-Reuse`              | Runs against the environment that `-Keep` left (creates it if missing) and leaves it. The quick way to repeat a spec.              |
| `-Up`                 | Only starts the environment and prints the address, for manual experiments.                                                        |
| `-Clean`              | Removes the environment of an earlier run and stops.                                                                               |
| `-Instance <name>`    | A name for all Docker resources (`aantje-test-e2e-<name>-*`), so several people can run at once. They still share `test/e2e/out/`. |
| `-Vsix <path>`        | Installs another package, for example a modified copy.                                                                             |
| `-SpecTimeoutSeconds` | How long one spec may take (10 to 3600, default 600).                                                                              |
| `-Rebuild`            | Builds the linux-x64 package first.                                                                                                |
| `-RemoveImages`       | Also removes the runner image.                                                                                                     |

A second run while an environment exists is refused with a message that names the way out: `-Reuse`, `-Clean` or another `-Instance`.

## When to run which tests

- Unit tests and extension-host tests on every change.
- One targeted spec when its area changed (layout, reports, health, and so on). Run only that spec.
- The complete suite only before a minor or major release, or on request.

## How the harness is built

Docker resources are named `aantje-test-e2e-*` (with `-Instance <name>`: `aantje-test-e2e-<name>-*`): a network, a volume for the user data directory, code-server, the runner, and PostgreSQL and an S3 server (RustFS) only when a spec needs them. None of them publishes a port except code-server, which listens on `127.0.0.1` at a random port.

- **code-server** is the image `codercom/code-server:4.144.0` without authentication, telemetry, update check or workspace trust. `--enable-remote-storage` is left out on purpose: without it the secret storage is the browser's. Default user and machine settings are copied from `test/e2e/server` into the user data directory.
- **The extension** is installed from the VSIX with `code-server --install-extension`.
- **The project folder** `/home/coder/project` holds copies of the fixtures, so nothing can damage the checked-in files.
- **The runner** is the Playwright image with `@playwright/test`. It reaches code-server by container name on the network. Chromium is started with `--unsafely-treat-insecure-origin-as-secure` for that origin, so the clipboard and the README web view work; `openWorkbench` asserts a secure context.

A run:

1. Checks the package, builds the runner image if missing, creates network and volume, starts code-server and waits for `/healthz`.
2. Starts PostgreSQL or S3 when a selected spec reads `E2E_POSTGRES_*` or `E2E_S3_*`. Nothing to configure, so a run of one simple spec starts no second container.
3. Runs each spec in a new browser context (1440 x 900, scale factor 2, light scheme, English, UTC, clipboard granted) after a `reset` of the server.
4. Writes `out/<spec>.json` and screenshots. A failed spec adds a failure screenshot, a Playwright trace and the aantje output channel log. `out/code-server.log` holds the server output.
5. Prints the summary and removes everything.

### PostgreSQL for specs

`test/e2e/pg.ps1` starts `postgres:17-alpine` on the network of the run. It publishes no port, has a random password per start, keeps its data in memory and loads `test/fixtures/postgres.sql` once the real server answers over TCP. The runner receives `E2E_POSTGRES_HOST`, `_PORT`, `_DATABASE`, `_USER` and `_PASSWORD`. A running database is reused with `-Keep` and `-Reuse`; specs only read from it. TLS is not covered here, see [PostgreSQL driver](driver-postgres.md).

### S3 server for specs

`test/e2e/s3.ps1` does the same for `rustfs/rustfs:1.0.4`: no published port, random root keys, data in a `tmpfs`, variables `E2E_S3_HOST`, `_PORT`, `_ACCESS_KEY` and `_SECRET_KEY`. A spec creates its bucket with a signed request from inside the code-server container.

### The control API of the server

A spec runs in another container and cannot restart code-server or look into its files. The supervisor (`server/supervisor.mjs`, PID 1 of the code-server container) offers a small HTTP API on the Docker network, used by specs as `t.server`: restart the server (data stays), reset it to a new state (the runner does this before every spec), run a shell command, read and write files, and read the extension host logs. It is not published and has no authentication, so never start it on a shared network.

## Writing a spec

A spec is an ES module in `test/e2e/specs` with a `title` and a default function that receives a context `t`: the Playwright `page`, the control API `t.server`, the workbench `t.url`, `t.step(name, fn)` and `t.shot(label)`. A helper library in `test/e2e/lib` wraps the workbench: open it, run a command from the palette, answer quick picks and inputs, expand tree nodes, read editors and the clipboard, take screenshots. Specs wait for conditions with Playwright's auto-waiting and polling helpers, never fixed sleeps. Texts of editors are read from the lines the editor draws or through the clipboard, so keep documents short. Keys the browser itself takes (Ctrl+W, Ctrl+PageUp) are not used. Use `-Reuse` to iterate in seconds.

## Debugging

- Screenshots are in `out/<spec>-<nn>-<label>.png`; a failed spec adds `<spec>-FAILED.png`.
- The trace `out/<spec>.trace.zip` of a failed spec opens with `npx playwright show-trace` or at `trace.playwright.dev`.
- `out/<spec>.aantje.log` is the aantje output channel of a failed spec, `out/<spec>.console.log` the browser console.
- To look yourself: `.\test\e2e\run.ps1 -Up`, open the printed address (no password), and use `docker exec -it aantje-test-e2e-cs bash` to look into the container. Finish with `-Clean`.

## The secret storage belongs to the browser

In stock code-server (without `--enable-remote-storage`) the secret storage of the web workbench is the browser's local storage for the origin of the workbench. No file in the container holds the password.

- A restart of code-server keeps the password, because the browser still has it.
- Another browser, a private window, another address or port, or cleared site data have no secret. aantje asks for the password once and stores it in that browser after the connection worked.
- The profile belongs to the server and shows in every browser. The password belongs to the browser and is neither shared between users or devices nor part of a provisioned profile.

## Known limits

- One platform: code-server 4.144.0 on Linux x64 and Chromium. Firefox and WebKit are not run. The Windows package is covered by the extension-host tests.
- The plain code-server image has no Python and no Jupyter kernel.
- `--auth none`, so the password page of code-server is not tested.
- One PostgreSQL version (17) without TLS. One S3 server over plain HTTP, path style, one region.
- The specs test the VSIX in `artifacts/`, not the sources. Rebuild the package after a change (`-Rebuild`).
- Report pages are checked through their markup (CSS classes), so a renamed class fails the specs of that report. A chart counts as drawn when its canvas has non-transparent pixels. Screenshots are for people; specs never compare pixels.
- The helpers depend on the markup of the code-server 4.144 workbench. The `helpers` spec shows which helper broke after an upgrade.
- A reset costs about ten seconds per spec, and specs run one after the other.
