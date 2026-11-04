#!/bin/sh
# Create the Gitea administrator (idempotent) or bring its password in line with the configuration.
# One-shot init for Docker Compose (service gitea-init) and the Kubernetes Job. Runs inside the
# oog/gitea-init image, whose entrypoint renders /etc/gitea/app.ini from the GITEA__* variables first.
#
# Environment (see docs/conventions.md):
#   OOG_GITEA_ADMIN_USER      administrator name, Gitea rules (ASCII letters, digits, - _ .;
#                             at most 40 characters)                      (default oogadmin)
#   OOG_GITEA_ADMIN_EMAIL     administrator e-mail address                (default admin@oog.local)
#   OOG_GITEA_ADMIN_PASSWORD  at least 8 characters                       (required, secret)
#   GITEA__database__*        same database as the server: DB_TYPE, HOST, NAME, USER, PASSWD
#                             (DB_TYPE, HOST, NAME and USER are required: without DB_TYPE Gitea silently
#                             falls back to a local SQLite file and this job would "succeed" there)
# Optional tuning:
#   OOG_BOOTSTRAP_TIMEOUT   give up waiting for the Gitea database after this many seconds  (default 120)
#   OOG_BOOTSTRAP_INTERVAL  pause between attempts in seconds                                (default 2)
#
# The job first waits until "gitea admin user list" works. On a fresh database that is the case only
# after the server has run its migrations. The name is looked up literally and without regard to case
# (Gitea user names are case-insensitive); a missing user is created as administrator, an existing one
# gets its password synchronised. An existing user that is not an administrator is never touched.
# If "create" fails because another run was faster, the user is looked up again and handled as existing.
#
# Afterwards it runs create-workspace-repo.sh (see there; OOG_GITEA_URL, OOG_GITEA_REPO).
#
# Exit status: 0 administrator is in place (and the workspace repository step succeeded), 1 failed
# (database not ready in time, Gitea error, user is not an administrator, workspace repository step),
# 2 invalid configuration.
#
# Known limit: the gitea CLI takes the password only as an argument (--password), so it is visible in
# the process list of this container while the command runs. The script never prints it.
set -eu

log()  { printf '[gitea-init] %s\n' "$*"; }
warn() { printf '[gitea-init] %s\n' "$*" >&2; }
die()  { code=$1; shift; warn "ERROR: $*"; exit "$code"; }

trap 'warn "interrupted"; exit 143' INT TERM

is_uint() {
  case $1 in ''|*[!0-9]*) return 1 ;; esac
  [ "${#1}" -le 9 ]
}

# Decimal value without leading zeros: $(( )) reads 010 as octal (8) and fails on 08 and 09.
dec() { _n=${1#"${1%%[!0]*}"}; printf '%s' "${_n:-0}"; }

# Gitea rules: starts with a letter or digit, then letters, digits, - _ .; no two special characters in
# a row and none at the end; at most 40 characters.
valid_username() {
  case $1 in
    ''|[!A-Za-z0-9]*|*[!A-Za-z0-9._-]*|*[-._][-._]*|*[-._]) return 1 ;;
  esac
  [ "${#1}" -le 40 ]
}

user=${OOG_GITEA_ADMIN_USER:-oogadmin}
email=${OOG_GITEA_ADMIN_EMAIL:-admin@oog.local}
password=${OOG_GITEA_ADMIN_PASSWORD:-}
max_wait=${OOG_BOOTSTRAP_TIMEOUT:-120}
interval=${OOG_BOOTSTRAP_INTERVAL:-2}

[ -n "$password" ] || die 2 "OOG_GITEA_ADMIN_PASSWORD is not set"
[ "${#password}" -ge 8 ] || die 2 "OOG_GITEA_ADMIN_PASSWORD needs at least 8 characters"
valid_username "$user" ||
  die 2 "OOG_GITEA_ADMIN_USER '$user' is not a valid Gitea user name (letters, digits, - _ .; start with a letter or digit, no special character at the end or twice in a row; at most 40 characters)"
case $email in
  ''|*[[:space:]]*|*@*@*|@*|*@) die 2 "OOG_GITEA_ADMIN_EMAIL '$email' is not a valid e-mail address" ;;
  *@*) ;;
  *) die 2 "OOG_GITEA_ADMIN_EMAIL '$email' is not a valid e-mail address" ;;
esac
is_uint "$max_wait" || die 2 "OOG_BOOTSTRAP_TIMEOUT must be a whole number of seconds (got '$max_wait')"
is_uint "$interval" || die 2 "OOG_BOOTSTRAP_INTERVAL must be a whole number of seconds (got '$interval')"
[ "$interval" -ge 1 ] || die 2 "OOG_BOOTSTRAP_INTERVAL must be at least 1"
max_wait=$(dec "$max_wait")
interval=$(dec "$interval")

for v in GITEA__database__DB_TYPE GITEA__database__HOST GITEA__database__NAME GITEA__database__USER; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || die 2 "$v is not set (the job must use the same database as the Gitea server)"
done
[ "${GITEA__database__DB_TYPE:-}" != sqlite3 ] ||
  die 2 "GITEA__database__DB_TYPE must name the database of the Gitea server, not sqlite3"

# Print the non-empty lines of $2 through the function $1 (log or warn).
relay() {
  [ -n "$2" ] || return 0
  printf '%s\n' "$2" | sed '/^[[:space:]]*$/d' | while IFS= read -r line; do "$1" "$line"; done
}

# First lines of a gitea message as one short line.
oneline() {
  printf '%s\n' "$1" | sed '/^[[:space:]]*$/d' |
    awk 'NR <= 2 { printf "%s%s", (NR > 1 ? " " : ""), $0 }' | tr '\t' ' ' | sed 's/  */ /g' | cut -c1-400
}

# Return 0 if the listing $1 ("gitea admin user list" output) contains the user: second column, whole
# word, case-insensitive; rows are the lines that start with the numeric id. No regular expressions.
is_listed() {
  printf '%s\n' "$1" |
    U=$user awk '$1 ~ /^[0-9]+$/ && tolower($2) == tolower(ENVIRON["U"]) { found = 1 } END { exit !found }'
}

start=$(date +%s)
users=''
err=''

# Wait until "gitea admin user list" succeeds (database reachable and migrated), at most $max_wait seconds.
wait_for_gitea() {
  last_msg=''
  last_log=-100
  log "waiting for the Gitea database (timeout ${max_wait}s)"
  while :; do
    elapsed=$(( $(date +%s) - start ))
    left=$(( max_wait - elapsed ))
    # One attempt must not outlast the deadline by much; Gitea itself retries a missing database for ~30 s.
    t=$left
    [ "$t" -ge 10 ] || t=10
    [ "$t" -le 60 ] || t=60
    rc=0
    users=$(timeout "$t" gitea admin user list 2>&1) || rc=$?
    if [ "$rc" -eq 0 ]; then
      log "Gitea database is ready ($(( $(date +%s) - start ))s)"
      return 0
    fi
    err=$users
    [ "$rc" -ne 143 ] || err="gitea admin user list did not finish within ${t}s"
    elapsed=$(( $(date +%s) - start ))
    left=$(( max_wait - elapsed ))
    if [ "$left" -le 0 ]; then
      warn "ERROR: the Gitea database is not ready after ${elapsed}s"
      warn "Last error: $(oneline "$err")"
      warn "Hint: check that the gitea service is healthy and that the GITEA__database__* variables match the server."
      exit 1
    fi
    msg=$(oneline "$err")
    if [ "$msg" != "$last_msg" ] || [ $(( elapsed - last_log )) -ge 10 ]; then
      log "waiting (${elapsed}s/${max_wait}s): $msg"
      last_msg=$msg
      last_log=$elapsed
    fi
    if [ "$left" -lt "$interval" ]; then sleep "$left"; else sleep "$interval"; fi
  done
}

# Exit 1 unless the user is an administrator.
require_admin() {
  rc=0
  admins=$(gitea admin user list --admin 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    warn "ERROR: could not list the administrators (exit status $rc)"
    relay warn "$admins"
    exit 1
  fi
  is_listed "$admins" ||
    die 1 "user '$user' exists but is not an administrator; promote it in Gitea or set OOG_GITEA_ADMIN_USER to another name"
}

sync_password() {
  require_admin
  log "administrator '$user' exists, synchronising the password"
  rc=0
  out=$(gitea admin user change-password --username "$user" --password="$password" --must-change-password=false 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    warn "ERROR: could not change the password of '$user' (exit status $rc)"
    relay warn "$out"
    exit 1
  fi
}

# Create the administrator. If that fails, look the user up again: a parallel run may have been faster
# (then it is handled as existing). While the server is still creating the tables, "list" already works
# but "create" can fail with "relation ... does not exist"; that is retried until the deadline.
create_admin() {
  while :; do
    rc=0
    out=$(gitea admin user create --admin --username "$user" --email "$email" --password="$password" --must-change-password=false 2>&1) || rc=$?
    if [ "$rc" -eq 0 ]; then
      log "administrator '$user' created"
      return 0
    fi
    rc2=0
    users=$(gitea admin user list 2>&1) || rc2=$?
    if [ "$rc2" -eq 0 ] && is_listed "$users"; then
      log "user '$user' was created by a parallel run"
      sync_password
      return 0
    fi
    case $out in
      *'does not exist'*)
        if [ $(( max_wait - ( $(date +%s) - start ) )) -gt "$interval" ]; then
          log "database schema is not complete yet, retrying: $(oneline "$out")"
          sleep "$interval"
          continue
        fi ;;
      *) ;;
    esac
    warn "ERROR: could not create administrator '$user' (exit status $rc)"
    relay warn "$out"
    exit 1
  done
}

wait_for_gitea

if is_listed "$users"; then
  sync_password
else
  log "creating administrator '$user'"
  create_admin
fi

log "administrator is in place"

# Second step: workspace repository (notebooks). A failure here does not undo the administrator, but fails the job.
sh /usr/local/bin/oog-gitea-workspace || {
  warn "ERROR: the workspace repository step failed (the administrator is in place)"
  exit 1
}
log "done"
