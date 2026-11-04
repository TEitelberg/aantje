#!/bin/sh
# Create the databases and login roles of the Oog tools on the shared Postgres server (idempotent).
# One-shot init for Docker Compose (service postgres-init) and the Kubernetes Job.
#
# Environment (see docs/conventions.md):
#   OOG_PG_HOST            Postgres host                              (default postgres)
#   OOG_PG_PORT            Postgres port                              (default 5432)
#   OOG_PG_USER            superuser = POSTGRES_USER of the server    (default ducklake)
#   OOG_PG_PASSWORD        superuser password                         (required, secret)
#   OOG_PG_DB              DuckLake database, never taken over        (optional, only checked)
#   OOG_GITEA_DB           Gitea database                             (default gitea)
#   OOG_GITEA_DB_USER      Gitea role                                 (default gitea)
#   OOG_GITEA_DB_PASSWORD  Gitea role password                        (required, secret)
# Optional tuning:
#   OOG_BOOTSTRAP_TIMEOUT   give up waiting for Postgres after this many seconds  (default 120)
#   OOG_BOOTSTRAP_INTERVAL  pause between attempts in seconds                     (default 2)
#
# Every tool gets one LOGIN role and one database it owns (UTF8, created from template0). A missing
# role is created, an existing one only gets its password synchronised; a missing database is
# created, an existing one with a different owner is handed to the role. To add a tool, add one
# ensure_database line at the bottom. Connects to the maintenance database "postgres". Parallel runs
# take turns (advisory lock), and statement logging is switched off for the session so that the
# passwords stay out of the server log.
#
# Exit status: 0 roles and databases are in place, 1 failed (Postgres not ready in time, SQL error,
# login check), 2 invalid configuration. Passwords are never printed and never appear in a command
# line: psql gets them through its environment (PGPASSWORD, \getenv).
set -eu

log()  { printf '[postgres-init] %s\n' "$*"; }
warn() { printf '[postgres-init] %s\n' "$*" >&2; }
die()  { code=$1; shift; warn "ERROR: $*"; exit "$code"; }

trap 'warn "interrupted"; exit 143' INT TERM

is_uint() {
  case $1 in ''|*[!0-9]*) return 1 ;; esac
  [ "${#1}" -le 9 ]
}

# Database and role names: ASCII letters, digits, "_" and "-"; not starting with a digit or "-"; at most 63 characters.
valid_name() {
  case $1 in ''|[!A-Za-z_]*|*[!A-Za-z0-9_-]*) return 1 ;; esac
  [ "${#1}" -le 63 ]
}

# Decimal value without leading zeros: $(( )) reads 010 as octal (8) and fails on 08 and 09.
dec() { _n=${1#"${1%%[!0]*}"}; printf '%s' "${_n:-0}"; }

pg_host=${OOG_PG_HOST:-postgres}
pg_port=${OOG_PG_PORT:-5432}
pg_user=${OOG_PG_USER:-ducklake}
max_wait=${OOG_BOOTSTRAP_TIMEOUT:-120}
interval=${OOG_BOOTSTRAP_INTERVAL:-2}

[ -n "${OOG_PG_PASSWORD:-}" ] || die 2 "OOG_PG_PASSWORD is not set"
{ is_uint "$pg_port" && [ "$pg_port" -ge 1 ] && [ "$pg_port" -le 65535 ]; } ||
  die 2 "OOG_PG_PORT must be a port number (got '$pg_port')"
is_uint "$max_wait" || die 2 "OOG_BOOTSTRAP_TIMEOUT must be a whole number of seconds (got '$max_wait')"
is_uint "$interval" || die 2 "OOG_BOOTSTRAP_INTERVAL must be a whole number of seconds (got '$interval')"
[ "$interval" -ge 1 ] || die 2 "OOG_BOOTSTRAP_INTERVAL must be at least 1"
max_wait=$(dec "$max_wait")
interval=$(dec "$interval")

psql_major=$(psql --version | sed -n 's/^psql (PostgreSQL) \([0-9][0-9]*\).*/\1/p')
[ "${psql_major:-99}" -ge 15 ] ||
  die 2 "psql $psql_major is too old, 15 or newer is required (\\getenv); use POSTGRES_VERSION 15 or newer"

# Connection of psql and pg_isready (libpq environment). The password stays in the process environment.
export PGHOST="$pg_host" PGPORT="$pg_port" PGUSER="$pg_user" PGPASSWORD="$OOG_PG_PASSWORD"
export PGDATABASE=postgres PGCONNECT_TIMEOUT=5

psql_run() { psql -X -q -w -v ON_ERROR_STOP=1 -v VERBOSITY=terse "$@"; }

# Print the non-empty lines of $2 through the function $1 (log or warn).
relay() {
  [ -n "$2" ] || return 0
  printf '%s\n' "$2" | sed '/^[[:space:]]*$/d' | while IFS= read -r line; do "$1" "$line"; done
}

# First lines of a psql or pg_isready message as one short line, without the "psql: error: " prefix.
oneline() {
  printf '%s\n' "$1" | sed -e '/^[[:space:]]*$/d' -e 's/^psql: error: //' |
    awk 'NR <= 2 { printf "%s%s", (NR > 1 ? " " : ""), $0 }' | tr '\t' ' ' | sed 's/  */ /g' | cut -c1-400
}

# Return 0 if Postgres accepts connections and the superuser can log in; otherwise 1 and $err holds the reason.
probe_postgres() {
  rc=0
  out=$(pg_isready -t 5 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    err=$out
    return 1
  fi
  if out=$(psql_run -t -A -c 'SELECT 1' 2>&1); then
    return 0
  fi
  err=$out
  return 1
}

give_up() {
  case $err in
    *' - no response'*)  # pg_isready does not say why; let psql explain (DNS, refused, timeout)
      why=$(psql_run -c 'SELECT 1' 2>&1 || true)
      [ -z "$why" ] || err=$why ;;
  esac
  warn "ERROR: postgres at $pg_host:$pg_port is not ready after ${1}s (user '$pg_user')"
  warn "Last error: $(oneline "$err")"
  case $err in
    *'password authentication failed'*|*'no pg_hba.conf entry'*)
      warn "Hint: OOG_PG_USER / OOG_PG_PASSWORD must match POSTGRES_USER / POSTGRES_PASSWORD of the postgres service."
      warn "Postgres reads them only when it creates its data directory; after a later change, recreate the data volume (Compose: docker compose down -v) or change the password inside Postgres." ;;
    *' - no response'*|*'Connection refused'*|*'could not translate host name'*|*'timeout expired'*|*'Name or service not known'*)
      warn "Hint: Postgres is not reachable; check that the postgres service is running and that OOG_PG_HOST / OOG_PG_PORT are correct." ;;
  esac
  exit 1
}

start=$(date +%s)
pg_ready=0
err=''

# Wait (once per run) until Postgres is up and accepts the superuser login, at most $max_wait seconds.
wait_for_postgres() {
  [ "$pg_ready" -eq 0 ] || return 0
  last_msg=''
  last_log=-100
  log "waiting for postgres at $pg_host:$pg_port (user $pg_user, timeout ${max_wait}s)"
  while :; do
    if probe_postgres; then
      pg_ready=1
      log "postgres is ready ($(( $(date +%s) - start ))s)"
      return 0
    fi
    elapsed=$(( $(date +%s) - start ))
    left=$(( max_wait - elapsed ))
    [ "$left" -gt 0 ] || give_up "$elapsed"
    msg=$(oneline "$err")
    if [ "$msg" != "$last_msg" ] || [ $(( elapsed - last_log )) -ge 10 ]; then
      log "waiting (${elapsed}s/${max_wait}s): $msg"
      last_msg=$msg
      last_log=$elapsed
    fi
    if [ "$left" -lt "$interval" ]; then sleep "$left"; else sleep "$interval"; fi
  done
}

# Role and database for one tool. The values arrive in OOG_TARGET_* (environment, not arguments) and
# are read with \getenv; psql quotes them (:"x" identifier, :'x' literal), so no SQL is assembled here.
apply_sql() {
  psql_run <<'SQL'
\getenv db OOG_TARGET_DB
\getenv role OOG_TARGET_ROLE
\getenv pw OOG_TARGET_PASSWORD

-- CREATE/ALTER ROLE carry the password in clear text; keep these statements out of the server log, also
-- when one of them fails (log_min_error_statement) and when the server samples statements for logging
-- (PostgreSQL 13+: log_min_duration_sample, log_transaction_sample_rate) or dumps parse trees (debug_print_*).
-- Needs a superuser, skipped otherwise.
DO $$
BEGIN
  PERFORM set_config('log_statement', 'none', false),
          set_config('log_min_duration_statement', '-1', false),
          set_config('log_min_error_statement', 'panic', false),
          set_config('debug_print_parse', 'off', false),
          set_config('debug_print_rewritten', 'off', false),
          set_config('debug_print_plan', 'off', false);
  IF current_setting('server_version_num')::int >= 130000 THEN
    PERFORM set_config('log_min_duration_sample', '-1', false),
            set_config('log_transaction_sample_rate', '0', false);
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'statement logging could not be switched off (not a superuser)';
END
$$;

-- Parallel runs (second compose up, Job retry) take turns instead of racing on CREATE ROLE/DATABASE.
-- The lock is held until this psql session ends.
SET lock_timeout = '30s';
SELECT pg_advisory_lock(hashtext('oog.postgres-init')) AS locked \gset

SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') AS role_exists,
       EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') AS db_exists,
       COALESCE((SELECT o.rolname FROM pg_database d JOIN pg_roles o ON o.oid = d.datdba
                  WHERE d.datname = :'db'), '') AS db_owner \gset

\if :role_exists
  ALTER ROLE :"role" WITH LOGIN PASSWORD :'pw';
  \echo role :"role" exists, login enabled and password synchronised
\else
  CREATE ROLE :"role" WITH LOGIN PASSWORD :'pw';
  \echo role :"role" created
\endif

\if :db_exists
  SELECT :'db_owner' <> :'role' AS owner_differs \gset
  \if :owner_differs
    ALTER DATABASE :"db" OWNER TO :"role";
    \echo database :"db" exists, owner changed from :"db_owner" to :"role"
  \else
    \echo database :"db" exists
  \endif
\else
  CREATE DATABASE :"db" OWNER :"role" TEMPLATE template0 ENCODING 'UTF8';
  \echo database :"db" created
\endif
SQL
}

# Log in as the tool role (proves password, pg_hba and CONNECT) and check that it may create tables in
# schema public, which Postgres 15+ no longer grants to everybody.
check_login() {
  (
    PGUSER=$role PGPASSWORD=$password PGDATABASE=$db
    export PGUSER PGPASSWORD PGDATABASE
    psql_run -t -A -c "SELECT has_schema_privilege('public', 'CREATE')"
  )
}

# ensure_database <database> <role> <password>
ensure_database() {
  db=$1
  role=$2
  password=$3
  valid_name "$db" || die 2 "invalid database name '$db' (letters, digits, _ and -; at most 63 characters; not starting with a digit or -)"
  valid_name "$role" || die 2 "invalid role name '$role' (letters, digits, _ and -; at most 63 characters; not starting with a digit or -)"
  [ -n "$password" ] || die 2 "$db: the password for role '$role' is empty (the OOG_*_DB_PASSWORD variable of this tool is not set)"
  case $db in
    postgres|template0|template1) die 2 "'$db' is a system database and cannot be managed" ;;
  esac
  [ "$db" != "${OOG_PG_DB:-}" ] || die 2 "'$db' is the DuckLake database (OOG_PG_DB); every tool needs its own database"
  [ "$role" != "$pg_user" ] || die 2 "'$role' is the Postgres superuser (OOG_PG_USER); every tool needs its own role"

  wait_for_postgres

  log "ensuring role '$role' and database '$db'"
  OOG_TARGET_DB=$db
  OOG_TARGET_ROLE=$role
  OOG_TARGET_PASSWORD=$password
  export OOG_TARGET_DB OOG_TARGET_ROLE OOG_TARGET_PASSWORD
  rc=0
  out=$(apply_sql 2>&1) || rc=$?
  unset OOG_TARGET_DB OOG_TARGET_ROLE OOG_TARGET_PASSWORD
  if [ "$rc" -ne 0 ]; then
    warn "ERROR: could not set up role '$role' and database '$db' (psql exit status $rc)"
    relay warn "$out"
    exit 1
  fi
  relay log "$out"

  rc=0
  out=$(check_login 2>&1) || rc=$?
  if [ "$rc" -ne 0 ]; then
    warn "ERROR: role '$role' cannot log in to database '$db'"
    relay warn "$out"
    exit 1
  fi
  [ "$out" = t ] || die 1 "role '$role' may not create tables in schema public of database '$db' (its public schema belongs to somebody else?)"
  log "database '$db' is ready for role '$role' (login ok, may create tables in schema public)"
}

# One line per tool: ensure_database <database> <role> <password>
ensure_database "${OOG_GITEA_DB:-gitea}" "${OOG_GITEA_DB_USER:-gitea}" "${OOG_GITEA_DB_PASSWORD:-}"

log "done"
