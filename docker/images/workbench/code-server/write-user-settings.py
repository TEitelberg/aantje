"""Adds the default connection of the PostgreSQL extension to <user data dir>/User/settings.json (called by
entrypoint.sh at container start, when the extension is installed).

Usage: write-user-settings.py DEFAULTS TARGET

DEFAULTS is a JSON file with the default value of "pgsql.connections" (an array). The setting is resource-scoped and
the extension saves the connections that users add to the user settings, so the default goes there too: a machine
setting would win over the user settings in code-server and hide the users' own connections. TARGET is changed only
while it has no "pgsql.connections" yet; the array is then added before the closing brace, and the rest of the file,
comments included, stays as it is. Once the key exists, the file belongs to the extension and the user.
"""

import json
import os
import re
import sys

KEY = "pgsql.connections"
_TOKEN = re.compile(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*.*?\*/', re.S)


def strip_comments(text):
    return _TOKEN.sub(lambda m: m.group(0) if m.group(0).startswith('"') else " ", text)


def main(argv):
    defaults, target = argv
    with open(target, encoding="utf-8") as f:
        text = f.read()
    try:
        current = json.loads(strip_comments(text) or "{}")
    except ValueError:
        # A file that is no valid JSON with comments is the user's to fix; it is not touched.
        return
    if not isinstance(current, dict) or KEY in current:
        return
    with open(defaults, encoding="utf-8") as f:
        value = json.load(f)
    body = json.dumps(value, indent=4, ensure_ascii=False).replace("\n", "\n    ")
    end = text.rstrip().rfind("}")
    head = text[:end].rstrip() if end >= 0 else "{"
    sep = "" if head.endswith(("{", ",")) else ","
    text = f'{head}{sep}\n\n    // Added by the image: the PostgreSQL server of the stack.\n    "{KEY}": {body}\n}}\n'
    tmp = target + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, target)


if __name__ == "__main__":
    main(sys.argv[1:])
