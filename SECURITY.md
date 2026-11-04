# Security policy

## Supported versions

Only the latest release receives security fixes. aantje is at version 0.x, and a fix ships in the next release.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Report it privately with [GitHub private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability): open the [advisory form](https://github.com/TEitelberg/aantje/security/advisories/new) (the **Security** tab of the repository, then **Report a vulnerability**).

Include the version of aantje and of VS Code or code-server, the platform, the kind of catalog (PostgreSQL, SQLite, DuckDB) and the steps to reproduce. Never include real passwords, S3 keys or catalog contents.

You can expect an answer within seven days. Once a fix is released, the report is published as a security advisory and you are credited if you wish.

## What is in scope

aantje is a client for databases that you configure. These are in scope:

- A way to make the **explorer** write to a catalog, or to run SQL that aantje did not build itself (the read-only guarantee of the explorer).
- A password or an S3 key that reaches a setting, a log, an error message, a tooltip, a notebook or a webview message.
- A workspace or a catalog that makes aantje connect somewhere else, run code or read files without the confirmation that is documented.
- Script injection or unsafe rendering of hostile catalog text (names, comments, SQL) in a tree, a report, a webview or a generated script.
- An unsafe message from a webview to the extension.

## What is out of scope

The documented limits in [Security](docs/en/security.md) are known and not vulnerabilities, among them:

- The **SQL editor runs any SQL** with the rights of the credentials of the connection, and a read-only session guards against a slip, not against a hostile script.
- A catalog can name any path or URL as a data file, and a view runs the SQL of its author after you trusted the connection.
- Someone who already controls the machine or the extension host can read the secret storage and every file aantje can read.
- Passwords in code-server with `--enable-remote-storage`, where the workbench keeps them unencrypted in its user data directory.
- Vulnerabilities in DuckDB, PostgreSQL, VS Code or code-server themselves: report those to their projects.
