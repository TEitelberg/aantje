"""Writes <user data dir>/Machine/settings.json at container start (called by entrypoint.sh).

Usage: write-machine-settings.py DEFAULTS TARGET [PROFILES]

DEFAULTS is the machine-settings.json of the image (JSON with comments), written to TARGET on every start.
PROFILES is only passed when the aantje extension is installed: a JSON file with the default value of
"aantje.connections". The setting is machine-scoped, so code-server keeps it in TARGET, and the aantje
wizard writes the connections that users add there too. TARGET is rewritten on every start, so the
array already in TARGET is carried over. Without it, the connections users added would be gone after
each restart. The default only fills in a missing array.
"""
import json
import os
import re
import sys

KEY = "aantje.connections"
_TOKEN = re.compile(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*.*?\*/', re.S)


def strip_comments(text):
    return _TOKEN.sub(lambda m: m.group(0) if m.group(0).startswith('"') else " ", text)


def existing_connections(path):
    """The array of the current file, or None if there is no file, no key or no valid JSON."""
    try:
        with open(path, encoding="utf-8") as f:
            value = json.loads(strip_comments(f.read())).get(KEY)
    except (OSError, ValueError, AttributeError):
        return None
    return value if isinstance(value, list) else None


def main(argv):
    defaults, target, *profiles = argv
    with open(defaults, encoding="utf-8") as f:
        text = f.read()
    if profiles:
        value = existing_connections(target)
        if value is None:
            with open(profiles[0], encoding="utf-8") as f:
                value = json.load(f)
        body = json.dumps(value, indent=4, ensure_ascii=False).replace("\n", "\n    ")
        head = text[: text.rstrip().rfind("}")].rstrip()
        sep = "" if head.endswith(("{", ",")) else ","
        text = f'{head}{sep}\n\n    "{KEY}": {body}\n}}\n'
    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, target)


if __name__ == "__main__":
    main(sys.argv[1:])
