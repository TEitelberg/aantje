# Testing

aantje has four test layers, from fast logic tests to a browser run against the Linux package. This page lists the layers, the commands, what each needs and the rules for new tests.

## Test layers

| Layer              | Run by                     | What it covers                                                                                                          |
| ------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Unit               | `npm test`                 | Logic in plain Node with real data or plain-object ports, including the data engine on a real DuckDB.                   |
| Contract           | `npm test`                 | One suite, run against every catalog source (SQLite, DuckDB, PostgreSQL, Quack).                                        |
| Extension-host     | `npm run test:integration` | The built extension in a downloaded desktop VS Code: wiring, commands, menus, panels ([details](integration-tests.md)). |
| Browser end-to-end | `npm run test:e2e`         | The Linux package in code-server, driven by Chromium in Docker ([details](e2e-tests.md)).                               |

The first two layers run under vitest. The last two download and start VS Code or Docker containers, so they are not part of `npm test`.

## Fixtures

The catalog reader must understand the real DuckLake metadata format, so tests use catalogs written by DuckDB and the ducklake extension, not mocks. The same catalog exists as SQLite, DuckDB and PostgreSQL metadata, and the DuckDB file is also served over Quack; contract suites run the same expectations against all of them. A source that is not available is skipped with a visible reason, never silently. See [Test fixtures](test-fixtures.md).

## Tests of the data features

The data engine, the grid, the reports and the notebook are tested in plain Node, mostly without extra setup. Some tests need more:

- The engine tests need the DuckDB extensions `ducklake`, `sqlite`, `httpfs`, `postgres` and `quack`. They are cached in `test/.cache/duckdb-extensions` (about 200 MB, downloaded on the first run, safe to delete). Without the cache and without network access these tests are skipped and say why. With `AANTJE_REQUIRE_ENGINE=1` a missing extension fails the test file instead; CI and `npm run test:full` set it.
- The tests with PostgreSQL metadata or a Quack server need `AANTJE_POSTGRES=1` and Docker.
- The notebook execution test runs the generated notebook in a `python:3.12-slim` container. It needs Docker and network access and is opt-in: `AANTJE_NOTEBOOK=1`, or `npm run test:full`.

A skip is not a pass. Run the skipped tests once with network access before you finish a change to `src/data`.

### The grid client test

The grid script is tested without a browser. The test bundles `src/grid/client.ts` the way `esbuild.mjs` does and runs it against a hand-written fake of the DOM. The rules (sorting, filtering, copying, the row window) live in `src/grid/model.ts` and `results-model.ts`, where they are tested directly; `client.ts` keeps only the state of the page. Looks, focus and scrolling belong to the extension-host and browser layers.

## Running the tests

| Command                                          | What it does                                                                                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                       | Unit and contract suites. PostgreSQL and Quack sources are skipped without `AANTJE_POSTGRES=1`. `npx vitest run <file>` runs one file.                     |
| `npm run test:watch`                             | The same in watch mode.                                                                                                                                    |
| `npm run test:full`                              | `vitest run` with `AANTJE_POSTGRES=1` and `AANTJE_REQUIRE_ENGINE=1`: adds PostgreSQL, Quack and the notebook execution test. Extra arguments go to vitest. |
| `npm run test:integration`                       | Builds, then runs the extension-host tests in VS Code.                                                                                                     |
| `npm run test:e2e`                               | `test/e2e/run.ps1`: browser specs against code-server in Docker. Parameters: [End-to-end tests](e2e-tests.md#running).                                     |
| `npm run lint`                                   | ESLint, including the rule that keeps `vscode` out of the logic.                                                                                           |
| `npm run typecheck`                              | `tsc --noEmit` over `src/` and `test/`.                                                                                                                    |
| `npm run format`                                 | Prettier check. Fix a file with `npx prettier --write <file>`.                                                                                             |
| `npm run check:docs`                             | Fails when a page names a missing file or links to a missing page or heading. CI runs it.                                                                  |
| `npm run build`                                  | esbuild: `dist/` and `THIRD-PARTY-NOTICES.md`.                                                                                                             |
| `npm run package:win32`, `npm run package:linux` | Build and verify a package ([Packaging](packaging.md)).                                                                                                    |

### Prerequisites

- Unit and contract: Node.js 24 (22 or newer works) and `npm ci`. No Docker.
- PostgreSQL, Quack and notebook tests: Docker with Linux containers. The notebook test needs network access, and so does the first Quack run, which builds the image of `docker/images/quack`.
- Extension-host: network on the first run (VS Code goes to `.vscode-test/`, about 340 MB) and a display.
- Browser end-to-end: PowerShell 7, Docker and the Linux package from `npm run package:linux`.

## Continuous integration

`.github/workflows/ci.yml` runs lint, type check, format and the documentation check for every pull request. The tests it runs depend on the changed files:

| Changed files                                                                                                                                | Tests of the pull request                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the lock file, the configuration, `scripts/`, the setup files `test/support/*-setup.ts`, the fixture catalogs `test/fixtures/`, the workflow | all                                                                                                                                                                             |
| `src/`, `test/`, `package.json` or the documentation                                                                                         | the tests that import a changed file (`vitest --changed`), and the tests that read repository files (manifest, health docs, documentation pages, notices, menus, subscriptions) |
| only `docker/`, `media/`                                                                                                                     | none                                                                                                                                                                            |

vitest itself would run everything whenever `package.json` changes (its default `forceRerunTriggers`); `vitest.config.mts` leaves `package.json` out of that list, so a new menu entry or command runs only the tests above.

The merge into `main` and the weekly run (Monday) run everything, also on the next Ubuntu image (`ubuntu-26`, until `ubuntu-latest` has moved on 19 November 2026). To run the same selection locally: `npx vitest run --changed origin/main`.

The extension-host tests run in the job `integration` on Ubuntu under a virtual display (`xvfb-run -a npm run test:integration`): after every merge into `main`, in the weekly run and by hand (Run workflow), never for a pull request. The job is no required check, so a failure shows as a red run on `main`; run the suite locally for the changes that the [checklist](#checklist-for-a-change) names.

## Rules for tests

- A test proves behaviour that users rely on. Start with the main success path on real fixture data and exact values, then the important failure modes. Assert values and behaviour, not labels or the wording of messages.
- Use real data: the fixtures, an in-memory DuckDB, a temporary file. Mock only at system boundaries: the editor (through the ports), the network and the clock.
- Never assert on the behaviour of a mock or on the text of a SQL statement. The exception is modules whose product is SQL: the setup statements of `src/data/attach.ts` and the notebook cells.
- Every test must be able to fail. No tautologies, no duplicates.
- A test that needs something outside the process (Docker, network, DuckDB extensions) is skipped with a visible reason.
- No test sends a request to a real service. S3 failures run against a local fake store.
- No password or connection string in a snapshot, a log expectation or a fixture.
- Temporary files go to the system temp directory and are removed afterwards.
- Docker resources are named `aantje-test-...`, publish ports only on `127.0.0.1` and are removed by name. Never use `prune`.

## Break-it check

A module counts as done when breaking its key lines turns a test red. Do this in a copy of the project, never in the working tree.

```powershell
$m = "$env:TEMP\aantje-mut-$(Get-Random)"
robocopy . $m /E /XD node_modules dist .vscode-test /NFL /NDL /NJH /NJS | Out-Null
New-Item -ItemType Junction -Path "$m\node_modules" -Target (Resolve-Path node_modules) | Out-Null
# edit files in $m, then: Set-Location $m; npx vitest run <test files>
```

Remove the junction first (`(Get-Item "$m\node_modules").Delete()`), then the copy, so the real `node_modules` stays. The extension-host layer needs junctions to `.vscode-test` and `test/.cache` too ([Extension-host tests](integration-tests.md#break-it-check)). For the browser layer, build the package of the copy and pass it with `-Vsix` ([End-to-end tests](e2e-tests.md#running)).

## Documentation

The documentation is English. Every page is a file in `docs/en`, and `docs/en/index.md` links to all of them. `npm run check:docs` (`scripts/check-docs.mjs`) checks the README, `CONTRIBUTING.md`, `SECURITY.md` and every page:

- Files named in backticks under `src/`, `test/`, `scripts/`, `docs/` or `media/` exist.
- Relative links lead to an existing page and, with an anchor, to an existing heading.

Wording is not checked; a reviewer reads it. To add a page, write `docs/en/<topic>.md`, link it from `index.md` and add new source files to the module map in [Architecture](architecture.md).

## Checklist for a change

- The tests describe user-relevant behaviour with real data, and the break-it check was done.
- `npm test` is green; `npm run test:full` too for changes to drivers, the reader, the fixtures, `src/data` or `src/notebook`.
- `npm run test:integration` is green for changes to `src/extension.ts`, the `*.vscode.ts` adapters, commands or the manifest. `npm run test:e2e` runs the spec of the affected area for changes that the Linux package or code-server can show.
- `npm run lint`, `npm run typecheck`, `npm run format` and `npm run check:docs` are green.
- `vscode` is imported only in `src/extension.ts` and `*.vscode.ts` files.
- No password or connection string can reach a log line, an error message, a tooltip or a snapshot.
