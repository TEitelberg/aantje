#!/bin/sh
# Create the private workspace repository in Gitea (folder notebooks/) and push the examples as the first commit.
# Second step of the gitea-init job (started by init-admin.sh once the administrator is in place).
# The repository is only created when it does not exist; an existing repository is never touched.
#
# Environment:
#   OOG_GITEA_URL             base URL of Gitea                        (default http://gitea:3000)
#   OOG_GITEA_REPO            repository name; set but empty = skip    (default oog-workspace)
#   OOG_GITEA_ADMIN_USER      owner of the repository and login        (default oogadmin)
#   OOG_GITEA_ADMIN_EMAIL     commit e-mail address                    (default admin@oog.local)
#   OOG_GITEA_ADMIN_PASSWORD  login (secret)                           (required)
#   OOG_WORKSPACE_SEED        directory with the files of the first commit (default /opt/oog/workspace-seed)
#   OOG_BOOTSTRAP_TIMEOUT     seconds to wait for the Gitea API        (default 120)
#   OOG_BOOTSTRAP_INTERVAL    pause between attempts in seconds        (default 2)
#
# The password never appears in an argument list or in the output: curl reads it from a config on
# stdin, git asks a GIT_ASKPASS helper that reads it from the environment.
# If the push fails after the repository was created, the empty repository is deleted again so that
# the next run starts over.
#
# Exit status: 0 repository exists (created or already there) or the function is off, 1 failed.
set -eu

log()  { printf '[gitea-init] %s\n' "$*"; }
warn() { printf '[gitea-init] %s\n' "$*" >&2; }
die()  { warn "ERROR: workspace repository: $*"; exit 1; }

repo=${OOG_GITEA_REPO-oog-workspace}
if [ -z "$repo" ]; then
  log "OOG_GITEA_REPO is empty, skipping the workspace repository"
  exit 0
fi

url=${OOG_GITEA_URL:-http://gitea:3000}
url=${url%/}
user=${OOG_GITEA_ADMIN_USER:-oogadmin}
email=${OOG_GITEA_ADMIN_EMAIL:-admin@oog.local}
password=${OOG_GITEA_ADMIN_PASSWORD:-}
seed=${OOG_WORKSPACE_SEED:-/opt/oog/workspace-seed}
max_wait=${OOG_BOOTSTRAP_TIMEOUT:-120}
interval=${OOG_BOOTSTRAP_INTERVAL:-2}

[ -n "$password" ] || die "OOG_GITEA_ADMIN_PASSWORD is not set"
case $repo in
  [!A-Za-z0-9]*|*[!A-Za-z0-9._-]*) die "'$repo' is not a valid repository name (letters, digits, - _ .; start with a letter or digit)" ;;
esac
[ "${#repo}" -le 100 ] || die "repository name is longer than 100 characters"
case $max_wait$interval in ''|*[!0-9]*) die "OOG_BOOTSTRAP_TIMEOUT and OOG_BOOTSTRAP_INTERVAL must be whole numbers" ;; esac
[ "$interval" -ge 1 ] || interval=1
[ -f "$seed/README.md" ] || die "seed directory $seed has no README.md"
# Plain "ls" would treat a missing match as a literal name; test the glob explicitly.
have_nb=0
for f in "$seed"/notebooks/*/*.ipynb; do [ -f "$f" ] && have_nb=1; done
[ "$have_nb" -eq 1 ] || die "seed directory $seed has no notebooks/<folder>/ with notebooks"

# The base image points TMPDIR at a directory that only its own entrypoint creates.
work=$(mktemp -d 2>/dev/null || TMPDIR=/tmp mktemp -d)
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
trap 'warn "interrupted"; exit 143' INT TERM

# Basic auth header for curl, handed over through a config on stdin (base64 needs no quoting).
auth=$(printf '%s:%s' "$user" "$password" | base64 | tr -d '\n')

# api METHOD PATH [curl args...]: prints the HTTP status (000 on a connection error); body in $work/body.
api() {
  _m=$1; _p=$2; shift 2
  printf 'header = "Authorization: Basic %s"\n' "$auth" |
    curl -s -o "$work/body" -w '%{http_code}' --connect-timeout 5 --max-time 60 --config - \
      -X "$_m" -H 'Accept: application/json' "$@" "$url/api/v1$_p" 2>"$work/curl.err" || true
}

body_msg() { head -c 300 "$work/body" 2>/dev/null | tr '\n\t' '  '; }

start=$(date +%s)
log "waiting for the Gitea API at $url (timeout ${max_wait}s)"
while :; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 "$url/api/healthz" 2>/dev/null || true)
  [ "$code" = 200 ] && break
  elapsed=$(( $(date +%s) - start ))
  [ "$elapsed" -lt "$max_wait" ] || die "the Gitea API at $url did not answer within ${elapsed}s (last status ${code:-none})"
  sleep "$interval"
done

code=$(api GET "/repos/$user/$repo")
case $code in
  200) log "repository $user/$repo already exists, leaving it untouched"; exit 0 ;;
  404) ;;
  401) die "login as '$user' was rejected (HTTP 401); check OOG_GITEA_ADMIN_PASSWORD" ;;
  *)   die "unexpected answer while looking up $user/$repo: HTTP $code $(body_msg) $(head -c 200 "$work/curl.err")" ;;
esac

log "creating private repository $user/$repo"
printf '{"name":"%s","private":true,"auto_init":false,"default_branch":"main","description":"Oog workspace: notebooks"}' "$repo" >"$work/create.json"
code=$(api POST /user/repos -H 'Content-Type: application/json' --data-binary "@$work/create.json")
case $code in
  201) ;;
  409) log "repository $user/$repo was created by a parallel run, leaving it untouched"; exit 0 ;;
  *)   die "could not create $user/$repo: HTTP $code $(body_msg)" ;;
esac

drop_repo() {
  c=$(api DELETE "/repos/$user/$repo")
  if [ "$c" = 204 ]; then
    warn "the empty repository $user/$repo was deleted again, the next run starts over"
  else
    warn "could not delete the empty repository $user/$repo (HTTP $c); delete it by hand before the next run"
  fi
}

# Credentials for git come from the environment through an askpass helper (not from the argument list).
cat >"$work/askpass.sh" <<'ASK'
#!/bin/sh
case $1 in
  Username*) printf '%s\n' "$OOG_GITEA_ADMIN_USER" ;;
  *) printf '%s\n' "$OOG_GITEA_ADMIN_PASSWORD" ;;
esac
ASK
chmod 700 "$work/askpass.sh"

mkdir "$work/repo" "$work/home"
cp -R "$seed"/. "$work/repo/"
export HOME="$work/home" GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$work/askpass.sh" \
       OOG_GITEA_ADMIN_USER="$user" OOG_GITEA_ADMIN_PASSWORD="$password" \
       GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null

push_first_commit() {
  cd "$work/repo"
  git init -q -b main &&
  git -c user.name="$user" -c user.email="$email" add -A &&
  git -c user.name="$user" -c user.email="$email" commit -q -m "Add example notebooks" &&
  git push -q "$url/$user/$repo.git" main
}

rc=0
out=$(push_first_commit 2>&1) || rc=$?
if [ "$rc" -ne 0 ]; then
  warn "ERROR: workspace repository: the first commit could not be pushed (exit status $rc)"
  printf '%s\n' "$out" | head -n 10 | while IFS= read -r line; do warn "$line"; done
  drop_repo
  exit 1
fi
log "repository $user/$repo created with the example notebooks"
