"""Install the DuckDB extensions that ``oog.connect()`` loads (build time, needs internet).

    python -m oog.install_extensions [--dir DIR]

The target is ``--dir`` or ``$OOG_DUCKDB_EXTENSION_DIR`` (default: DuckDB's own extension directory).
"""

from __future__ import annotations

import argparse
import os
import sys

from oog.duck import EXTENSIONS, extension_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m oog.install_extensions",
        description="Install the DuckDB extensions used by oog.connect() (needs internet).",
    )
    parser.add_argument("--dir", help="extension directory (default: $OOG_DUCKDB_EXTENSION_DIR)")
    args = parser.parse_args(argv)

    import duckdb

    target = args.dir or extension_dir()
    config = {}
    if target:
        os.makedirs(target, exist_ok=True)
        config["extension_directory"] = target
    try:
        con = duckdb.connect(":memory:", config=config)
        for name in EXTENSIONS:
            con.execute(f"INSTALL {name}")
            con.execute(f"LOAD {name}")  # fail now if an installed file cannot be loaded
        rows = con.execute(
            "SELECT extension_name, extension_version, install_path FROM duckdb_extensions() "
            "WHERE loaded AND install_path NOT LIKE '(BUILT-IN)%' ORDER BY extension_name"
        ).fetchall()
    except Exception as exc:
        print(f"oog.install_extensions: failed: {exc}", file=sys.stderr)
        return 1
    print(f"DuckDB {duckdb.__version__}: installed {', '.join(EXTENSIONS)}")
    for name, version, path in rows:
        print(f"  {name} {version} -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
