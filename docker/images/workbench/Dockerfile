# Oog workbench: code-server (VS Code in the browser) with Jupyter, a Python virtualenv holding the
# "oog" package (DuckDB + DuckLake), the aantje extension and the Jupyter kernel "Oog".
# Build context is the repository root:
#   docker build -f images/workbench/Dockerfile -t oog/workbench:0.1.0 .
#
# Extension aantje (DuckLake explorer): installed from a VSIX in images/workbench/aantje/ when one for the platform of
# the image is there (aantje-linux-x64*.vsix or aantje-linux-arm64*.vsix), otherwise from Open VSX as teitelberg.aantje.
# The DuckDB binding of the extension is native, hence one VSIX per platform.
#
# Python constraints: images/workbench/constraints.txt freezes every package of the venv (direct and
# transitive) in the version that was verified together, so a rebuild does not float. pip install uses
# it with -c. After changing a pin in images/workbench/oog/pyproject.toml, regenerate it from a test build:
#   1. keep only the comment lines:   grep '^#' images/workbench/constraints.txt > c.tmp && mv c.tmp images/workbench/constraints.txt
#   2. build the image (it resolves freely now) and check it: pip check, python -m oog.smoke, notebooks
#   3. write the new pins (one line):
#        { grep '^#' images/workbench/constraints.txt; docker run --rm --entrypoint pip <image> freeze --all | grep -v -e '^oog @' -e '^pip=='; } > c.tmp && mv c.tmp images/workbench/constraints.txt
#   4. rebuild, `pip freeze --all` must equal the file (apart from oog and pip), and run pip-audit.
# Run this with sh (LF line endings; PowerShell 5.1 would write UTF-16). Pins also hold back security fixes
# of transitive packages until the file is regenerated.
# The DuckDB extensions (httpfs, postgres, ducklake) are versioned per DuckDB version (the pinned duckdb
# decides the extension repository, e.g. extensions.duckdb.org/v2.0.0/). Only the build of an
# extension within that version cannot be pinned (INSTALL ... VERSION is not available for core
# extensions); the build ids appear in the log of `python -m oog.install_extensions`.
#
# hadolint: DL3066 (named users root/coder; the final USER is numeric), DL3008 (apt packages follow
# the Debian release of the base image, which the CODE_SERVER_VERSION pin fixes).
# hadolint global ignore=DL3066,DL3008

# The default tag is the Debian 13 (trixie) variant; its Python 3.13 is what the venv is built on.
# If CODE_SERVER_VERSION selects another base (-bookworm, -noble, ...), the build stops at the venv check.
ARG CODE_SERVER_VERSION=4.144.0

FROM codercom/code-server:${CODE_SERVER_VERSION}

ARG PYTHON_VERSION=3.13

LABEL org.opencontainers.image.title="oog-workbench" \
      org.opencontainers.image.description="code-server with Jupyter, DuckDB/DuckLake and the aantje extension"

ENV VIRTUAL_ENV=/opt/oog-venv \
    PATH=/opt/oog-venv/bin:${PATH} \
    OOG_DUCKDB_EXTENSION_DIR=/opt/duckdb-extensions \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# --- System packages and directories (the only root steps besides the final one below) -----------
# git-lfs is already part of the base image; it is listed so that the image does not depend on that.
# /home/coder/.local/share/code-server is the mount point of the user data volume: it must exist and
# belong to coder, so that a new named volume inherits the ownership on its first mount (copy-up).
# Every path component is listed, otherwise .local and .local/share would stay owned by root.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv git-lfs \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o coder -g coder /opt/oog /opt/oog-venv /opt/duckdb-extensions /home/coder/workspace \
      /home/coder/.local /home/coder/.local/share /home/coder/.local/share/code-server

USER coder

# --- code-server extensions from Open VSX -------------------------------------------------------
# Outside of /home/coder/workspace (a volume) and read by entrypoint.sh via --extensions-dir. Not on
# a volume itself: extensions installed later in the UI are lost when the container is re-created
# (permanent = extensions.txt plus a rebuild). Script and list (extensions.txt pins the versions) are mounted from the build context, not copied,
# so this layer is rebuilt only when one of these two files changes.
RUN --mount=type=bind,source=images/workbench/code-server/install-extensions.sh,target=/tmp/install-extensions.src.sh \
    --mount=type=bind,source=images/workbench/code-server/extensions.txt,target=/tmp/extensions.txt \
    sed 's/\r$//' /tmp/install-extensions.src.sh > /tmp/install-extensions.sh \
 && sh /tmp/install-extensions.sh /tmp/extensions.txt /opt/oog/extensions \
 && rm -f /tmp/install-extensions.sh

# --- Python virtualenv with the oog package ------------------------------------------------------
# The direct dependency pins (duckdb, jupysql, ipykernel, ...) live in the pyproject.toml
# of oog, all packages together are frozen in constraints.txt (see the header of this file).
# The venv is as ephemeral as the extensions: `pip install` at runtime is lost on re-creation
# (permanent = pyproject.toml plus a rebuild).
RUN python3 -m venv "$VIRTUAL_ENV" \
 && v="$("$VIRTUAL_ENV/bin/python" -c 'import sys; print("%d.%d" % sys.version_info[:2])')" \
 && { [ "$v" = "$PYTHON_VERSION" ] || { echo "workbench venv is Python $v, expected $PYTHON_VERSION (check CODE_SERVER_VERSION)" >&2; exit 1; }; }
# Dependencies first (only constraints.txt and the pyproject.toml are mounted), so a change in the oog
# sources does not reinstall them. The sources are mounted as well instead of copied: no layer keeps them.
# hadolint ignore=DL3042
RUN --mount=type=bind,source=images/workbench/constraints.txt,target=/tmp/constraints.txt \
    --mount=type=bind,source=images/workbench/oog/pyproject.toml,target=/tmp/oog/pyproject.toml \
    --mount=type=cache,target=/tmp/pip-cache,uid=1000,gid=1000 \
    python -c "import tomllib; print(*tomllib.load(open('/tmp/oog/pyproject.toml','rb'))['project']['dependencies'], sep='\n')" > /tmp/requirements.txt \
 && PIP_CACHE_DIR=/tmp/pip-cache pip install -c /tmp/constraints.txt -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt
# hadolint ignore=DL3042
RUN --mount=type=bind,source=images/workbench/constraints.txt,target=/tmp/constraints.txt \
    --mount=type=bind,source=images/workbench/oog,target=/opt/oog/src \
    --mount=type=cache,target=/tmp/pip-cache,uid=1000,gid=1000 \
    PIP_CACHE_DIR=/tmp/pip-cache pip install -c /tmp/constraints.txt --no-deps /opt/oog/src \
 && pip check

# DuckDB extensions (httpfs, postgres, ducklake) are fetched now, so the stack itself needs no internet access
# (ad-hoc queries may still auto-install other core extensions on first use).
RUN python -m oog.install_extensions

# --- aantje ------------------------------------------------------------------------------------------------------
# AANTJE_VERSION selects the version from Open VSX; a new value changes this layer, so Docker rebuilds it (with "latest" the
# layer comes from the cache, set the number to update).
ARG AANTJE_VERSION=latest
# Installed into the same extensions directory as the others; late in the file, so a change of the extension rebuilds
# only this layer and the ones after it. The directory images/workbench/aantje is bind-mounted, so no layer keeps the
# VSIX. The connection profile "Oog Lakehouse" is put next to the default settings only here: entrypoint.sh adds it to
# the machine settings only when that file exists (and the extension is installed), see write-machine-settings.py.
RUN --mount=type=bind,source=images/workbench/aantje,target=/tmp/aantje \
    --mount=type=bind,source=images/workbench/code-server/aantje-connections.json,target=/tmp/aantje-connections.json \
    case "$(uname -m)" in x86_64) plat=linux-x64 ;; aarch64) plat=linux-arm64 ;; *) plat=unknown ;; esac \
 && vsix="$(ls /tmp/aantje/aantje-"$plat"*.vsix 2>/dev/null | head -n 1)" \
 && data="$(mktemp -d)" \
 && { [ -n "$vsix" ] && echo "aantje: installing $vsix" || { echo "aantje: no VSIX for $plat in images/workbench/aantje, installing teitelberg.aantje ($AANTJE_VERSION) from Open VSX"; vsix=teitelberg.aantje; [ "$AANTJE_VERSION" = latest ] || vsix="$vsix@$AANTJE_VERSION"; }; } \
 && NODE_NO_WARNINGS=1 code-server --config "$data/config.yaml" --user-data-dir "$data" \
      --extensions-dir /opt/oog/extensions --install-extension "$vsix" \
 && ids="$(NODE_NO_WARNINGS=1 code-server --config "$data/config.yaml" --user-data-dir "$data" \
      --extensions-dir /opt/oog/extensions --list-extensions)" \
 && case "$ids" in *teitelberg.aantje*) ;; *) echo "teitelberg.aantje is not listed after the install" >&2; exit 1 ;; esac \
 && rm -rf "$data" \
 && install -D -m 644 /tmp/aantje-connections.json /opt/oog/code-server/aantje-connections.json

# --- Start page extension (images/workbench/welcome-extension) ---------------------------------------
# Opens the start page (served by entrypoint.sh, see /opt/oog/startpage below) in the Simple Browser when
# code-server has loaded. Installed like the Open VSX extensions, through the CLI into the same directory
# (so extensions.json lists it): a VSIX is just a zip whose "extension/" folder holds the files, which
# python3 writes here, so the extension needs no build step and no vsce.
RUN --mount=type=bind,source=images/workbench/welcome-extension,target=/tmp/welcome \
    data="$(mktemp -d)" \
 && python3 -c "import zipfile; z = zipfile.ZipFile('/tmp/oog-welcome.vsix', 'w', zipfile.ZIP_DEFLATED); [z.write('/tmp/welcome/' + n, 'extension/' + n) for n in ('package.json', 'extension.js')]; z.close()" \
 && NODE_NO_WARNINGS=1 code-server --config "$data/config.yaml" --user-data-dir "$data" \
      --extensions-dir /opt/oog/extensions --install-extension /tmp/oog-welcome.vsix \
 && ids="$(NODE_NO_WARNINGS=1 code-server --config "$data/config.yaml" --user-data-dir "$data" \
      --extensions-dir /opt/oog/extensions --list-extensions)" \
 && case "$ids" in *oog.oog-welcome*) ;; *) echo "oog.oog-welcome is not listed after the install" >&2; exit 1 ;; esac \
 && rm -rf "$data" /tmp/oog-welcome.vsix

# Every IPython kernel of this environment reads <prefix>/etc/ipython/ipython_config.py and thereby
# loads the oog extension (variable `con`).
COPY --chown=coder:coder images/workbench/ipython_config.py /opt/oog-venv/etc/ipython/ipython_config.py

# --- Kernelspec "Oog", login-shell PATH, git, hardening, entrypoint (root) -----------------------
# /usr/local/share/jupyter is searched by the Jupyter extension and by `jupyter kernelspec list`,
# independent of which Python environment is selected in the editor.
# /etc/profile resets PATH for login shells (which the terminals of code-server are), so the
# virtualenv is put back in front there; otherwise `python` would not exist in a terminal.
# git: LFS filters for all users, and a credential helper for the Gitea of the stack. The helper
# answers `git credential get` from OOG_GITEA_ADMIN_USER/_PASSWORD at run time, nothing is stored.
# It prints nothing when the variables are empty, so git falls back to asking. The `$` are meant
# literally (single quotes): the shell that runs the helper expands them.
# Hardening: the base image grants coder passwordless sudo and ships a setuid fixuid; the entrypoint
# needs neither, and USER 1000 / runAsNonRoot are only worth something without them. Consequence:
# no sudo in the terminal, OS packages belong into this Dockerfile.
USER root
# hadolint ignore=SC2016
RUN python -m ipykernel install --prefix /usr/local --name oog --display-name "Oog" \
 && printf '%s\n' \
      'case ":$PATH:" in *:/opt/oog-venv/bin:*) ;; *) PATH="/opt/oog-venv/bin:$PATH" ;; esac' \
      'export PATH' \
      'export VIRTUAL_ENV=/opt/oog-venv' \
      > /etc/profile.d/oog-venv.sh \
 && git lfs install --system \
 && git config --system credential.http://gitea:3000.helper \
      '!f() { if [ "$1" = get ] && [ -n "$OOG_GITEA_ADMIN_USER" ] && [ -n "$OOG_GITEA_ADMIN_PASSWORD" ]; then printf "username=%s\npassword=%s\n" "$OOG_GITEA_ADMIN_USER" "$OOG_GITEA_ADMIN_PASSWORD"; fi; }; f' \
 && rm -f /etc/sudoers.d/nopasswd \
 && chmod u-s /usr/local/bin/fixuid
COPY --chmod=755 images/workbench/entrypoint.sh /usr/local/bin/oog-workbench-entrypoint
# Tolerate CRLF checkouts on Windows (a CRLF shebang makes the container fail with "no such file or directory").
RUN sed -i 's/\r$//' /usr/local/bin/oog-workbench-entrypoint

USER coder

# Default settings for code-server (copied to the user data dir by the entrypoint) and the examples of the
# workspace repository: notebooks/ and the files of the repository root (fallback copy, used by the
# entrypoint only when the repository directory is empty and the clone of the Gitea repository fails).
COPY --chown=coder:coder images/workbench/code-server/settings.json images/workbench/code-server/machine-settings.json \
    images/workbench/code-server/write-machine-settings.py /opt/oog/code-server/
COPY --chown=coder:coder notebooks/ /opt/oog/workspace-seed/notebooks/
COPY --chown=coder:coder workspace/ /opt/oog/workspace-seed/
# Static start page (index.html + tools.json). entrypoint.sh serves it with `python3 -m http.server` on
# 127.0.0.1:8081 and writes features.json next to it, so the directory must belong to coder.
COPY --chown=coder:coder images/workbench/startpage/ /opt/oog/startpage/

# Numeric user so that Kubernetes runAsNonRoot can verify it.
USER 1000:1000
WORKDIR /home/coder
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --start-interval=2s --retries=5 \
    CMD ["curl", "-fsS", "-o", "/dev/null", "http://localhost:8080/healthz"]

ENTRYPOINT ["/usr/local/bin/oog-workbench-entrypoint"]
