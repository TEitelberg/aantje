"""End-to-end smoke test for the Oog stack.

    python -m oog.smoke [--keep]

Proves, in order:
  1. DuckDB connects and attaches the DuckLake catalog (metadata in Postgres).
  2. DuckDB writes a table into the schema `smoke` (data lands as Parquet on RustFS).
  3. Those Parquet files exist under DATA_PATH in the bucket and hold the rows, and the
     metadata is in the catalog (new snapshots, visible from a fresh session).
  4. Quack (only if OOG_QUACK_TOKEN is set): the DuckLake served by the DuckDB server is attached, a table written
     through it reads back from a fresh session, and its Parquet files are under the Quack data path on RustFS.
  5. Gitea (only if OOG_GITEA_URL is set): API health and admin sign-in; a private repo,
     an issue and a small text attachment are created; the attachment object is found in
     the RustFS bucket (DuckDB glob, size and sha256); the download returns the same
     sha256; deleting the repo removes the object again.

The schema `smoke` belongs to this test: it is dropped and recreated on every run and
dropped again at the end, together with its Parquet files, unless
--keep is given (also the Gitea repo `smoke-<timestamp>`). The Parquet files are taken
from ducklake_list_files(), never from guessed folders or globs. Exit code 0 = all
checks passed, 1 = failure. A run that hangs is aborted after ten minutes.
"""

from __future__ import annotations

import argparse
import contextlib
import base64
import faulthandler
import hashlib
import json
import os
import sys
import time
import traceback
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlsplit

import oog

SCHEMA = "smoke"
TABLE = "events"
QUACK_TABLE = "quack_events"
ROWS = 100_000
GROUPS = 10
TIMEOUT_SECONDS = 600

_SECRET_ENV = (
    "OOG_S3_ACCESS_KEY",
    "OOG_S3_SECRET_KEY",
    "OOG_PG_PASSWORD",
    "OOG_CODE_SERVER_PASSWORD",
    "OOG_GITEA_ADMIN_PASSWORD",
)
# Deterministic data: integers only, so sums are exact in every engine.
_GROUP_SQL = f"'g' || (i % {GROUPS})"
_VALUE_SQL = "((i * 7) % 1000)"

_HINT_CONNECT = (
    "Are postgres and rustfs up (docker compose ps / kubectl --context docker-desktop -n oog get pods)? "
    "Do OOG_PG_*, OOG_S3_* and OOG_DUCKLAKE_DATA_PATH match the running stack?"
)
_HINT_WRITE = (
    "DuckLake could not write to the bucket: does it exist (rustfs-init) and are the "
    "S3 credentials, endpoint and path-style access correct?"
)
_HINT_STORAGE = (
    "The catalog may point to another data path than OOG_DUCKLAKE_DATA_PATH "
    "(a lake that was created earlier keeps its original DATA_PATH)."
)
_HINT_QUACK = (
    "Is the duckdb container healthy, do OOG_QUACK_TOKEN and OOG_QUACK_CA_FILE match the running stack, and is the "
    "certificate in the quack-certs volume the one the server uses? (Clients use TLS for every host but localhost.)"
)
_HINT_GITEA_API = (
    "Is gitea up and gitea-init completed? Do OOG_GITEA_URL, OOG_GITEA_ADMIN_USER and "
    "OOG_GITEA_ADMIN_PASSWORD match the running stack?"
)
_HINT_GITEA_S3 = (
    "Gitea may keep attachments on its local disk or cannot reach RustFS: check "
    "GITEA__storage__STORAGE_TYPE=minio, the MINIO_* settings and the bucket OOG_GITEA_BUCKET."
)
_HINT_GITEA_DOWNLOAD = (
    "Downloads are streamed by Gitea (GITEA__storage__SERVE_DIRECT=false); is the attachment "
    "readable by the admin and does Gitea reach RustFS?"
)
_HINT_GITEA_DELETE = (
    "Deleting a repository should remove its attachments from the bucket at once; check the "
    "Gitea log for storage errors."
)
HTTP_TIMEOUT = 60


class SmokeError(Exception):
    """A check failed (as opposed to an unexpected error)."""


def _q(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _expected() -> tuple[tuple[int, int], list[tuple[str, int, int]]]:
    """Expected aggregates, computed in plain Python (independent of both engines)."""
    per_group = {f"g{g}": (0, 0) for g in range(GROUPS)}
    for i in range(ROWS):
        key = f"g{i % GROUPS}"
        n, s = per_group[key]
        per_group[key] = (n + 1, s + (i * 7) % 1000)
    groups = [(g, n, s) for g, (n, s) in sorted(per_group.items())]
    return (ROWS, sum(s for _, _, s in groups)), groups


def _ints(values) -> tuple[int | None, ...]:
    return tuple(None if v is None else int(v) for v in values)


def _expect(what: str, got: object, want: object) -> None:
    if got != want:
        raise SmokeError(f"{what}: got {str(got)[:300]}, expected {str(want)[:300]}")


def _s3_path(uri: str) -> str:
    return uri.split("://", 1)[1] if "://" in uri else uri


class Smoke:
    def __init__(self, keep: bool = False) -> None:
        self.keep = keep
        self.secrets = [v for k in _SECRET_ENV if (v := os.environ.get(k))]
        self.expected_total, self.expected_groups = _expected()
        self.settings = None
        self.con = None
        self.catalog = ""
        self.base = ""  # DATA_PATH with exactly one trailing slash
        self.table = ""  # fully qualified and quoted
        self.snapshot_before = 0
        self.quack_table = ""
        self.files: list[str] = []
        self.duck_total: tuple[int, ...] = ()
        self.duck_groups: list[tuple[str, int, int]] = []
        self.gitea_url = os.environ.get("OOG_GITEA_URL", "").strip().rstrip("/")
        self.gitea_bucket = os.environ.get("OOG_GITEA_BUCKET", "").strip() or "oog-gitea"
        self.gitea_user = os.environ.get("OOG_GITEA_ADMIN_USER", "")
        self.gitea_auth = ""
        self.gitea_owner = ""
        self.gitea_repo = ""
        self.gitea_repo_created = False
        self.att_name = "smoke.txt"
        self.att_bytes = b""
        self.att_download = ""
        self.att_pattern = ""
        self.att_path = ""

    # -- output (never prints secret values) --------------------------------------

    def scrub(self, text: str) -> str:
        for secret in self.secrets:
            if len(secret) >= 4:
                text = text.replace(secret, "***")
        return text

    def say(self, text: str = "") -> None:
        print(self.scrub(text), flush=True)

    def ok(self, text: str) -> None:
        self.say(f"      ok    {text}")

    def note(self, text: str) -> None:
        self.say(f"      note  {text}")

    # -- driver -------------------------------------------------------------------

    def run(self) -> int:
        started = time.monotonic()
        self.say("Oog smoke test")
        try:
            s = self.settings = oog.Settings.from_env()
        except Exception as exc:  # noqa: BLE001
            self.say(f"FAIL  cannot read the OOG_* settings: {exc}")
            return 1
        self.secrets += [s.s3_access_key, s.s3_secret_key, s.pg_password, s.quack_token]
        password = os.environ.get("OOG_GITEA_ADMIN_PASSWORD", "")
        if password:
            token = base64.b64encode(f"{self.gitea_user}:{password}".encode()).decode()
            self.gitea_auth = "Basic " + token
            self.secrets += [token, password]
        self.catalog = s.ducklake_name
        self.base = s.ducklake_data_path.rstrip("/") + "/"
        self.table = f"{_q(self.catalog)}.{_q(SCHEMA)}.{_q(TABLE)}"
        self.say(f"  DuckLake  {self.catalog} (catalog {s.pg_host}:{s.pg_port}/{s.pg_db})")
        self.say(f"  Data path {self.base}")
        self.say(f"  S3        {s.s3_endpoint} (bucket {s.s3_bucket})")
        if self.gitea_url:
            self.say(f"  Gitea     {self.gitea_url} (bucket {self.gitea_bucket})")

        steps = [
            (
                "DuckDB: connect and attach the DuckLake catalog",
                self.step_connect,
                _HINT_CONNECT,
            ),
            (
                f"DuckDB: write {SCHEMA}.{TABLE} ({ROWS:,} rows) into DuckLake",
                self.step_write,
                _HINT_WRITE,
            ),
            (
                "Storage and catalog: Parquet files in the bucket, metadata in Postgres",
                self.step_storage,
                _HINT_STORAGE,
            ),
        ]
        if s.quack_token:
            steps.append((f"Quack: write through {s.quack_name}, read from a fresh session", self.step_quack, _HINT_QUACK))
        if self.gitea_url:
            steps += [
                (
                    "Gitea: API health and admin sign-in",
                    self.step_gitea_login,
                    _HINT_GITEA_API,
                ),
                (
                    "Gitea: repo, issue and attachment; the object lands in the RustFS bucket",
                    self.step_gitea_attach,
                    _HINT_GITEA_S3,
                ),
                (
                    "Gitea: download the attachment and compare the sha256",
                    self.step_gitea_download,
                    _HINT_GITEA_DOWNLOAD,
                ),
                (
                    "Gitea: delete the repo, the object disappears from the bucket",
                    self.step_gitea_delete,
                    _HINT_GITEA_DELETE,
                ),
            ]
        else:
            self.note("OOG_GITEA_URL is not set: the Gitea steps are skipped")
        failure = None
        try:
            for n, (title, step, hint) in enumerate(steps, 1):
                self.say(f"[{n}/{len(steps)}] {title}")
                try:
                    step()
                except Exception as exc:  # noqa: BLE001
                    failure = (n, title, hint, exc)
                    break
        finally:
            self.cleanup()

        seconds = time.monotonic() - started
        if failure is None:
            self.say(f"PASS  all {len(steps)} steps ok ({seconds:.1f} s)")
            return 0
        n, title, hint, exc = failure
        message = str(exc).strip() or "(no message)"
        if len(message) > 1500:
            message = message[:1500] + " ..."
        self.say(f"FAIL  step {n}/{len(steps)} - {title}")
        self.say(f"      {type(exc).__name__}: " + message.replace("\n", "\n      "))
        self.say(f"      hint: {hint}")
        if not isinstance(exc, SmokeError):  # unexpected: show where it happened
            frames = [
                f
                for f in traceback.extract_tb(exc.__traceback__)
                if f"{os.sep}oog{os.sep}" in f.filename
            ]
            for frame in frames[-2:]:
                where = f"oog/{os.path.basename(frame.filename)}:{frame.lineno}"
                self.say(f"      at {where} in {frame.name}")
        self.say(f"FAILED ({seconds:.1f} s)")
        return 1

    # -- steps --------------------------------------------------------------------

    def step_connect(self) -> None:
        self.con = oog.connect(self.settings)
        self.ok(
            f"catalog '{self.catalog}' attached, current snapshot {self._last_snapshot(self.con)}"
        )

    def step_write(self) -> None:
        con, tbl = self.con, self.table
        dropped = self._drop_smoke()
        if dropped:
            self.note(f"removed {dropped} Parquet file(s) left over from an earlier run")
        self.snapshot_before = self._last_snapshot(con)
        con.execute(f"CREATE SCHEMA {_q(self.catalog)}.{_q(SCHEMA)}")
        con.execute(f"CREATE TABLE {tbl} (id BIGINT, grp VARCHAR, value BIGINT)")
        half = ROWS // 2
        for lo, hi in ((0, half), (half, ROWS)):  # two inserts -> two Parquet files
            con.execute(
                f"INSERT INTO {tbl} SELECT i::BIGINT, {_GROUP_SQL}, {_VALUE_SQL}::BIGINT "
                f"FROM range({lo}, {hi}) t(i)"
            )
        self.duck_total = _ints(con.execute(f"SELECT count(*), sum(value) FROM {tbl}").fetchone())
        self.duck_groups = [
            (g, int(n), int(t))
            for g, n, t in con.execute(
                f"SELECT grp, count(*), sum(value) FROM {tbl} GROUP BY grp ORDER BY grp"
            ).fetchall()
        ]
        _expect("DuckDB count/sum(value)", self.duck_total, self.expected_total)
        _expect("DuckDB group-by", self.duck_groups, self.expected_groups)
        self.ok(
            f"count={self.duck_total[0]:,} sum(value)={self.duck_total[1]:,} "
            f"in {GROUPS} groups (matches the values computed in Python)"
        )

    def step_storage(self) -> None:
        self.files = self._data_files()
        if not self.files:
            raise SmokeError("DuckLake lists no data files for the table (nothing was written)")
        outside = [f for f in self.files if not f.startswith(self.base)]
        if outside:
            raise SmokeError(
                f"{len(outside)} data file(s) are not under DATA_PATH {self.base}, "
                f"e.g. {outside[0]}"
            )
        try:
            files, rows = self.con.execute(
                "SELECT count(*), sum(num_rows) FROM parquet_file_metadata(?)", [self.files]
            ).fetchone()
        except Exception as exc:
            raise SmokeError(
                f"the Parquet files listed by DuckLake cannot be read from the bucket: {exc}"
            ) from exc
        _expect("Parquet files in the bucket", files, len(self.files))
        _expect("rows in those Parquet files", rows, ROWS)
        folder = self.files[0].rsplit("/", 1)[0] + "/"
        self.ok(f"{files} Parquet files with {rows:,} rows, e.g. in {folder}")

        after = self._last_snapshot(self.con)
        if after <= self.snapshot_before:
            raise SmokeError(f"no new DuckLake snapshot (still {after})")
        self.ok(f"catalog advanced from snapshot {self.snapshot_before} to {after}")

        fresh = oog.connect(self.settings)
        try:
            seen = fresh.execute(f"SELECT count(*) FROM {self.table}").fetchone()[0]
        finally:
            fresh.close()
        _expect("row count seen by a fresh DuckDB session", seen, ROWS)
        self.ok(f"a fresh DuckDB session reads {seen:,} rows via the catalog")

    def step_quack(self) -> None:
        s, name = self.settings, self.settings.quack_name
        attached = self.con.execute("SELECT count(*) FROM duckdb_databases() WHERE database_name = ?", [name]).fetchone()[0]
        if not attached:
            raise SmokeError(f"the catalog {name!r} is not attached (the kernel and this test warn why when it fails)")
        self.quack_table = f"{_q(name)}.{_q(SCHEMA)}.{_q(QUACK_TABLE)}"
        self.con.execute(f"CREATE SCHEMA IF NOT EXISTS {_q(name)}.{_q(SCHEMA)}")
        self.con.execute(f"CREATE OR REPLACE TABLE {self.quack_table} AS SELECT range AS id, range % {GROUPS} AS grp FROM range({ROWS})")
        self.ok(f"wrote {ROWS:,} rows through the Quack server")
        fresh = oog.connect(s)
        try:
            seen = fresh.execute(f"SELECT count(*) FROM {self.quack_table}").fetchone()[0]
        finally:
            fresh.close()
        _expect("row count seen by a fresh session through Quack", seen, ROWS)
        self.ok(f"a fresh session reads {seen:,} rows through Quack")
        base = s.quack_data_path.rstrip("/") + "/"
        files = [r[0] for r in self.con.execute("SELECT data_file FROM ducklake_list_files(?, ?, schema => ?)", [name, QUACK_TABLE, SCHEMA]).fetchall()]
        if not files or any(not f.startswith(base) for f in files):
            raise SmokeError(f"the data files of the Quack table are not under {base}: {files[:2]}")
        self.ok(f"{len(files)} Parquet file(s) under {base}")

    def step_gitea_login(self) -> None:
        if not self.gitea_user or not self.gitea_auth:
            raise SmokeError("OOG_GITEA_ADMIN_USER and OOG_GITEA_ADMIN_PASSWORD must be set")
        self._gitea("GET", "/api/healthz", auth=False)
        self.ok("GET /api/healthz returned 200")
        me = json.loads(self._gitea("GET", "/api/v1/user")[1])
        login = me.get("login", "")
        if login.lower() != self.gitea_user.lower():
            raise SmokeError(f"signed in as '{login}', expected '{self.gitea_user}'")
        if not me.get("is_admin"):
            raise SmokeError(f"user '{login}' is not a Gitea administrator")
        self.gitea_owner = login
        self.ok("signed in as administrator (HTTP Basic auth)")

    def step_gitea_attach(self) -> None:
        owner = self.gitea_owner
        self.gitea_repo = "smoke-" + time.strftime("%Y%m%d%H%M%S")
        body = {"name": self.gitea_repo, "private": True, "description": "Oog smoke test"}
        self._gitea("POST", "/api/v1/user/repos", body=body, expect=(201,))
        self.gitea_repo_created = True
        self.ok(f"created private repo {self.gitea_repo}")
        repo = f"/api/v1/repos/{owner}/{self.gitea_repo}"
        issue = json.loads(
            self._gitea("POST", f"{repo}/issues", body={"title": "smoke test"}, expect=(201,))[1]
        )["number"]
        self.ok(f"created issue #{issue}")

        lines = (f"Oog smoke test attachment {i:04d} {self.gitea_repo}\n" for i in range(80))
        self.att_bytes = "".join(lines).encode()
        want = hashlib.sha256(self.att_bytes).hexdigest()
        boundary = "oogsmoke" + uuid.uuid4().hex
        form = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"attachment\"; "
            f"filename=\"{self.att_name}\"\r\nContent-Type: text/plain\r\n\r\n"
        ).encode() + self.att_bytes + f"\r\n--{boundary}--\r\n".encode()
        resp = self._gitea(
            "POST",
            f"{repo}/issues/{issue}/assets?name={self.att_name}",
            data=form,
            content_type=f"multipart/form-data; boundary={boundary}",
            expect=(201,),
        )
        asset = json.loads(resp[1])
        att_uuid = asset["uuid"]
        self.att_download = asset["browser_download_url"]
        _expect("size reported by Gitea", asset.get("size"), len(self.att_bytes))
        self.ok(f"uploaded {self.att_name} ({len(self.att_bytes):,} bytes, sha256 {want[:12]}...)")

        pattern = self.att_pattern = f"s3://{self.gitea_bucket}/attachments/*/*/{att_uuid}"
        found = self._glob(pattern)
        if len(found) != 1:
            raise SmokeError(
                f"expected exactly one object matching {pattern}, found {len(found)}; "
                "Gitea does not store attachments in the bucket"
            )
        self.att_path = found[0]
        size, digest = self.con.execute(
            "SELECT size, sha256(content) FROM read_blob(?)", [self.att_path]
        ).fetchone()
        _expect("size of the object in the bucket", size, len(self.att_bytes))
        _expect("sha256 of the object in the bucket", digest, want)
        self.ok(f"object {self.att_path} found: {size:,} bytes, same sha256")

    def step_gitea_download(self) -> None:
        # browser_download_url is built from ROOT_URL (the host's view); use our own base.
        path = urlsplit(self.att_download).path
        data = self._gitea("GET", path)[1]
        want = hashlib.sha256(self.att_bytes).hexdigest()
        _expect("sha256 of the downloaded attachment", hashlib.sha256(data).hexdigest(), want)
        self.ok(f"{path} returned {len(data):,} bytes with the uploaded sha256")

    def step_gitea_delete(self) -> None:
        if self.keep:
            self.note(f"--keep: repo {self.gitea_repo} is left in place")
            return
        self._gitea_delete_repo()
        self.ok(f"deleted repo {self.gitea_repo} (HTTP 204)")
        for _ in range(10):  # Gitea removes the objects right after the delete; allow a short lag
            if not self._glob(self.att_pattern):
                break
            time.sleep(1)
        else:
            raise SmokeError(f"{self.att_path} is still in the bucket after the repo delete")
        self.ok("the attachment object is gone from the bucket")

    # -- cleanup ------------------------------------------------------------------

    def cleanup(self) -> None:
        if self.gitea_repo_created:
            if self.keep:
                self.say(f"[keep] Gitea repo {self.gitea_repo} left in place")
            else:
                try:
                    self._gitea_delete_repo()
                    self.say(f"[clean] Gitea repo {self.gitea_repo} deleted")
                except Exception as exc:  # noqa: BLE001
                    self.note(f"could not delete Gitea repo {self.gitea_repo}: {exc}")
        try:
            if self.con is None:
                return
            if self.keep:
                self.say("[keep] cleanup skipped (--keep); the next run replaces these:")
                self.say(f"      DuckLake table {self.table}")
                return
            self.say("[clean] schema smoke and its Parquet files")
            try:
                files = self._drop_smoke() + self._drop_quack()
                self.ok(f"dropped schema; removed {files} DuckLake file(s)")
            except Exception as exc:  # noqa: BLE001
                self.note(f"incomplete: {type(exc).__name__}: {exc}")
        finally:
            for target, method in ((self.con, "close"),):
                if target is not None:
                    with contextlib.suppress(Exception):
                        getattr(target, method)()

    # -- helpers ------------------------------------------------------------------

    def _gitea(
        self,
        method: str,
        path: str,
        *,
        body: dict | None = None,
        data: bytes | None = None,
        content_type: str | None = None,
        auth: bool = True,
        expect: tuple[int, ...] = (200,),
    ) -> tuple[int, bytes]:
        """One Gitea request (standard library only); raises SmokeError on a wrong status."""
        headers = {"Accept": "application/json"}
        if body is not None:
            data, content_type = json.dumps(body).encode(), "application/json"
        if content_type:
            headers["Content-Type"] = content_type
        if auth:
            headers["Authorization"] = self.gitea_auth
        req = urllib.request.Request(self.gitea_url + path, data, headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                status, payload = resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            status, payload = exc.code, exc.read()
        except OSError as exc:
            raise SmokeError(f"{method} {path}: Gitea is not reachable ({exc})") from exc
        if status not in expect:
            detail = payload[:300].decode("utf-8", "replace").strip()
            if status == 401:
                detail = "sign-in rejected: check OOG_GITEA_ADMIN_USER and OOG_GITEA_ADMIN_PASSWORD"
            raise SmokeError(f"{method} {path}: HTTP {status}, expected {expect[0]}: {detail}")
        return status, payload

    def _glob(self, pattern: str) -> list[str]:
        return [r[0] for r in self.con.execute("SELECT file FROM glob(?)", [pattern]).fetchall()]

    def _gitea_delete_repo(self) -> None:
        path = f"/api/v1/repos/{self.gitea_owner}/{self.gitea_repo}"
        self._gitea("DELETE", path, expect=(204, 404))
        self.gitea_repo_created = False

    def _last_snapshot(self, con) -> int:
        return con.execute(
            "SELECT max(snapshot_id) FROM ducklake_snapshots(?)", [self.catalog]
        ).fetchone()[0]

    def _data_files(self) -> list[str]:
        """Parquet files of the smoke table, as resolved by DuckLake itself."""
        rows = self.con.execute(
            "SELECT data_file FROM ducklake_list_files(?, ?, schema => ?)",
            [self.catalog, TABLE, SCHEMA],
        ).fetchall()
        return sorted(r[0] for r in rows)

    def _drop_smoke(self) -> int:
        """Drop schema `smoke` and delete its Parquet files; returns files deleted.

        DuckLake keeps the files of dropped tables (time travel), so they are removed
        explicitly; otherwise every run would leave garbage in the lake.
        """
        exists = self.con.execute(
            "SELECT count(*) FROM duckdb_tables() "
            "WHERE database_name = ? AND schema_name = ? AND table_name = ?",
            [self.catalog, SCHEMA, TABLE],
        ).fetchone()[0]
        files = [f for f in self._data_files() if f.startswith(self.base)] if exists else []
        self.con.execute(f"DROP SCHEMA IF EXISTS {_q(self.catalog)}.{_q(SCHEMA)} CASCADE")
        try:
            return self._s3_remove(files=files)
        except Exception as exc:  # noqa: BLE001
            self.note(f"could not delete {len(files)} Parquet file(s): {type(exc).__name__}: {exc}")
            return 0

    def _drop_quack(self) -> int:
        """Drop the smoke schema of the Quack catalog and delete its Parquet files (DuckLake keeps them for time travel)."""
        if not self.quack_table:
            return 0
        name = self.settings.quack_name
        base = self.settings.quack_data_path.rstrip("/") + "/"
        files = [r[0] for r in self.con.execute("SELECT data_file FROM ducklake_list_files(?, ?, schema => ?)", [name, QUACK_TABLE, SCHEMA]).fetchall()]
        self.con.execute(f"DROP SCHEMA IF EXISTS {_q(name)}.{_q(SCHEMA)} CASCADE")
        try:
            return self._s3_remove(files=[f for f in files if f.startswith(base)])
        except Exception as exc:  # noqa: BLE001
            self.note(f"could not delete {len(files)} Quack Parquet file(s): {type(exc).__name__}: {exc}")
            return 0

    def _s3_remove(self, *, files: list[str] | None = None, prefix: str | None = None) -> int:
        """Delete objects (DuckDB cannot); pyarrow is part of the venv."""
        paths = [_s3_path(f) for f in files or []]
        if prefix and len(_s3_path(prefix).strip("/").split("/")) < 2:
            raise ValueError(f"refusing to delete a whole bucket: {prefix}")
        if not paths and not prefix:
            return 0
        from pyarrow import fs

        s = self.settings
        endpoint = s.s3_endpoint if "://" in s.s3_endpoint else "http://" + s.s3_endpoint
        url = urlsplit(endpoint)
        s3 = fs.S3FileSystem(
            access_key=s.s3_access_key,
            secret_key=s.s3_secret_key,
            endpoint_override=url.netloc,
            scheme=url.scheme,
            region=s.s3_region,
        )
        if prefix:
            selector = fs.FileSelector(_s3_path(prefix), recursive=True, allow_not_found=True)
            paths += [i.path for i in s3.get_file_info(selector) if i.type == fs.FileType.File]
        for path in paths:
            with contextlib.suppress(FileNotFoundError):
                s3.delete_file(path)
        return len(paths)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m oog.smoke",
        description="End-to-end smoke test: DuckDB/DuckLake <-> RustFS <-> Gitea.",
    )
    parser.add_argument(
        "--keep",
        action="store_true",
        help="keep schema 'smoke', its Parquet files and the Gitea repo",
    )
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(line_buffering=True, errors="backslashreplace")
    return Smoke(keep=args.keep).run()


if __name__ == "__main__":
    faulthandler.dump_traceback_later(TIMEOUT_SECONDS, exit=True)
    sys.exit(main())
