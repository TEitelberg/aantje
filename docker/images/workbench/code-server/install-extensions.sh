#!/bin/sh
# Installs the pinned Open VSX extensions of extensions.txt into an extensions directory.
# Runs at image build time as user "coder" and fails the build if the result differs from the list.
#
# Usage: install-extensions.sh <extensions.txt> <extensions-dir>
set -eu

list=$1
dir=$2

data=$(mktemp -d)
wanted=$(mktemp)
wanted_lc=$(mktemp)
out=$(mktemp)
trap 'rm -rf "$data" "$wanted" "$wanted_lc" "$out"' EXIT

# Throw-away user data dir and config file: nothing of the CLI ends up in $HOME.
cs() {
    NODE_NO_WARNINGS=1 code-server --config "$data/config.yaml" --user-data-dir "$data" \
        --extensions-dir "$dir" "$@"
}

# Retries for about 2.5 minutes (waits of 15/30/45/60 s) so that a short network outage does not
# abort the build; a pin that does not exist ("not found") fails at once.
install_with_retry() {
    attempt=1
    max=5
    while :; do
        if cs --install-extension "$1" > "$out" 2>&1; then
            cat "$out"
            return 0
        fi
        cat "$out" >&2
        if grep -q 'not found' "$out" || [ "$attempt" -ge "$max" ]; then
            return 1
        fi
        echo "install-extensions: $1 failed (attempt $attempt of $max), retrying in $((attempt * 15)) s" >&2
        sleep $((attempt * 15))
        attempt=$((attempt + 1))
    done
}

# Strip CR, indentation, comments and blank lines.
tr -d '\r' < "$list" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    | grep -v -e '^$' -e '^#' > "$wanted" || true
grep -v '^-' "$wanted" | tr '[:upper:]' '[:lower:]' > "$wanted_lc" || true

mkdir -p "$dir"

while IFS= read -r ext; do
    case $ext in
        -*) ;;
        *) install_with_retry "$ext" ;;
    esac
done < "$wanted"

# "-publisher.name": drop pack members that are not wanted. The CLI only marks the folder as
# obsolete (removed on the next start), so remove it right away to keep the image clean.
while IFS= read -r ext; do
    case $ext in
        -*)
            id=$(printf '%s' "${ext#-}" | tr '[:upper:]' '[:lower:]')
            cs --uninstall-extension "$id" || true
            for d in "$dir/$id"-*; do
                if [ -e "$d" ]; then rm -rf "$d"; fi
            done
            ;;
    esac
done < "$wanted"
rm -f "$dir/.obsolete"

installed=$(cs --list-extensions --show-versions 2>/dev/null \
    | grep -E '^[^[:space:]]+@[^[:space:]]+$' | tr '[:upper:]' '[:lower:]' | sort || true)

status=0
missing=$(printf '%s\n' "$installed" | grep -v -x -F -f "$wanted_lc" || true)
if [ -n "$missing" ]; then
    echo "install-extensions: installed but not listed in $list (pin it or remove it with '-'):" >&2
    # shellcheck disable=SC2086 # one extension id per line, split on purpose (printf repeats the format)
    printf '  %s\n' $missing >&2
    status=1
fi
while IFS= read -r ext; do
    if ! printf '%s\n' "$installed" | grep -q -x -F "$ext"; then
        echo "install-extensions: missing after install: $ext" >&2
        status=1
    fi
done < "$wanted_lc"

echo "Installed extensions in $dir:"
# shellcheck disable=SC2086 # as above
printf '  %s\n' $installed
du -sh "$dir"
exit "$status"
