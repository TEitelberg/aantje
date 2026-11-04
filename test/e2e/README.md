# Browser end-to-end tests

aantje in code-server, driven by a real browser (Playwright, Chromium), everything in Docker.

```powershell
.\test\e2e\run.ps1                    # all specs, then clean up
.\test\e2e\run.ps1 -Spec smoke -Keep  # keep the workbench for a look in the browser
.\test\e2e\run.ps1 -Clean             # remove what -Keep left behind
```

Needs PowerShell 7, Docker (Linux containers) and `artifacts/aantje-linux-x64-<version>.vsix` (`npm run package:linux`, or add `-Rebuild`). Twelve specs: `smoke`, `helpers`, `postgres-secrets`, `files-errors`, `tree-features`, `statistics`, `data-features`, `time-travel`, `sql-editor`, `reports`, `health` and `layout`; a full run takes about fifteen minutes (it is needed only before a release, see the docs). The specs `data-features` and `health` also start a throw-away S3 server (`s3.ps1`); `data-features`, `time-travel`, `sql-editor`, `reports` and `health` need network access from the code-server container (DuckDB extensions, and the Jupyter extension from Open VSX for `data-features`).

| Folder    | Content                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `specs/`  | The specs: one `*.mjs` file per scenario (`smoke`, `helpers`, ...).         |
| `lib/`    | The helpers that the specs share (palette, prompts, tree, panels, ...).     |
| `runner/` | The Playwright container: image definition and the program that runs specs. |
| `server/` | The supervisor inside the code-server container (restart, reset, exec).     |
| `out/`    | Screenshots, results, traces and logs of the last run (not checked in).     |

How it works, how to write a spec and how to debug one: [docs/en/e2e-tests.md](../../docs/en/e2e-tests.md).
