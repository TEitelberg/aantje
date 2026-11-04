#!/bin/sh
# Entrypoint of the Oog workbench image (POSIX sh, runs as user "coder").
#
# Without arguments (or with code-server options) it
#   1. maps OOG_CODE_SERVER_PASSWORD to the PASSWORD variable of code-server (and warns about the demo password)
#   2. workspace repository (folder notebooks/; nothing in this step stops the start):
#        a. sets the global git identity (user.name = OOG_GITEA_ADMIN_USER, user.email = OOG_GITEA_ADMIN_EMAIL)
#           on every start; ~/.gitconfig is not on a volume
#        b. if <workspace>/<repository name> is missing or empty, clones the private Gitea repository
#           $OOG_GITEA_URL/$OOG_GITEA_ADMIN_USER/$OOG_GITEA_REPO.git into it (created and filled by
#           gitea-init). The system-wide credential helper of the image supplies the Gitea login, so the
#           clone, and later commit and push, never ask. A failed clone is retried a few times; if all
#           fail, the examples of the image (/opt/oog/workspace-seed) are copied instead, with a
#           warning (that copy is no git repository)
#        c. a directory with content is never touched (no clone, no copy, no pull)
#   3. installs the default code-server settings (user settings only if the user has none yet; the
#      user data dir is a volume, so they survive when the container is re-created; machine settings on
#      every start, with the aantje connection profile when that extension is installed)
#   4. starts the static start page (python3 -m http.server on 127.0.0.1:8081, background, failures are
#      only logged) and writes features.json for it. code-server proxies it at /proxy/8081/; the extension
#      oog.oog-welcome shows it as an editor tab (webview; the Simple Browser blocks target=_blank links)
#   5. starts code-server with the repository clone as the open folder (the workspace if that
#      directory does not exist), so the Source Control view shows the clone
# Any other command (`docker run <image> bash`) is executed as is, without the setup above.
#
# Paths below must match images/workbench/Dockerfile.
set -eu

case ${1:-} in
    '' | -*) ;;
    *) exec "$@" ;;
esac

HOME=${HOME:-/home/coder}
export HOME

WORKSPACE=/home/coder/workspace
REPO_NAME=${OOG_GITEA_REPO:-oog-workspace}
REPO_DIR=$WORKSPACE/$REPO_NAME
WORKSPACE_SEED=/opt/oog/workspace-seed
STARTPAGE_DIR=/opt/oog/startpage
STARTPAGE_PORT=8081
EXTENSIONS_DIR=/opt/oog/extensions
DEFAULTS_DIR=/opt/oog/code-server
# Mount point of the user data volume (Compose: oog-workbench-userdata, Kubernetes: PVC
# workbench-userdata): settings, secret storage and history live there. EXTENSIONS_DIR and the
# virtualenv are not on a volume and are reset whenever the container is re-created.
USER_DATA_DIR=/home/coder/.local/share/code-server

log() {
    printf 'oog-workbench: %s\n' "$*" >&2
}

# --- 1. password -------------------------------------------------------------------------------
if [ -n "${HASHED_PASSWORD:-}" ]; then
    # code-server prefers the hash; keep a plain-text password out of the process environment.
    unset PASSWORD OOG_CODE_SERVER_PASSWORD
else
    PASSWORD=${OOG_CODE_SERVER_PASSWORD:-${PASSWORD:-change-me}}
    export PASSWORD
    unset OOG_CODE_SERVER_PASSWORD
    # Also true when Compose or Kubernetes pass the default on explicitly.
    if [ "$PASSWORD" = change-me ]; then
        log "warning: code-server uses the demo password 'change-me', set OOG_CODE_SERVER_PASSWORD (.env / oog-secrets)"
    fi
fi

# --- 2. workspace repository ------------------------------------------------------------------------------
GITEA_URL=${OOG_GITEA_URL:-http://gitea:3000}
GITEA_USER=${OOG_GITEA_ADMIN_USER:-}
GITEA_EMAIL=${OOG_GITEA_ADMIN_EMAIL:-admin@oog.local}
CLONE_ATTEMPTS=3
CLONE_TIMEOUT=20
CLONE_PAUSE=2

# Global git identity on every start (~/.gitconfig is lost when the container is re-created).
if [ -n "$GITEA_USER" ]; then
    if ! { git config --global user.name "$GITEA_USER" && git config --global user.email "$GITEA_EMAIL"; }; then
        log "warning: could not write the global git identity (is $HOME writable?)"
    fi
fi

# Clones the workspace repository into the (empty) repository directory. Retries a few times, because
# Gitea may still be starting; every failed attempt leaves the directory empty again.
clone_repo() {
    [ -n "$GITEA_USER" ] || return 1
    url="${GITEA_URL%/}/$GITEA_USER/$REPO_NAME.git"
    attempt=1
    while :; do
        # No prompt (the credential helper answers or the clone fails), and a stuck server cannot hang the start.
        if GIT_TERMINAL_PROMPT=0 timeout "$CLONE_TIMEOUT" git clone --quiet "$url" "$REPO_DIR"; then
            return 0
        fi
        find "$REPO_DIR" -mindepth 1 -delete 2>/dev/null || true
        [ "$attempt" -lt "$CLONE_ATTEMPTS" ] || return 1
        log "clone of $url failed (attempt $attempt of $CLONE_ATTEMPTS), retrying in $CLONE_PAUSE s"
        attempt=$((attempt + 1))
        sleep "$CLONE_PAUSE"
    done
}

seed_repo() {
    if cp -R --no-preserve=mode "$WORKSPACE_SEED"/. "$REPO_DIR"/; then
        log "seeded $REPO_DIR from the image"
    else
        log "warning: could not copy the examples to $REPO_DIR (is the volume writable for uid $(id -u)?)"
        # Empty before the copy, so remove the partial result: the next start tries again.
        find "$REPO_DIR" -mindepth 1 -delete 2>/dev/null || true
    fi
}

# Only into a missing or empty directory (first start of a fresh volume); a directory with content,
# including a failed earlier listing, is left alone.
if mkdir -p "$REPO_DIR" 2>/dev/null; then
    # A failing listing is not an empty directory: it must not lead to a clone or copy over user files.
    if ! listing=$(ls -A "$REPO_DIR" 2>/dev/null); then
        log "warning: cannot list $REPO_DIR, not cloning the repository (is the volume readable for uid $(id -u)?)"
    elif [ -z "$listing" ]; then
        if clone_repo; then
            log "cloned the workspace repository from $GITEA_URL ($GITEA_USER/$REPO_NAME) into $REPO_DIR"
        else
            log "warning: could not clone $GITEA_USER/$REPO_NAME from $GITEA_URL, using the examples of the image (no git repository; empty $REPO_DIR to clone on the next start)"
            if [ -d "$WORKSPACE_SEED" ]; then
                seed_repo
            fi
        fi
    fi
else
    log "warning: cannot create $REPO_DIR (is the volume writable for uid $(id -u)?)"
fi

# --- 3. code-server settings -------------------------------------------------------------------
# True if the aantje extension is part of the image: the Dockerfile installs it and
# puts the connection profile next to the default settings.
aantje_installed() {
    [ -f "$DEFAULTS_DIR/aantje-connections.json" ] || return 1
    for dir in "$EXTENSIONS_DIR"/teitelberg.aantje-*; do
        [ -d "$dir" ] && return 0
    done
    return 1
}

# Machine/settings.json is rewritten from the image on every start. With aantje it also gets the profile
# "Oog Lakehouse" and, when the Quack server has created its certificate, "Oog Quack" (no password or token:
# aantje asks on the first connect and keeps it in the secret storage of the user data dir). Connections that
# users add in aantje land in this file as well, so the script carries the existing "aantje.connections" array
# over and adds the profiles that are missing, instead of replacing it.
#
# The Quack connection pins the certificate of the server (self-signed, in the read-only volume that is mounted
# next to OOG_QUACK_CA_FILE): the fingerprint is computed on every start.
write_quack_profile() {
    [ -n "${OOG_QUACK_CA_FILE:-}" ] && [ -r "$OOG_QUACK_CA_FILE" ] || return 1
    fp="$(openssl x509 -in "$OOG_QUACK_CA_FILE" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//')"
    [ -n "$fp" ] || return 1
    printf '[{"name": "Oog Quack", "kind": "quack", "host": "%s", "port": %s, "ssl": true, "fingerprint": "%s"}]\n' \
        "${OOG_QUACK_HOST:-duckdb}" "${OOG_QUACK_PORT:-9494}" "$fp" > "$1"
}

write_machine_settings() {
    if aantje_installed; then
        quack_profile="$USER_DATA_DIR/Machine/.quack-profile.json"
        if ! write_quack_profile "$quack_profile"; then
            rm -f "$quack_profile"
            log "note: no certificate of the Quack server found, the connection \"Oog Quack\" is not preconfigured"
        fi
        python "$DEFAULTS_DIR/write-machine-settings.py" "$DEFAULTS_DIR/machine-settings.json" \
            "$USER_DATA_DIR/Machine/settings.json" "$DEFAULTS_DIR/aantje-connections.json" \
            $([ -f "$quack_profile" ] && echo "$quack_profile") \
            || { log "warning: could not write the aantje connection profile, using the plain machine settings"
                 cp --no-preserve=mode "$DEFAULTS_DIR/machine-settings.json" "$USER_DATA_DIR/Machine/settings.json"; }
        rm -f "$quack_profile"
    else
        cp --no-preserve=mode "$DEFAULTS_DIR/machine-settings.json" "$USER_DATA_DIR/Machine/settings.json"
    fi
}

install_default_settings() {
    mkdir -p "$USER_DATA_DIR/User" "$USER_DATA_DIR/Machine" || return 1
    if [ ! -f "$USER_DATA_DIR/User/settings.json" ]; then
        cp --no-preserve=mode "$DEFAULTS_DIR/settings.json" "$USER_DATA_DIR/User/settings.json" || return 1
    fi
    write_machine_settings
}
if ! install_default_settings; then
    log "warning: cannot write to $USER_DATA_DIR, default settings are not installed (is the volume writable for uid $(id -u)?)"
fi

# --- 4. start page -----------------------------------------------------------------------------
# Static page (index.html + tools.json) on loopback only; code-server proxies it behind its login at
# /proxy/8081/. features.json tells the page which optional tools exist (it hides the aantje tile
# otherwise). Nothing here may stop code-server from starting.
start_startpage() {
    [ -d "$STARTPAGE_DIR" ] || return 1
    if aantje_installed; then aantje=true; else aantje=false; fi
    printf '{"aantje": %s}\n' "$aantje" > "$STARTPAGE_DIR/features.json" \
        || log "warning: cannot write $STARTPAGE_DIR/features.json, the start page shows only the tools that always exist"
    python3 -m http.server "$STARTPAGE_PORT" --bind 127.0.0.1 --directory "$STARTPAGE_DIR" >/dev/null 2>&1 &
}
if start_startpage; then
    log "start page served on 127.0.0.1:$STARTPAGE_PORT (code-server: /proxy/$STARTPAGE_PORT/)"
else
    log "warning: start page not started ($STARTPAGE_DIR is missing)"
fi

# --- 5. start ----------------------------------------------------------------------------------
# dumb-init (part of the base image) forwards SIGTERM and reaps the processes of kernels/terminals.
#
# Workspace Trust is off on purpose: ms-python.python declares untrustedWorkspaces.supported=false and
# the Jupyter extension cannot run cells in an untrusted workspace, so Restricted Mode would break the
# workbench. Consequence: every folder below $WORKSPACE counts as trusted (workspace settings such as
# python.defaultInterpreterPath or terminal.integrated.profiles.*, tasks.json/launch.json and notebook
# execution run without a prompt), so open only own or reviewed repositories, e.g. clones from Gitea.
# The flag wins over security.workspace.trust.enabled; remove it to get Restricted Mode back.
#
# --enable-remote-storage keeps the workbench storage in the user data dir (volume) instead of the
# browser. Without it the secret storage of code-server lives in the browser tab only: passwords that
# extensions keep there (aantje connections) are asked for again after every reload or new browser, and
# the volume would not help. Consequence: the secrets are stored unencrypted in
# User/globalStorage/state.vscdb of the user data dir (code-server has no keyring); keep that volume private.
#
# The open folder is the clone of the workspace repository, so the Source Control view shows that repository (commit and
# push work through the credential helper of the image). The terminals start there too.
if [ -d "$REPO_DIR" ]; then OPEN_DIR=$REPO_DIR; else OPEN_DIR=$WORKSPACE; fi

# code-server remembers the last opened folder (coder.json in the user data dir, a volume) and opens it in preference to the
# folder argument. After the workspace repository had moved (workspace/notebooks -> workspace/oog-workspace) an old volume
# kept opening the old clone, which is not the workspace repository. So the remembered folder is pointed at the repository when it is missing
# or is the old notebooks clone; any other folder the user chose stays. Failures are harmless.
if [ -d "$USER_DATA_DIR" ] && command -v python3 >/dev/null 2>&1; then
    python3 - "$USER_DATA_DIR/coder.json" "$OPEN_DIR" "$WORKSPACE/notebooks" <<'PY' || log "warning: could not update the remembered folder in coder.json"
import json
import os
import sys

path, folder, old_clone = sys.argv[1:4]
try:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
except (OSError, ValueError):
    data = {}
if not isinstance(data, dict):
    data = {}
query = data.get("query") if isinstance(data.get("query"), dict) else {}
current = query.get("folder")
if folder != current and (not current or not os.path.isdir(current) or os.path.normpath(current) == os.path.normpath(old_clone)):
    query["folder"] = folder
    data["query"] = query
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
PY
fi

exec dumb-init -- code-server \
    --bind-addr 0.0.0.0:8080 \
    --auth password \
    --disable-telemetry \
    --disable-update-check \
    --disable-workspace-trust \
    --enable-remote-storage \
    --user-data-dir "$USER_DATA_DIR" \
    --extensions-dir "$EXTENSIONS_DIR" \
    "$@" \
    "$OPEN_DIR"
