"""Writes <user data dir>/Machine/settings.json at container start (called by entrypoint.sh).

Usage: write-machine-settings.py DEFAULTS TARGET [PROFILES...]

DEFAULTS is the machine-settings.json of the image (JSON with comments), written to TARGET on every start.
PROFILES are only passed when the aantje extension is installed: JSON files with default values of
"aantje.connections" (arrays of connection profiles). The setting is machine-scoped, so code-server keeps it
in TARGET, and the aantje wizard writes the connections that users add there too. TARGET is rewritten on
every start, so the array already in TARGET is carried over. Without it, the connections users added would be
gone after each restart. A default that is not in the array yet (by name) is added; a Quack connection that is
there already takes the fingerprint of the default, because a new certificate volume means a new certificate.

A PROFILES file named .iceberg-targets.json holds default values of "aantje.icebergTargets" (Iceberg REST catalogs
that Sync to Iceberg writes to) and is merged the same way into that setting.
"""
import json
import os
import re
import sys

KEY = "aantje.connections"
ICEBERG_KEY = "aantje.icebergTargets"
ICEBERG_FILE = ".iceberg-targets.json"
_TOKEN = re.compile(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*.*?\*/', re.S)


def strip_comments(text):
    return _TOKEN.sub(lambda m: m.group(0) if m.group(0).startswith('"') else " ", text)


def existing_connections(path, key=KEY):
    """The array of the current file, or None if there is no file, no key or no valid JSON."""
    try:
        with open(path, encoding="utf-8") as f:
            value = json.loads(strip_comments(f.read())).get(key)
    except (OSError, ValueError, AttributeError):
        return None
    return value if isinstance(value, list) else None


def merge(value, defaults):
    """The array `value` with every default added that has no entry of that name; a Quack entry takes the new fingerprint."""
    by_name = {e.get("name"): e for e in value if isinstance(e, dict)}
    for default in defaults:
        entry = by_name.get(default.get("name"))
        if entry is None:
            value.append(default)
        elif entry.get("kind") == "quack" == default.get("kind") and "fingerprint" in default:
            entry["fingerprint"] = default["fingerprint"]
    return value


def main(argv):
    defaults, target, *profiles = argv
    with open(defaults, encoding="utf-8") as f:
        text = f.read()
    if profiles:
        by_key = {KEY: [], ICEBERG_KEY: []}
        for path in profiles:
            key = ICEBERG_KEY if os.path.basename(path) == ICEBERG_FILE else KEY
            with open(path, encoding="utf-8") as f:
                by_key[key].extend(json.load(f))
        for key, defaults_list in by_key.items():
            if key == ICEBERG_KEY and not defaults_list:
                continue
            value = existing_connections(target, key)
            value = defaults_list if value is None else merge(value, defaults_list)
            body = json.dumps(value, indent=4, ensure_ascii=False).replace("\n", "\n    ")
            head = text[: text.rstrip().rfind("}")].rstrip()
            sep = "" if head.endswith(("{", ",")) else ","
            text = f'{head}{sep}\n\n    "{key}": {body}\n}}\n'
    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, target)


if __name__ == "__main__":
    main(sys.argv[1:])
