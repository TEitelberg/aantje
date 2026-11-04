# Contributing

Thank you for helping with aantje. Issues and pull requests are welcome.

## Before you start

- Open an [issue](https://github.com/TEitelberg/aantje/issues) first for anything larger than a small fix, so that we can agree on the direction.
- Set up the project and learn the daily loop in [Development](docs/en/development.md): `git clone https://github.com/TEitelberg/aantje.git`, Node 24, `npm ci`, `npm test`.
- Read [Testing](docs/en/testing.md) for what a good test is here and how to check that it can fail.

## Branches and pull requests

- `main` is protected: work on a branch and open a pull request. The CI (`test`) must pass before it can be merged; it runs the tests that the changed files can affect, the merge runs all ([Testing](docs/en/testing.md#continuous-integration)); force pushes and deletion of `main` are refused.
- Every merge into `main` builds a pre-release on GitHub; Open VSX gets a version only when the owner turns that pre-release into a release. The version counts the patch part up. Label the pull request `release:minor` or `release:major` to count that part instead. The release notes are generated from the pull requests, see [Packaging](docs/en/packaging.md#release).

## Rules

- **English only.** Code, identifiers, comments, UI texts, log and error messages, and documentation.
- **Minimal code.** No speculative options, no abstraction for a single caller, no unused exports. Comments explain a why that is not obvious.
- **Tests with real data** (the fixture catalogs, a real in-memory DuckDB) and exact expected values. Every test must be able to fail.
- **No secrets** in logs, error messages, tooltips, settings, notebooks or tests.
- **Document what users see** in `docs/en`, and in the README if it is a feature. The changes of a release are in its GitHub release notes.

A change is ready when `npm run lint`, `npm run typecheck`, `npm run format` and `npm test` are green. Changes to drivers, the reader, the data engine or the notebook also need `npm run test:full` (Docker); changes to the wiring with VS Code need `npm run test:integration`.

## Licence

aantje is released under the [MIT licence](LICENSE). By submitting a contribution you agree that it is licensed under the same terms (inbound = outbound).

## Security

Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).
